import * as admin from "firebase-admin";
import * as functions from "firebase-functions";
import { defineSecret } from "firebase-functions/params";
import Stripe from "stripe";

admin.initializeApp();
const db = admin.firestore();

const STRIPE_SECRET = defineSecret("STRIPE_SECRET");
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");

const SITE_URL = "https://afterglolighting.org";

// Permanent super-admins. Emails here get admin privileges automatically as
// soon as they sign in with a verified email, without needing the bootstrap
// callable. Compared case-insensitively.
const SUPER_ADMIN_EMAILS: string[] = ["shaneward852@gmail.com"];

function isSuperAdminEmail(email: string | undefined | null): boolean {
  if (!email) return false;
  const e = String(email).toLowerCase();
  return SUPER_ADMIN_EMAILS.some((s) => s.toLowerCase() === e);
}

const ALLOWED_ORIGINS = new Set<string>([
  "https://afterglolighting.org",
  "https://www.afterglolighting.org",
  "https://afterglolighting.github.io",
  "https://afterglo-website-fbb89.web.app",
  "https://afterglo-website-fbb89.firebaseapp.com",
]);

function applyCors(req: functions.https.Request, res: functions.Response): void {
  const origin = (req.headers.origin as string) || "";
  if (ALLOWED_ORIGINS.has(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
  } else {
    res.set("Access-Control-Allow-Origin", SITE_URL);
  }
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// ─── Validation helper ────────────────────────────────────────────────────────
// FIX 1: prevents path-traversal / injection via sequenceId
function isValidId(id: string): boolean {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface PurchaseRecord {
  userId: string;
  sequenceId: string;
  sequenceName: string;
  creator: string;
  price: number;
  purchasedAt: admin.firestore.Timestamp;
  stripeSessionId?: string;
}

interface PurchaseManifestItem {
  id: string;
  name: string;
  creator: string;
}

// ─── GET /purchases ───────────────────────────────────────────────────────────
// Called by firmware: GET https://api.afterglolighting.org/purchases
// Accepts Firebase ID token in Authorization: Bearer header OR ?token= query param.
// FIX 3: token is now verified as a Firebase ID token, not used raw as a UID.
export const purchases = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // FIX 3: accept Bearer header or ?token= as a real Firebase ID token
  const rawToken = (req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : req.query.token as string) ?? "";

  if (!rawToken) {
    res.status(400).json({ error: "Missing token" });
    return;
  }

  let uid: string;
  try {
    const decoded = await admin.auth().verifyIdToken(rawToken);
    uid = decoded.uid;
  } catch {
    res.status(401).json({ error: "Invalid token" });
    return;
  }

  try {
    const snap = await db
      .collection("purchases")
      .where("userId", "==", uid)
      .get();

    const purchaseList: PurchaseManifestItem[] = snap.docs.map((doc) => {
      const data = doc.data() as PurchaseRecord;
      return {
        id: data.sequenceId,
        name: data.sequenceName,
        creator: data.creator,
      };
    });

    res.status(200).json({ purchases: purchaseList });
  } catch (err) {
    functions.logger.error("purchases fetch error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── POST /recordPurchase ─────────────────────────────────────────────────────
// Called by website after Stripe Checkout redirect.
// Requires stripeSessionId — verifies payment with Stripe before recording.
export const recordPurchase = functions
  .runWith({ secrets: ["STRIPE_SECRET"] })
  .https.onRequest(async (req, res) => {
  applyCors(req, res);

  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  const authHeader = req.headers.authorization ?? "";
  if (!authHeader.startsWith("Bearer ")) { res.status(401).json({ error: "Unauthorized" }); return; }

  let uid: string;
  try {
    const decoded = await admin.auth().verifyIdToken(authHeader.slice(7));
    uid = decoded.uid;
  } catch {
    res.status(401).json({ error: "Invalid or expired token" }); return;
  }

  const { sequenceId, stripeSessionId } = req.body as {
    sequenceId: string;
    stripeSessionId: string;
  };

  if (!sequenceId || !stripeSessionId) {
    res.status(400).json({ error: "Missing sequenceId or stripeSessionId" }); return;
  }

  // FIX 1: validate sequenceId
  if (!isValidId(sequenceId)) {
    res.status(400).json({ error: "Invalid sequenceId" }); return;
  }

  try {
    // Verify payment actually happened with Stripe
    const stripe = new Stripe(STRIPE_SECRET.value(), { apiVersion: "2023-10-16" });
    const session = await stripe.checkout.sessions.retrieve(stripeSessionId);

    if (session.payment_status !== "paid") {
      res.status(402).json({ error: "Payment not completed" }); return;
    }
    if (session.metadata?.userId !== uid || session.metadata?.sequenceId !== sequenceId) {
      res.status(403).json({ error: "Session mismatch" }); return;
    }

    const meta = session.metadata!;
    const priceNum = parseFloat(meta.price ?? "0");

    // FIX 6: price validation
    if (typeof priceNum !== "number" || !isFinite(priceNum) || priceNum < 0 || priceNum > 999) {
      res.status(400).json({ error: "Invalid price" }); return;
    }

    // Look up creatorUid from sequences collection (key by UID, not display name)
    const seqDoc = await db.collection("sequences").doc(sequenceId).get();
    const creatorUid = seqDoc.exists ? (seqDoc.data()?.creatorUid ?? meta.creator) : meta.creator;

    // Capture paymentIntentId so Stripe dispute webhooks can match the purchase.
    const paymentIntentId = typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id ?? null;

    // FIX 2: deterministic doc ID for idempotency + atomic transaction
    const purchaseDocRef = db.collection("purchases").doc(`${uid}_${sequenceId}`);
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(purchaseDocRef);
      if (existing.exists) {
        // Backfill paymentIntentId on already-recorded purchases so old rows are disputable.
        if (paymentIntentId && !existing.data()?.paymentIntentId) {
          tx.update(purchaseDocRef, { paymentIntentId });
        }
        return;
      }

      tx.set(purchaseDocRef, {
        userId: uid,
        sequenceId,
        sequenceName: meta.sequenceName,
        creator: meta.creator ?? "Unknown",
        creatorUid: creatorUid ?? null,
        price: priceNum,
        purchasedAt: admin.firestore.Timestamp.now(),
        stripeSessionId,
        paymentIntentId: paymentIntentId ?? null,
        status: "paid",
      });

      const creatorEarningsRef = db.collection("creator_earnings").doc(creatorUid);
      tx.set(creatorEarningsRef,
        { totalEarnings: admin.firestore.FieldValue.increment(Math.round(priceNum * 0.7 * 100) / 100) },
        { merge: true }
      );
    });

    functions.logger.info(`Purchase recorded: ${uid} → ${sequenceId}`);
    res.status(201).json({ status: "recorded" });
  } catch (err) {
    functions.logger.error("recordPurchase error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── POST /uploadSequence ─────────────────────────────────────────────────────
// Called by platform.html upload form.
// Stores metadata in Firestore; the actual FSEQ file goes to Firebase Storage
// (or CDN) separately via a signed upload URL returned from this function.
export const uploadSequence = functions.https.onRequest(async (req, res) => {
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Verify caller
  const authHeader = req.headers.authorization ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const idToken = authHeader.slice(7);
  let uid: string;
  let displayName: string;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    uid = decoded.uid;
    displayName = decoded.name ?? decoded.email ?? "Unknown";
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  const { sequenceId, name, category, durationSecs, channelCount, price, songName, youtubeUrl, hasMp3, flagged } =
    req.body as {
      sequenceId: string;
      name: string;
      category: string;
      durationSecs: number;
      channelCount: number;
      price: number;
      songName?: string;
      youtubeUrl?: string;
      hasMp3?: boolean;
      flagged?: boolean;
    };

  if (!sequenceId || !name) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  // FIX 1: validate sequenceId
  if (!isValidId(sequenceId)) {
    res.status(400).json({ error: "Invalid sequenceId" }); return;
  }

  // Require creator-agreement acceptance before any upload.
  try {
    const userDoc = await db.collection("users").doc(uid).get();
    const accepted = userDoc.exists ? userDoc.data()?.creatorAgreementAcceptedAt : null;
    if (!accepted) {
      res.status(403).json({ error: "Creator agreement not accepted", code: "agreement_required" });
      return;
    }
  } catch (e) {
    functions.logger.warn("uploadSequence agreement check failed", e);
  }

  try {
    const bucket = admin.storage().bucket();
    const fseqPath = `sequences/${sequenceId}.fseq`;

    // Generate a signed URL so the client can PUT the file directly to Storage
    const [signedUrl] = await bucket.file(fseqPath).getSignedUrl({
      version: "v4",
      action: "write",
      expires: Date.now() + 15 * 60 * 1000, // 15 min
      contentType: "application/octet-stream",
    });

    // Generate MP3 signed upload URL if needed
    let mp3UploadUrl: string | undefined;
    if (hasMp3) {
      const [mp3Url] = await bucket.file(`sequences/${sequenceId}.mp3`).getSignedUrl({
        version: "v4",
        action: "write",
        expires: Date.now() + 15 * 60 * 1000,
        contentType: "audio/mpeg",
      });
      mp3UploadUrl = mp3Url;
    }

    // Determine initial status:
    // - Single-song sequences auto-publish unless flagged by content moderation.
    // - Shows and presets always go through manual review.
    const isSequence = (category ?? "").toLowerCase() === "sequence";
    const initialStatus = isSequence && !flagged ? "published" : "pending_review";

    // Record metadata in Firestore (pending until file is uploaded)
    await db.collection("sequences").doc(sequenceId).set({
      id: sequenceId,
      name,
      creator: displayName,
      creatorUid: uid,
      category,
      durationSecs: durationSecs ?? 0,
      channelCount: channelCount ?? 0,
      price: price ?? 0,
      isFree: (price ?? 0) === 0,
      songName: songName ?? "",
      youtubeUrl: youtubeUrl ?? "",
      hasMp3: hasMp3 ?? false,
      flagged: !!flagged,
      status: initialStatus,
      createdAt: admin.firestore.Timestamp.now(),
      downloadCount: 0,
    });

    res.status(200).json({ uploadUrl: signedUrl, sequenceId, ...(mp3UploadUrl ? { mp3UploadUrl } : {}) });
  } catch (err) {
    functions.logger.error("uploadSequence error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /getListings ─────────────────────────────────────────────────────────
// Public endpoint: returns both published sequences AND packs from Firestore.
// Used by the Android app and future website versions as the single source of truth.
// Response: { sequences: [...], packs: [...] }
export const getListings = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const [seqSnap, packSnap] = await Promise.all([
      db
        .collection("sequences")
        .where("status", "==", "published")
        .orderBy("downloadCount", "desc")
        .limit(200)
        .get(),
      db
        .collection("packs")
        .orderBy("createdAt", "desc")
        .limit(50)
        .get(),
    ]);

    const sequences = seqSnap.docs.map((doc) => doc.data());
    const packs     = packSnap.docs.map((doc) => doc.data());

    res.set("Cache-Control", "public, max-age=60, s-maxage=60");
    res.status(200).json({ sequences, packs });
  } catch (err) {
    functions.logger.error("getListings error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /sequences ───────────────────────────────────────────────────────────
// Public endpoint: list published sequences for the store.
export const sequenceList = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const snap = await db
      .collection("sequences")
      .where("status", "==", "published")
      .orderBy("downloadCount", "desc")
      .limit(100)
      .get();

    const sequences = snap.docs.map((doc) => doc.data());
    res.set("Cache-Control", "public, max-age=60, s-maxage=60");
    res.status(200).json({ sequences });
  } catch (err) {
    functions.logger.error("sequenceList error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── POST /createCheckout ─────────────────────────────────────────────────────
// Creates a Stripe Checkout Session for a sequence or pack purchase.
// Body: { sequenceId, sequenceName, creator, price }  (price in dollars)
// Requires Firebase ID token in Authorization header.
export const createCheckout = functions
  .runWith({ secrets: ["STRIPE_SECRET"] })
  .https.onRequest(async (req, res) => {
  applyCors(req, res);

  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST")    { res.status(405).json({ error: "Method not allowed" }); return; }

  const authHeader = req.headers.authorization ?? "";
  if (!authHeader.startsWith("Bearer ")) { res.status(401).json({ error: "Unauthorized" }); return; }

  let uid: string;
  let email: string | undefined;
  try {
    const decoded = await admin.auth().verifyIdToken(authHeader.slice(7));
    uid   = decoded.uid;
    email = decoded.email;
  } catch {
    res.status(401).json({ error: "Invalid token" }); return;
  }

  const { sequenceId, sequenceName, creator, price } = req.body as {
    sequenceId: string;
    sequenceName: string;
    creator: string;
    price: number;
  };

  if (!sequenceId || !sequenceName || price == null) {
    res.status(400).json({ error: "Missing required fields" }); return;
  }

  // FIX 1: validate sequenceId
  if (!isValidId(sequenceId)) {
    res.status(400).json({ error: "Invalid sequenceId" }); return;
  }

  // FIX 6: price validation
  if (typeof price !== "number" || !isFinite(price) || price < 0 || price > 999) {
    res.status(400).json({ error: "Invalid price" }); return;
  }

  const existingSnap = await db.collection("purchases")
    .where("userId", "==", uid)
    .where("sequenceId", "==", sequenceId)
    .limit(1).get();
  if (!existingSnap.empty) {
    res.status(200).json({ status: "already_owned" }); return;
  }

  try {
    const stripe = new Stripe(STRIPE_SECRET.value(), { apiVersion: "2023-10-16" });

    // Look up the creator's Connect account so 70% routes directly to their
    // Express balance. If they haven't onboarded, we keep the legacy flow
    // and flag the sale as unroutable in the ledger for admin reconciliation.
    const seqDoc = await db.collection("sequences").doc(sequenceId).get();
    const creatorUid: string | undefined = seqDoc.exists ? seqDoc.data()?.creatorUid : undefined;
    let creatorStripeAccountId: string | undefined;
    let creatorOnboardingStatus: string | undefined;
    if (creatorUid) {
      const userSnap = await db.collection("users").doc(creatorUid).get();
      if (userSnap.exists) {
        const ud = userSnap.data() || {};
        creatorStripeAccountId = ud.stripeAccountId;
        creatorOnboardingStatus = ud.onboardingStatus;
      }
    }

    const totalCents = Math.round(price * 100);
    const creatorShareCents = Math.floor(totalCents * 0.70);
    const routeToCreator =
      !!creatorStripeAccountId && creatorOnboardingStatus === "complete" && creatorShareCents > 0;

    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode:          "payment",
      customer_email: email,
      line_items: [{
        quantity: 1,
        price_data: {
          currency:     "usd",
          unit_amount:  totalCents,
          product_data: {
            name:        sequenceName,
            description: `By ${creator} . AFTERGLO Light Show`,
          },
        },
      }],
      allow_promotion_codes: true,
      metadata: {
        userId: uid,
        sequenceId,
        sequenceName,
        creator,
        price: String(price),
        creatorUid: creatorUid || "",
        routedToCreator: routeToCreator ? "1" : "0",
      },
      success_url: `${SITE_URL}/platform.html?purchase=success&seq=${sequenceId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${SITE_URL}/platform.html?purchase=cancel`,
    };

    if (routeToCreator) {
      sessionParams.payment_intent_data = {
        transfer_data: {
          destination: creatorStripeAccountId!,
          amount: creatorShareCents,
        },
      };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    res.status(200).json({ url: session.url });
  } catch (err) {
    functions.logger.error("createCheckout error", err);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// ─── POST /stripeWebhook ──────────────────────────────────────────────────────
// Stripe calls this after a successful payment.
// Verifies the signature, then records the purchase in Firestore.
export const stripeWebhook = functions
  .runWith({ secrets: ["STRIPE_SECRET", "STRIPE_WEBHOOK_SECRET"] })
  .https.onRequest(async (req, res) => {
  const sig = req.headers["stripe-signature"] as string;
  const stripe = new Stripe(STRIPE_SECRET.value(), { apiVersion: "2023-10-16" });

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, STRIPE_WEBHOOK_SECRET.value());
  } catch (err) {
    functions.logger.warn("stripeWebhook signature verification failed", err);
    res.status(400).send("Webhook signature invalid");
    return;
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;

    // FIX 4: only process fully paid sessions
    if (session.payment_status !== "paid") {
      functions.logger.info(`Webhook: session ${session.id} not yet paid (${session.payment_status}), skipping`);
      res.status(200).send("OK");
      return;
    }

    const meta = session.metadata ?? {};
    const { userId, sequenceId, sequenceName, creator, price } = meta;
    const routedToCreator = meta.routedToCreator === "1";

    if (!userId || !sequenceId) {
      functions.logger.warn("stripeWebhook: missing metadata", meta);
      res.status(200).send("OK");
      return;
    }

    const priceNum = parseFloat(price ?? "0");
    const earningsShare = Math.round(priceNum * 0.7 * 100) / 100;
    const paymentIntentId = typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id ?? null;

    // Look up creatorUid by UID so renames don't lose earnings
    const seqSnap = await db.collection("sequences").doc(sequenceId).get();
    const creatorUid: string = seqSnap.exists
      ? (seqSnap.data()?.creatorUid ?? meta.creatorUid ?? creator ?? "")
      : (meta.creatorUid ?? creator ?? "");

    // FIX 2: deterministic doc ID + atomic transaction for idempotency
    const purchaseDocRef = db.collection("purchases").doc(`${userId}_${sequenceId}`);
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(purchaseDocRef);
      if (existing.exists) {
        // Backfill paymentIntentId on legacy rows so disputes can match.
        if (paymentIntentId && !existing.data()?.paymentIntentId) {
          tx.update(purchaseDocRef, { paymentIntentId });
        }
        return;
      }

      tx.set(purchaseDocRef, {
        userId,
        sequenceId,
        sequenceName,
        creator:         creator ?? "Unknown",
        creatorUid:      creatorUid || null,
        price:           priceNum,
        purchasedAt:     admin.firestore.Timestamp.now(),
        stripeSessionId: session.id,
        paymentIntentId: paymentIntentId ?? null,
        status:          "paid",
      });

      if (creatorUid) {
        const creatorEarningsRef = db.collection("creator_earnings").doc(creatorUid);
        tx.set(creatorEarningsRef,
          {
            totalEarnings: admin.firestore.FieldValue.increment(earningsShare),
            // Track the portion that has already landed in the creator's
            // Stripe Express balance (or, if unroutable, that still owes them).
            [routedToCreator ? "routedEarnings" : "unroutableEarnings"]:
              admin.firestore.FieldValue.increment(earningsShare),
            updatedAt: admin.firestore.Timestamp.now(),
          },
          { merge: true }
        );

        // Ledger entry for the creator dashboard + admin reconciliation.
        const ledgerRef = creatorEarningsRef.collection("ledger").doc(session.id);
        tx.set(ledgerRef, {
          sequenceId,
          sequenceName: sequenceName ?? "",
          saleAmount:   priceNum,
          earnings:     earningsShare,
          status:       routedToCreator ? "routed" : "unroutable",
          stripeSessionId: session.id,
          createdAt:    admin.firestore.Timestamp.now(),
        }, { merge: true });
      }
    });

    functions.logger.info(`Purchase recorded via webhook: ${userId} -> ${sequenceId} (routed=${routedToCreator})`);
  }

  // Stripe Connect: account.updated -> mirror capability flags into /users/{uid}
  if (event.type === "account.updated") {
    const account = event.data.object as Stripe.Account;
    const userId = (account.metadata && account.metadata.userId) || null;
    if (userId) {
      try {
        const detailsSubmitted = !!account.details_submitted;
        const chargesEnabled   = !!account.charges_enabled;
        const payoutsEnabled   = !!account.payouts_enabled;
        const onboardingStatus =
          (detailsSubmitted && chargesEnabled && payoutsEnabled) ? "complete" :
          detailsSubmitted ? "review" : "pending";
        await db.collection("users").doc(userId).set({
          stripeAccountId:  account.id,
          detailsSubmitted,
          chargesEnabled,
          payoutsEnabled,
          onboardingStatus,
          onboardingUpdatedAt: admin.firestore.Timestamp.now(),
        }, { merge: true });
        functions.logger.info(`account.updated synced: ${userId} -> ${onboardingStatus}`);
      } catch (err) {
        functions.logger.error("account.updated sync failed", err);
      }
    }
  }

  // ─── Dispute: created ──────────────────────────────────────────────────────
  // Customer filed a chargeback. Mark disputed, revoke entitlement, claw back
  // creator share provisionally. A later charge.dispute.closed(won) restores.
  if (event.type === "charge.dispute.created") {
    const dispute = event.data.object as Stripe.Dispute;
    const paymentIntentId = typeof dispute.payment_intent === "string"
      ? dispute.payment_intent
      : dispute.payment_intent?.id ?? null;

    let purchaseDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
    if (paymentIntentId) {
      const snap = await db.collection("purchases")
        .where("paymentIntentId", "==", paymentIntentId)
        .limit(1).get();
      if (!snap.empty) purchaseDoc = snap.docs[0];
    }
    // Fallback: derive PaymentIntent from the charge via the Stripe API.
    if (!purchaseDoc && dispute.charge) {
      try {
        const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge.id;
        const charge = await stripe.charges.retrieve(chargeId);
        const pi = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
        if (pi) {
          const snap = await db.collection("purchases")
            .where("paymentIntentId", "==", pi)
            .limit(1).get();
          if (!snap.empty) purchaseDoc = snap.docs[0];
        }
      } catch (err) {
        functions.logger.warn("dispute: failed to retrieve charge for fallback match", err);
      }
    }

    const purchaseData = purchaseDoc?.data() as (PurchaseRecord & {
      creatorUid?: string; status?: string; paymentIntentId?: string;
    }) | undefined;

    const disputeRef = db.collection("disputes").doc(dispute.id);
    await db.runTransaction(async (tx) => {
      tx.set(disputeRef, {
        id:              dispute.id,
        status:          dispute.status,
        reason:          dispute.reason,
        amount:          dispute.amount,
        currency:        dispute.currency,
        createdAt:       admin.firestore.Timestamp.now(),
        stripeCreated:   dispute.created,
        evidenceDueBy:   dispute.evidence_details?.due_by ?? null,
        paymentIntentId,
        charge:          typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id ?? null,
        purchaseId:      purchaseDoc?.id ?? null,
        userId:          purchaseData?.userId ?? null,
        sequenceId:      purchaseData?.sequenceId ?? null,
        sequenceName:    purchaseData?.sequenceName ?? null,
        creatorUid:      purchaseData?.creatorUid ?? null,
        livemode:        (dispute as any).livemode ?? false,
      }, { merge: true });

      if (purchaseDoc) {
        tx.update(purchaseDoc.ref, {
          status:        "disputed",
          disputedAt:    admin.firestore.Timestamp.now(),
          disputeId:     dispute.id,
          disputeReason: dispute.reason,
        });

        if (purchaseData?.userId) {
          tx.set(db.collection("users").doc(purchaseData.userId), {
            library: admin.firestore.FieldValue.arrayRemove(purchaseData.sequenceId),
          }, { merge: true });
        }

        const pCreatorUid = purchaseData?.creatorUid;
        const pPrice = purchaseData?.price ?? 0;
        if (pCreatorUid && pPrice > 0) {
          const share = Math.round(pPrice * 0.7 * 100) / 100;
          const earningsRef = db.collection("creator_earnings").doc(pCreatorUid);
          tx.set(earningsRef, {
            totalEarnings: admin.firestore.FieldValue.increment(-share),
            updatedAt:     admin.firestore.Timestamp.now(),
          }, { merge: true });
          const ledgerRef = earningsRef.collection("ledger").doc();
          tx.set(ledgerRef, {
            type:       "dispute_provisional",
            amount:     -share,
            purchaseId: purchaseDoc.id,
            disputeId:  dispute.id,
            createdAt:  admin.firestore.Timestamp.now(),
          });
        }
      }

      const auditRef = db.collection("admin_audit").doc();
      tx.set(auditRef, {
        action:    "dispute.created",
        actor:     "stripe_webhook",
        target:    purchaseDoc?.id ?? null,
        disputeId: dispute.id,
        reason:    dispute.reason,
        amount:    dispute.amount,
        createdAt: admin.firestore.Timestamp.now(),
      });
    });

    functions.logger.warn(`Dispute created: ${dispute.id} on purchase ${purchaseDoc?.id ?? "<unmatched>"}`);
  }

  // ─── Dispute: closed ───────────────────────────────────────────────────────
  if (event.type === "charge.dispute.closed") {
    const dispute = event.data.object as Stripe.Dispute;
    const disputeRef = db.collection("disputes").doc(dispute.id);
    const disputeSnap = await disputeRef.get();
    const purchaseId = disputeSnap.data()?.purchaseId as string | undefined;

    await db.runTransaction(async (tx) => {
      tx.set(disputeRef, {
        status:   dispute.status,
        closedAt: admin.firestore.Timestamp.now(),
      }, { merge: true });

      if (!purchaseId) return;
      const purchaseRef = db.collection("purchases").doc(purchaseId);
      const purchaseSnap = await tx.get(purchaseRef);
      if (!purchaseSnap.exists) return;
      const p = purchaseSnap.data() as PurchaseRecord & { creatorUid?: string };

      if (dispute.status === "won") {
        tx.update(purchaseRef, {
          status:       "paid",
          disputeWonAt: admin.firestore.Timestamp.now(),
        });
        if (p.userId && p.sequenceId) {
          tx.set(db.collection("users").doc(p.userId), {
            library: admin.firestore.FieldValue.arrayUnion(p.sequenceId),
          }, { merge: true });
        }
        const pCreatorUid = (p as any).creatorUid as string | undefined;
        const pPrice = p.price ?? 0;
        if (pCreatorUid && pPrice > 0) {
          const share = Math.round(pPrice * 0.7 * 100) / 100;
          const earningsRef = db.collection("creator_earnings").doc(pCreatorUid);
          tx.set(earningsRef, {
            totalEarnings: admin.firestore.FieldValue.increment(share),
            updatedAt:     admin.firestore.Timestamp.now(),
          }, { merge: true });
          const ledgerRef = earningsRef.collection("ledger").doc();
          tx.set(ledgerRef, {
            type:       "dispute_reversed",
            amount:     share,
            purchaseId,
            disputeId:  dispute.id,
            createdAt:  admin.firestore.Timestamp.now(),
          });
        }
      } else {
        tx.update(purchaseRef, {
          status:        "disputed_lost",
          disputeLostAt: admin.firestore.Timestamp.now(),
        });
      }

      const auditRef = db.collection("admin_audit").doc();
      tx.set(auditRef, {
        action:    "dispute.closed",
        actor:     "stripe_webhook",
        target:    purchaseId,
        disputeId: dispute.id,
        outcome:   dispute.status,
        createdAt: admin.firestore.Timestamp.now(),
      });
    });

    functions.logger.warn(`Dispute closed: ${dispute.id} outcome=${dispute.status}`);
  }

  res.status(200).send("OK");
});

// ─── GET /getDownloadUrl ──────────────────────────────────────────────────────
// Returns a 1-hour signed download URL for a purchased (or free) FSEQ sequence.
// Query: ?sequenceId=xxx
// Header: Authorization: Bearer {Firebase ID token}
export const getDownloadUrl = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Verify Firebase ID token
  const authHeader = req.headers.authorization ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const idToken = authHeader.slice(7);
  let uid: string;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  const sequenceId = req.query.sequenceId as string;
  if (!sequenceId || sequenceId.trim().length === 0) {
    res.status(400).json({ error: "Missing sequenceId parameter" });
    return;
  }

  // FIX 1: validate sequenceId
  if (!isValidId(sequenceId)) {
    res.status(400).json({ error: "Invalid sequenceId" }); return;
  }

  try {
    // Check if user has purchased this sequence
    const purchaseSnap = await db
      .collection("purchases")
      .where("userId", "==", uid)
      .where("sequenceId", "==", sequenceId)
      .limit(1)
      .get();

    const hasPurchase = !purchaseSnap.empty;

    if (!hasPurchase) {
      // Check if the sequence is free
      const seqDoc = await db.collection("sequences").doc(sequenceId).get();
      if (!seqDoc.exists) {
        res.status(404).json({ error: "Sequence not found" });
        return;
      }
      const seqData = seqDoc.data() as { isFree?: boolean };
      if (!seqData.isFree) {
        res.status(403).json({ error: "Not purchased" });
        return;
      }
    }

    // Generate a 1-hour signed download URL
    const bucket = admin.storage().bucket();
    const fseqPath = `sequences/${sequenceId}.fseq`;
    const [signedUrl] = await bucket.file(fseqPath).getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + 60 * 60 * 1000, // 1 hour
    });

    // Increment download count (best-effort, non-blocking)
    db.collection("sequences")
      .doc(sequenceId)
      .update({ downloadCount: admin.firestore.FieldValue.increment(1) })
      .catch((err) => functions.logger.warn("downloadCount increment failed", err));

    functions.logger.info(`Download URL issued: ${uid} → ${sequenceId}`);
    res.status(200).json({ url: signedUrl, sequenceId });
  } catch (err) {
    functions.logger.error("getDownloadUrl error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── POST /confirmUpload ──────────────────────────────────────────────────────
// Called by the creator's client after the FSEQ file has been PUT to Storage.
// Body: { sequenceId }
// Header: Authorization: Bearer {Firebase ID token}
// Verifies the caller owns the sequence, then sets status → "published".
export const confirmUpload = functions.https.onRequest(async (req, res) => {
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Verify Firebase ID token
  const authHeader = req.headers.authorization ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const idToken = authHeader.slice(7);
  let uid: string;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  const { sequenceId } = req.body as { sequenceId: string };
  if (!sequenceId) {
    res.status(400).json({ error: "Missing sequenceId" });
    return;
  }

  // FIX 1: validate sequenceId
  if (!isValidId(sequenceId)) {
    res.status(400).json({ error: "Invalid sequenceId" }); return;
  }

  try {
    const seqRef = db.collection("sequences").doc(sequenceId);
    const seqDoc = await seqRef.get();

    if (!seqDoc.exists) {
      res.status(404).json({ error: "Sequence not found" });
      return;
    }

    const seqData = seqDoc.data() as { creatorUid?: string; status?: string };

    // Only the creator may confirm the upload
    if (seqData.creatorUid !== uid) {
      res.status(403).json({ error: "Forbidden: you do not own this sequence" });
      return;
    }

    if (seqData.status !== "pending_upload") {
      // Already published or in another state — treat as idempotent success
      res.status(200).json({ status: seqData.status ?? "published" });
      return;
    }

    // FIX 5: verify the file actually exists in Storage before publishing
    const bucket = admin.storage().bucket();
    const [exists] = await bucket.file(`sequences/${sequenceId}.fseq`).exists();
    if (!exists) {
      res.status(400).json({ error: "File not yet uploaded" }); return;
    }

    await seqRef.update({ status: "published" });

    functions.logger.info(`Sequence published: ${sequenceId} by ${uid}`);
    res.status(200).json({ status: "published" });
  } catch (err) {
    functions.logger.error("confirmUpload error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── ADMIN DASHBOARD CALLABLES ────────────────────────────────────────────────
// Gen 1 HTTPS callables. All require the caller to have a custom claim
// `admin === true` on their Firebase ID token. Every function throws
// HttpsError('permission-denied', ...) if the caller is not an admin.

const OWNER_EMAIL = "shaneward852@gmail.com";

// Re-verifies the caller's ID token with checkRevoked=true so revoked admin
// claims (e.g. just-demoted users) cannot keep calling admin endpoints.
async function requireAdmin(context: functions.https.CallableContext): Promise<string> {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Sign-in required.");
  }
  const rawToken = (context as any).rawRequest?.headers?.authorization?.startsWith?.("Bearer ")
    ? (context as any).rawRequest.headers.authorization.slice(7)
    : ((context as any).instanceIdToken || "");
  if (rawToken) {
    try {
      const decoded = await admin.auth().verifyIdToken(rawToken, true);
      if (decoded.admin === true) {
        return decoded.uid;
      }
      // Super-admin fallback: verify via getUser so the email is authoritative
      // and confirmed as verified, then promote the claim for future calls.
      if (isSuperAdminEmail(decoded.email)) {
        const u = await admin.auth().getUser(decoded.uid);
        if (u.email && isSuperAdminEmail(u.email) && u.emailVerified) {
          const existing = (u.customClaims || {}) as { [k: string]: any };
          if (existing.admin !== true) {
            await admin.auth().setCustomUserClaims(decoded.uid, {
              ...existing,
              admin:   true,
              creator: true,
            });
            functions.logger.info(`requireAdmin: promoted super-admin ${u.email} (${decoded.uid})`);
          }
          return decoded.uid;
        }
      }
      throw new functions.https.HttpsError("permission-denied", "Admin access required.");
    } catch (err) {
      if ((err as any)?.code === "auth/id-token-revoked") {
        throw new functions.https.HttpsError("permission-denied", "Session revoked. Sign in again.");
      }
      if (err instanceof functions.https.HttpsError) throw err;
      // fall through to legacy check if decoding failed for another reason
    }
  }
  if (context.auth.token.admin === true) {
    return context.auth.uid;
  }
  // Super-admin fallback on the legacy path as well.
  const emailFromToken = (context.auth.token.email as string | undefined) || "";
  if (isSuperAdminEmail(emailFromToken)) {
    const u = await admin.auth().getUser(context.auth.uid);
    if (u.email && isSuperAdminEmail(u.email) && u.emailVerified) {
      const existing = (u.customClaims || {}) as { [k: string]: any };
      if (existing.admin !== true) {
        await admin.auth().setCustomUserClaims(context.auth.uid, {
          ...existing,
          admin:   true,
          creator: true,
        });
        functions.logger.info(`requireAdmin: promoted super-admin ${u.email} (${context.auth.uid})`);
      }
      return context.auth.uid;
    }
  }
  throw new functions.https.HttpsError("permission-denied", "Admin access required.");
}

// ensureSuperAdminClaim. Called from admin.html on first load when the caller's
// email is in SUPER_ADMIN_EMAILS but the admin custom claim is not yet on the
// token. Also runs on new-user creation so brand-new super-admins get the claim
// on the very first token mint. No-ops if the caller is not a super-admin.
export const ensureSuperAdminClaim = functions.https.onCall(async (_data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Sign-in required.");
  }
  const uid = context.auth.uid;
  const u   = await admin.auth().getUser(uid);
  if (!u.email || !isSuperAdminEmail(u.email) || !u.emailVerified) {
    return { ok: false, promoted: false };
  }
  const existing = (u.customClaims || {}) as { [k: string]: any };
  if (existing.admin === true) {
    return { ok: true, promoted: false };
  }
  await admin.auth().setCustomUserClaims(uid, {
    ...existing,
    admin:   true,
    creator: true,
  });
  await db.collection("users").doc(uid).set(
    {
      role:      "admin",
      email:     u.email,
      updatedAt: admin.firestore.Timestamp.now(),
    },
    { merge: true }
  );
  functions.logger.info(`ensureSuperAdminClaim: promoted ${u.email} (${uid})`);
  return { ok: true, promoted: true };
});

// onUserCreate. When a new Firebase Auth user is created, if their email is
// a super-admin and already verified, stamp the admin claim immediately so
// their first ID token carries it.
export const ensureSuperAdminOnCreate = functions.auth.user().onCreate(async (user) => {
  try {
    if (!user.email || !isSuperAdminEmail(user.email)) return;
    if (!user.emailVerified) return;
    const existing = (user.customClaims || {}) as { [k: string]: any };
    if (existing.admin === true) return;
    await admin.auth().setCustomUserClaims(user.uid, {
      ...existing,
      admin:   true,
      creator: true,
    });
    await db.collection("users").doc(user.uid).set(
      {
        role:      "admin",
        email:     user.email,
        updatedAt: admin.firestore.Timestamp.now(),
      },
      { merge: true }
    );
    functions.logger.info(`ensureSuperAdminOnCreate: promoted ${user.email} (${user.uid})`);
  } catch (err) {
    functions.logger.error("ensureSuperAdminOnCreate failed", err);
  }
});

// adminSetUserRole(uid, role). role is one of: 'user', 'creator', 'admin'.
// Writes custom claim {admin, creator} and mirrors role into /users/{uid}.
export const adminSetUserRole = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);

  const uid  = data?.uid;
  const role = data?.role;
  if (typeof uid !== "string" || !uid) {
    throw new functions.https.HttpsError("invalid-argument", "uid is required.");
  }
  if (role !== "user" && role !== "creator" && role !== "admin") {
    throw new functions.https.HttpsError("invalid-argument", "role must be user, creator, or admin.");
  }

  const claims = {
    admin:   role === "admin",
    creator: role === "creator" || role === "admin",
  };

  await admin.auth().setCustomUserClaims(uid, claims);
  await db.collection("users").doc(uid).set(
    {
      role,
      updatedAt: admin.firestore.Timestamp.now(),
    },
    { merge: true }
  );

  functions.logger.info(`adminSetUserRole: ${uid} -> ${role}`);
  return { ok: true, uid, role, claims };
});

// adminDisableUser(uid, disabled)
export const adminDisableUser = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);

  const uid      = data?.uid;
  const disabled = data?.disabled;
  if (typeof uid !== "string" || !uid) {
    throw new functions.https.HttpsError("invalid-argument", "uid is required.");
  }
  if (typeof disabled !== "boolean") {
    throw new functions.https.HttpsError("invalid-argument", "disabled must be boolean.");
  }

  await admin.auth().updateUser(uid, { disabled });
  await db.collection("users").doc(uid).set(
    { disabled, updatedAt: admin.firestore.Timestamp.now() },
    { merge: true }
  );

  functions.logger.info(`adminDisableUser: ${uid} disabled=${disabled}`);
  return { ok: true, uid, disabled };
});

// adminSetUploadStatus(uploadId, status). Status is one of: pending, approved, rejected, published, pending_upload.
export const adminSetUploadStatus = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);

  const uploadId = data?.uploadId;
  const status   = data?.status;
  if (typeof uploadId !== "string" || !isValidId(uploadId)) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid uploadId.");
  }
  const allowed = new Set(["pending", "pending_review", "approved", "rejected", "published", "pending_upload"]);
  if (typeof status !== "string" || !allowed.has(status)) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid status.");
  }

  await db.collection("sequences").doc(uploadId).update({
    status,
    moderatedAt: admin.firestore.Timestamp.now(),
  });

  functions.logger.info(`adminSetUploadStatus: ${uploadId} -> ${status}`);
  return { ok: true, uploadId, status };
});

// adminDeleteUpload(uploadId). Deletes the Firestore doc and its Storage file(s).
export const adminDeleteUpload = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);

  const uploadId = data?.uploadId;
  if (typeof uploadId !== "string" || !isValidId(uploadId)) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid uploadId.");
  }

  const bucket = admin.storage().bucket();

  // Best-effort storage deletes (don't fail if the file never existed)
  await Promise.all([
    bucket.file(`sequences/${uploadId}.fseq`).delete({ ignoreNotFound: true } as any).catch(() => null),
    bucket.file(`sequences/${uploadId}.mp3`).delete({ ignoreNotFound: true } as any).catch(() => null),
  ]);

  await db.collection("sequences").doc(uploadId).delete();

  functions.logger.info(`adminDeleteUpload: ${uploadId}`);
  return { ok: true, uploadId };
});

// adminListUsers(pageToken?). Joins Firebase Auth user records with /users/{uid} mirror docs.
export const adminListUsers = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);

  const pageToken = typeof data?.pageToken === "string" ? data.pageToken : undefined;
  const result = await admin.auth().listUsers(1000, pageToken);

  // Fetch mirror docs in parallel (chunked to stay under Firestore batch-get limits)
  const uids = result.users.map((u) => u.uid);
  const docs: Record<string, FirebaseFirestore.DocumentData> = {};
  const CHUNK = 30;
  for (let i = 0; i < uids.length; i += CHUNK) {
    const batch = uids.slice(i, i + CHUNK);
    const snaps = await Promise.all(batch.map((uid) => db.collection("users").doc(uid).get()));
    snaps.forEach((s) => {
      if (s.exists) docs[s.id] = s.data() as FirebaseFirestore.DocumentData;
    });
  }

  const users = result.users.map((u) => {
    const mirror = docs[u.uid] || {};
    const claims = (u.customClaims || {}) as { admin?: boolean; creator?: boolean };
    const role: "admin" | "creator" | "user" =
      claims.admin ? "admin" : claims.creator ? "creator" : (mirror.role as any) || "user";
    return {
      uid:           u.uid,
      email:         u.email || "",
      displayName:   u.displayName || mirror.displayName || "",
      emailVerified: u.emailVerified,
      disabled:      u.disabled,
      createdAt:     u.metadata.creationTime || null,
      lastSignIn:    u.metadata.lastSignInTime || null,
      role,
      photoURL:      u.photoURL || "",
    };
  });

  return { users, nextPageToken: result.pageToken || null };
});

// adminClaimBootstrap(secretKey). One-time bootstrap for the owner only.
// ONLY the hard-coded owner email may call this, and only with the matching
// ADMIN_BOOTSTRAP_SECRET. After the first successful call, rotate the secret.
export const adminClaimBootstrap = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Sign-in required.");
  }
  const email = (context.auth.token.email || "").toLowerCase();
  if (email !== OWNER_EMAIL.toLowerCase()) {
    throw new functions.https.HttpsError("permission-denied", "Only the owner may bootstrap admin.");
  }

  const provided = typeof data?.secretKey === "string" ? data.secretKey : "";
  let expected = "";
  try {
    expected = (functions.config() as any)?.admin?.bootstrap || "";
  } catch {
    expected = "";
  }
  if (!expected) expected = process.env.ADMIN_BOOTSTRAP_SECRET || "";

  if (!expected) {
    throw new functions.https.HttpsError("failed-precondition", "Bootstrap secret is not configured.");
  }
  if (provided !== expected) {
    throw new functions.https.HttpsError("permission-denied", "Invalid bootstrap secret.");
  }

  const uid = context.auth.uid;
  await admin.auth().setCustomUserClaims(uid, { admin: true, creator: true });
  await db.collection("users").doc(uid).set(
    {
      role:      "admin",
      email,
      updatedAt: admin.firestore.Timestamp.now(),
    },
    { merge: true }
  );

  functions.logger.warn(`adminClaimBootstrap: admin claim granted to ${email} (${uid}). Rotate ADMIN_BOOTSTRAP_SECRET now.`);
  return { ok: true, uid, note: "Admin claim granted. Rotate ADMIN_BOOTSTRAP_SECRET now." };
});

// ─── callable: adminRefundPurchase ────────────────────────────────────────────
// Issues a Stripe refund against the PaymentIntent behind a purchase, revokes
// the user's entitlement, claws back the creator's 70% share of the refunded
// amount, writes a ledger entry, and logs to /admin_audit. Partial refunds are
// supported via amountCents (otherwise full refund).
export const adminRefundPurchase = functions
  .runWith({ secrets: ["STRIPE_SECRET"] })
  .https.onCall(async (data, context) => {
    const adminUid = await requireAdmin(context);

    const purchaseId  = data?.purchaseId;
    const reason      = data?.reason;
    const amountCents = data?.amountCents;

    if (typeof purchaseId !== "string" || !purchaseId) {
      throw new functions.https.HttpsError("invalid-argument", "purchaseId is required.");
    }
    const allowedReasons = new Set([
      "customer_request", "duplicate", "fraudulent", "content_issue", "other",
    ]);
    if (typeof reason !== "string" || !allowedReasons.has(reason)) {
      throw new functions.https.HttpsError("invalid-argument", "reason is invalid.");
    }
    if (amountCents != null &&
        (typeof amountCents !== "number" || !isFinite(amountCents) || amountCents <= 0 || amountCents > 99900)) {
      throw new functions.https.HttpsError("invalid-argument", "amountCents is invalid.");
    }

    const purchaseRef = db.collection("purchases").doc(purchaseId);
    const purchaseSnap = await purchaseRef.get();
    if (!purchaseSnap.exists) {
      throw new functions.https.HttpsError("not-found", "Purchase not found.");
    }
    const purchase = purchaseSnap.data() as PurchaseRecord & {
      creatorUid?: string; status?: string; paymentIntentId?: string;
    };
    if (purchase.status === "refunded") {
      throw new functions.https.HttpsError("failed-precondition", "Purchase already refunded.");
    }
    if (!purchase.stripeSessionId) {
      throw new functions.https.HttpsError("failed-precondition", "No Stripe session on this purchase.");
    }

    const stripe = new Stripe(STRIPE_SECRET.value(), { apiVersion: "2023-10-16" });

    // Resolve the PaymentIntent. Prefer the cached paymentIntentId; fall back
    // to retrieving the Checkout Session if the field was never backfilled.
    let paymentIntentId = purchase.paymentIntentId;
    if (!paymentIntentId) {
      const session = await stripe.checkout.sessions.retrieve(purchase.stripeSessionId);
      paymentIntentId = typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id ?? undefined;
      if (paymentIntentId) {
        await purchaseRef.update({ paymentIntentId });
      }
    }
    if (!paymentIntentId) {
      throw new functions.https.HttpsError("failed-precondition", "Could not resolve PaymentIntent.");
    }

    // Map our reason taxonomy onto Stripe's (only a few are accepted).
    const stripeReason: Stripe.RefundCreateParams.Reason | undefined =
      reason === "fraudulent" ? "fraudulent"
      : reason === "duplicate" ? "duplicate"
      : reason === "customer_request" ? "requested_by_customer"
      : undefined;

    let refund: Stripe.Refund;
    try {
      refund = await stripe.refunds.create({
        payment_intent: paymentIntentId,
        ...(amountCents ? { amount: amountCents } : {}),
        ...(stripeReason ? { reason: stripeReason } : {}),
        metadata: { adminUid, purchaseId, reason },
      });
    } catch (err: any) {
      functions.logger.error("Stripe refund failed", err);
      throw new functions.https.HttpsError("internal", `Stripe refund failed: ${err?.message || "unknown"}`);
    }

    const refundedAmountCents   = refund.amount ?? (amountCents ?? Math.round((purchase.price || 0) * 100));
    const refundedAmountDollars = refundedAmountCents / 100;
    const creatorShare          = Math.round(refundedAmountDollars * 0.7 * 100) / 100;

    await db.runTransaction(async (tx) => {
      tx.update(purchaseRef, {
        status:              "refunded",
        refundedAt:          admin.firestore.Timestamp.now(),
        refundedBy:          adminUid,
        refundReason:        reason,
        refundedAmountCents,
        stripeRefundId:      refund.id,
      });

      if (purchase.userId && purchase.sequenceId) {
        tx.set(db.collection("users").doc(purchase.userId), {
          library: admin.firestore.FieldValue.arrayRemove(purchase.sequenceId),
        }, { merge: true });
        // Revoke any outstanding download token for this sequence.
        tx.set(
          db.collection("users").doc(purchase.userId)
            .collection("download_tokens").doc(purchase.sequenceId),
          {
            revokedAt: admin.firestore.Timestamp.now(),
            revokedBy: adminUid,
            reason:    "refund",
          },
          { merge: true }
        );
      }

      const creatorUid = purchase.creatorUid;
      if (creatorUid && creatorShare > 0) {
        const earningsRef = db.collection("creator_earnings").doc(creatorUid);
        tx.set(earningsRef, {
          totalEarnings: admin.firestore.FieldValue.increment(-creatorShare),
          updatedAt:     admin.firestore.Timestamp.now(),
        }, { merge: true });
        const ledgerRef = earningsRef.collection("ledger").doc();
        tx.set(ledgerRef, {
          type:       "refund",
          amount:     -creatorShare,
          purchaseId,
          refundId:   refund.id,
          reason,
          createdAt:  admin.firestore.Timestamp.now(),
        });
      }

      const auditRef = db.collection("admin_audit").doc();
      tx.set(auditRef, {
        action:         "refund",
        actor:          adminUid,
        target:         purchaseId,
        reason,
        stripeRefundId: refund.id,
        amountCents:    refundedAmountCents,
        createdAt:      admin.firestore.Timestamp.now(),
      });
    });

    functions.logger.info(`adminRefundPurchase: ${purchaseId} refund=${refund.id} by ${adminUid}`);
    return { status: refund.status, stripeRefundId: refund.id };
  });


// ─── STRIPE CONNECT (Express) ─────────────────────────────────────────────────
// Creator payouts via Stripe Connect Express accounts. Stripe hosts the W-9,
// bank, and tax-info flow on their side; we just persist the account id and
// mirror the capability flags so the creator dashboard knows onboarding state.

function requireAuth(context: functions.https.CallableContext): { uid: string; email?: string } {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Sign-in required.");
  }
  return { uid: context.auth.uid, email: context.auth.token.email as string | undefined };
}

async function writeAdminAudit(action: string, actorUid: string, payload: Record<string, unknown>) {
  try {
    await db.collection("admin_audit").add({
      action,
      actorUid,
      payload,
      createdAt: admin.firestore.Timestamp.now(),
    });
  } catch (err) {
    functions.logger.warn("admin_audit write failed", err);
  }
}

function mirrorAccountFlags(account: Stripe.Account) {
  const detailsSubmitted = !!account.details_submitted;
  const chargesEnabled   = !!account.charges_enabled;
  const payoutsEnabled   = !!account.payouts_enabled;
  const onboardingStatus =
    (detailsSubmitted && chargesEnabled && payoutsEnabled) ? "complete" :
    detailsSubmitted ? "review" : "pending";
  return { detailsSubmitted, chargesEnabled, payoutsEnabled, onboardingStatus };
}

// createConnectAccount(): creates a Stripe Connect Express account if the
// caller doesn't already have one, then stores the id on /users/{uid}.
export const createConnectAccount = functions
  .runWith({ secrets: ["STRIPE_SECRET"] })
  .https.onCall(async (_data, context) => {
    const { uid, email } = requireAuth(context);
    const stripe = new Stripe(STRIPE_SECRET.value(), { apiVersion: "2023-10-16" });

    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    const userData = userSnap.exists ? userSnap.data() || {} : {};

    if (userData.stripeAccountId) {
      return { ok: true, stripeAccountId: userData.stripeAccountId, existing: true };
    }

    const account = await stripe.accounts.create({
      type: "express",
      country: "US",
      email,
      capabilities: { transfers: { requested: true } },
      business_type: "individual",
      metadata: { userId: uid },
    });

    await userRef.set({
      stripeAccountId:  account.id,
      onboardingStatus: "pending",
      detailsSubmitted: false,
      chargesEnabled:   false,
      payoutsEnabled:   false,
      onboardingUpdatedAt: admin.firestore.Timestamp.now(),
    }, { merge: true });

    functions.logger.info(`createConnectAccount: ${uid} -> ${account.id}`);
    return { ok: true, stripeAccountId: account.id, existing: false };
  });

// createConnectOnboardingLink({ mode: 'onboarding' | 'update' })
export const createConnectOnboardingLink = functions
  .runWith({ secrets: ["STRIPE_SECRET"] })
  .https.onCall(async (data, context) => {
    const { uid } = requireAuth(context);
    const stripe = new Stripe(STRIPE_SECRET.value(), { apiVersion: "2023-10-16" });

    const mode = data?.mode === "update" ? "account_update" : "account_onboarding";

    const userSnap = await db.collection("users").doc(uid).get();
    const stripeAccountId: string | undefined = userSnap.data()?.stripeAccountId;
    if (!stripeAccountId) {
      throw new functions.https.HttpsError("failed-precondition", "No Connect account. Call createConnectAccount first.");
    }

    const link = await stripe.accountLinks.create({
      account:     stripeAccountId,
      refresh_url: `${SITE_URL}/creator-dashboard.html?connect=refresh`,
      return_url:  `${SITE_URL}/creator-dashboard.html?connect=return`,
      type:        mode,
    });

    return { ok: true, url: link.url, expiresAt: link.expires_at };
  });

// checkConnectStatus(): re-reads the account from Stripe and mirrors flags.
export const checkConnectStatus = functions
  .runWith({ secrets: ["STRIPE_SECRET"] })
  .https.onCall(async (_data, context) => {
    const { uid } = requireAuth(context);
    const stripe = new Stripe(STRIPE_SECRET.value(), { apiVersion: "2023-10-16" });

    const userRef  = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    const stripeAccountId: string | undefined = userSnap.data()?.stripeAccountId;
    if (!stripeAccountId) {
      return { ok: true, hasAccount: false };
    }

    const account = await stripe.accounts.retrieve(stripeAccountId);
    const flags = mirrorAccountFlags(account);

    await userRef.set({
      ...flags,
      stripeAccountId,
      onboardingUpdatedAt: admin.firestore.Timestamp.now(),
    }, { merge: true });

    // Best-effort next-payout hint
    let nextPayoutDate: number | null = null;
    try {
      const payouts = await stripe.payouts.list(
        { limit: 1, status: "pending" } as Stripe.PayoutListParams,
        { stripeAccount: stripeAccountId }
      );
      if (payouts.data.length) {
        nextPayoutDate = payouts.data[0].arrival_date;
      }
    } catch (err) {
      functions.logger.info("payouts.list skipped", err);
    }

    return {
      ok: true,
      hasAccount: true,
      stripeAccountId,
      ...flags,
      nextPayoutDate,
    };
  });

// adminListCreatorsPayoutStatus(): admin-only view of creator payout flags.
export const adminListCreatorsPayoutStatus = functions.https.onCall(async (_data, context) => {
  const actor = await requireAdmin(context);

  const snap = await db.collection("users").get();
  const rows = snap.docs.map((d) => {
    const u = d.data() || {};
    return {
      uid: d.id,
      email: u.email || "",
      role:  u.role  || "user",
      stripeAccountId:  u.stripeAccountId  || null,
      onboardingStatus: u.onboardingStatus || null,
      payoutsEnabled:   !!u.payoutsEnabled,
      chargesEnabled:   !!u.chargesEnabled,
      detailsSubmitted: !!u.detailsSubmitted,
    };
  });

  await writeAdminAudit("listCreatorsPayoutStatus", actor, { count: rows.length });
  return { creators: rows };
});

// ─── DMCA / GDPR / CCPA / AUDIT ───────────────────────────────────────────────
// Constants
const DMCA_AGENT_EMAIL = "dmca@afterglolighting.org";
const CREATOR_AGREEMENT_VERSION = "2026-04-21";
const DATA_DELETION_GRACE_DAYS = 30;

// Writes a canonical audit record. `before`/`after` are optional snapshots.
async function writeAudit(entry: {
  actor: string;
  action: string;
  target?: string | null;
  targetCollection?: string | null;
  reason?: string | null;
  tosClause?: string | null;
  before?: unknown;
  after?: unknown;
  actorIp?: string | null;
  extra?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.collection("admin_audit").add({
      actor:            entry.actor,
      action:           entry.action,
      target:           entry.target ?? null,
      targetCollection: entry.targetCollection ?? null,
      reason:           entry.reason ?? null,
      tosClause:        entry.tosClause ?? null,
      before:           entry.before ?? null,
      after:            entry.after ?? null,
      actorIp:          entry.actorIp ?? null,
      extra:            entry.extra ?? null,
      createdAt:        admin.firestore.Timestamp.now(),
    });
  } catch (err) {
    functions.logger.error("writeAudit failed", err);
  }
}

function clientIp(req: functions.https.Request): string | null {
  const fwd = (req.headers["x-forwarded-for"] as string) || "";
  if (fwd) return fwd.split(",")[0].trim();
  return (req.ip as any) || (req.socket && (req.socket as any).remoteAddress) || null;
}

// ─── submitDmcaNotice (public HTTP) ───────────────────────────────────────────
// Anyone may submit a DMCA takedown notice or counter-notice.
// Writes /dmca_notices/{autoId} with status 'pending'.
export const submitDmcaNotice = functions.https.onRequest(async (req, res) => {
  // Public endpoint. Allow any origin; this is a legal notice submission.
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  const body = (req.body || {}) as Record<string, any>;
  const type = body.type === "counter" ? "counter" : "takedown";

  const str = (k: string, max: number) => {
    const v = body[k];
    if (typeof v !== "string") return "";
    return v.trim().slice(0, max);
  };

  const claimantName    = str("claimantName", 160);
  const claimantEmail   = str("claimantEmail", 200);
  const claimantPhone   = str("claimantPhone", 60);
  const claimantAddress = str("claimantAddress", 400);
  const workDescription = str("workDescription", 2000);
  const infringingUrl   = str("infringingUrl", 500);
  const signature       = str("signature", 160);
  const claimantRole    = type === "takedown" ? str("claimantRole", 40) : "";
  const additional      = str("additional", 2000);
  const originalNoticeId= str("originalNoticeId", 120);

  const missing: string[] = [];
  if (!claimantName) missing.push("claimantName");
  if (!claimantEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claimantEmail)) missing.push("claimantEmail");
  if (!claimantPhone) missing.push("claimantPhone");
  if (!claimantAddress) missing.push("claimantAddress");
  if (!workDescription) missing.push("workDescription");
  if (!infringingUrl) missing.push("infringingUrl");
  if (!signature) missing.push("signature");
  if (!body.attGoodFaith) missing.push("attGoodFaith");
  if (!body.attAccuracy) missing.push("attAccuracy");
  if (!body.attConsent) missing.push("attConsent");
  if (type === "counter" && !body.attJurisdiction) missing.push("attJurisdiction");
  if (missing.length) {
    res.status(400).json({ error: "Missing or invalid fields", fields: missing });
    return;
  }

  try {
    const notice = {
      type,
      status:           "pending" as const,
      claimantName,
      claimantEmail,
      claimantPhone,
      claimantAddress,
      claimantRole,
      workDescription,
      infringingUrl,
      additional,
      originalNoticeId: originalNoticeId || null,
      signature,
      attestations: {
        goodFaith:    !!body.attGoodFaith,
        accuracy:     !!body.attAccuracy,
        consent:      !!body.attConsent,
        jurisdiction: !!body.attJurisdiction,
      },
      submittedAt:   admin.firestore.Timestamp.now(),
      submitterIp:   clientIp(req),
      userAgent:     (req.headers["user-agent"] as string) || null,
    };
    const docRef = await db.collection("dmca_notices").add(notice);
    await writeAudit({
      actor:            "public",
      action:           type === "counter" ? "dmca.counter_notice_submitted" : "dmca.notice_submitted",
      target:           docRef.id,
      targetCollection: "dmca_notices",
      reason:           type + " from " + claimantEmail,
      actorIp:          clientIp(req),
    });
    functions.logger.info("DMCA " + type + " received: " + docRef.id + " from " + claimantEmail);
    res.status(201).json({ ok: true, noticeId: docRef.id, agent: DMCA_AGENT_EMAIL });
  } catch (err) {
    functions.logger.error("submitDmcaNotice error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── adminDmcaAction (admin callable) ─────────────────────────────────────────
// actions: 'takedown', 'reject', 'forward_to_creator', 'restore', 'close'
export const adminDmcaAction = functions.https.onCall(async (data, context) => {
  const adminUid = await requireAdmin(context);
  const noticeId = data?.noticeId;
  const action   = data?.action;
  const reason   = typeof data?.reason === "string" ? data.reason.slice(0, 1000) : "";
  const tosClause = typeof data?.tosClause === "string" ? data.tosClause.slice(0, 120) : "";
  const sequenceIdOverride = typeof data?.sequenceId === "string" ? data.sequenceId : "";

  if (typeof noticeId !== "string" || !isValidId(noticeId)) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid noticeId.");
  }
  const validActions = new Set(["takedown", "reject", "forward_to_creator", "restore", "close"]);
  if (!validActions.has(action)) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid action.");
  }

  const noticeRef = db.collection("dmca_notices").doc(noticeId);
  const noticeSnap = await noticeRef.get();
  if (!noticeSnap.exists) {
    throw new functions.https.HttpsError("not-found", "Notice not found.");
  }
  const notice = noticeSnap.data() as any;
  const before = { ...notice };

  // Resolve sequenceId from the infringingUrl if possible (admin may override).
  let sequenceId = sequenceIdOverride;
  if (!sequenceId && typeof notice.infringingUrl === "string") {
    const m = notice.infringingUrl.match(/([a-zA-Z0-9_-]{6,128})/);
    if (m) sequenceId = m[1];
  }

  if (action === "takedown") {
    if (!sequenceId || !isValidId(sequenceId)) {
      throw new functions.https.HttpsError("failed-precondition", "Could not resolve sequenceId. Pass sequenceId explicitly.");
    }
    const seqRef = db.collection("sequences").doc(sequenceId);
    const seqSnap = await seqRef.get();
    if (!seqSnap.exists) {
      throw new functions.https.HttpsError("not-found", "Sequence not found.");
    }
    const seqBefore = seqSnap.data() as any;

    await db.runTransaction(async (tx) => {
      tx.update(seqRef, {
        status:             "taken_down",
        takedownReason:     reason || "DMCA takedown",
        takedownNoticeId:   noticeId,
        takedownAt:         admin.firestore.Timestamp.now(),
        takedownActor:      adminUid,
      });
      tx.update(noticeRef, {
        status:           "valid",
        takedownActor:    adminUid,
        takedownAt:       admin.firestore.Timestamp.now(),
        affectedSequence: sequenceId,
        adminReason:      reason || null,
        tosClause:        tosClause || null,
      });
    });

    // Revoke buyer entitlements: mark purchases as revoked (keep record for accounting).
    const purchaseSnap = await db.collection("purchases")
      .where("sequenceId", "==", sequenceId).get();
    const batch = db.batch();
    purchaseSnap.docs.forEach((p) => {
      batch.update(p.ref, {
        status:     "revoked",
        revokedAt:  admin.firestore.Timestamp.now(),
        revokedBy:  adminUid,
        revokedReason: "DMCA takedown",
      });
    });
    await batch.commit();

    // Reverse creator earnings on affected sales.
    const creatorUid = seqBefore?.creatorUid;
    if (creatorUid) {
      let reversal = 0;
      purchaseSnap.docs.forEach((p) => {
        const price = parseFloat(String(p.data()?.price ?? "0")) || 0;
        reversal += Math.round(price * 0.7 * 100) / 100;
      });
      if (reversal > 0) {
        await db.collection("creator_earnings").doc(creatorUid).set({
          totalEarnings: admin.firestore.FieldValue.increment(-reversal),
          updatedAt:     admin.firestore.Timestamp.now(),
        }, { merge: true });
        await db.collection("creator_earnings").doc(creatorUid).collection("ledger").add({
          type:       "dmca_reversal",
          amount:     -reversal,
          noticeId,
          sequenceId,
          createdAt:  admin.firestore.Timestamp.now(),
        });
      }
    }

    await writeAudit({
      actor: adminUid,
      action: "dmca.takedown",
      target: sequenceId,
      targetCollection: "sequences",
      reason: reason || "DMCA takedown",
      tosClause: tosClause || null,
      before: { sequence: seqBefore, notice: before },
      after:  { sequenceStatus: "taken_down", noticeStatus: "valid" },
      extra:  { noticeId, purchasesRevoked: purchaseSnap.size },
    });

    return { ok: true, sequenceId, purchasesRevoked: purchaseSnap.size };
  }

  if (action === "reject") {
    await noticeRef.update({
      status:      "invalid",
      adminReason: reason || null,
      resolvedAt:  admin.firestore.Timestamp.now(),
      resolvedBy:  adminUid,
    });
    await writeAudit({
      actor: adminUid, action: "dmca.reject", target: noticeId,
      targetCollection: "dmca_notices",
      reason: reason || "Rejected as invalid", tosClause: tosClause || null,
      before, after: { status: "invalid" },
    });
    return { ok: true };
  }

  if (action === "forward_to_creator") {
    const counterWindowEnds = admin.firestore.Timestamp.fromMillis(
      Date.now() + 14 * 24 * 60 * 60 * 1000
    );
    await noticeRef.update({
      status:              "forwarded",
      forwardedAt:         admin.firestore.Timestamp.now(),
      forwardedBy:         adminUid,
      counterWindowEnds,
      affectedSequence:    sequenceId || null,
    });
    await writeAudit({
      actor: adminUid, action: "dmca.forward_to_creator", target: noticeId,
      targetCollection: "dmca_notices", reason, before, after: { status: "forwarded" },
    });
    return { ok: true, counterWindowEnds: counterWindowEnds.toMillis() };
  }

  if (action === "restore") {
    if (!sequenceId) {
      throw new functions.https.HttpsError("failed-precondition", "sequenceId required.");
    }
    const seqRef = db.collection("sequences").doc(sequenceId);
    await seqRef.update({
      status:     "published",
      restoredAt: admin.firestore.Timestamp.now(),
      restoredBy: adminUid,
    });
    await noticeRef.update({
      status:     "counter_noticed",
      resolvedAt: admin.firestore.Timestamp.now(),
      resolvedBy: adminUid,
    });
    await writeAudit({
      actor: adminUid, action: "dmca.restore", target: sequenceId,
      targetCollection: "sequences", reason, before, after: { status: "published" },
    });
    return { ok: true };
  }

  if (action === "close") {
    await noticeRef.update({
      status:     "closed",
      resolvedAt: admin.firestore.Timestamp.now(),
      resolvedBy: adminUid,
      adminReason: reason || null,
    });
    await writeAudit({
      actor: adminUid, action: "dmca.close", target: noticeId,
      targetCollection: "dmca_notices", reason, before, after: { status: "closed" },
    });
    return { ok: true };
  }

  return { ok: false };
});

// ─── userAcceptCreatorAgreement (callable) ────────────────────────────────────
export const userAcceptCreatorAgreement = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Sign-in required.");
  }
  const uid = context.auth.uid;
  const version = typeof data?.version === "string" ? data.version : CREATOR_AGREEMENT_VERSION;

  await db.collection("users").doc(uid).set({
    creatorAgreementAcceptedAt: admin.firestore.Timestamp.now(),
    creatorAgreementVersion:    version,
    email:                      context.auth.token.email || null,
    updatedAt:                  admin.firestore.Timestamp.now(),
  }, { merge: true });

  await writeAudit({
    actor: uid,
    action: "creator_agreement.accepted",
    target: uid,
    targetCollection: "users",
    extra: { version },
  });

  return { ok: true, version, acceptedAt: Date.now() };
});

// ─── userRequestDataExport (callable) ─────────────────────────────────────────
// Compiles all personal data for the caller into a JSON blob uploaded to
// Cloud Storage at user-exports/{uid}/{ts}.json and returns a 7-day signed URL.
export const userRequestDataExport = functions.https.onCall(async (_data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Sign-in required.");
  }
  const uid = context.auth.uid;
  const email = (context.auth.token.email || "").toLowerCase();

  try {
    const [authUser, userDoc, purchaseSnap, sequenceSnap, earningsDoc, dmcaSnap] = await Promise.all([
      admin.auth().getUser(uid).catch(() => null),
      db.collection("users").doc(uid).get(),
      db.collection("purchases").where("userId", "==", uid).get(),
      db.collection("sequences").where("creatorUid", "==", uid).get(),
      db.collection("creator_earnings").doc(uid).get(),
      email
        ? db.collection("dmca_notices").where("claimantEmail", "==", email).get()
        : Promise.resolve({ docs: [] } as any),
    ]);

    const ledgerSnap = earningsDoc.exists
      ? await db.collection("creator_earnings").doc(uid).collection("ledger").get()
      : ({ docs: [] } as any);

    const blob = {
      generatedAt: new Date().toISOString(),
      uid,
      email,
      authRecord: authUser ? {
        uid:            authUser.uid,
        email:          authUser.email,
        emailVerified:  authUser.emailVerified,
        displayName:    authUser.displayName,
        photoURL:       authUser.photoURL,
        disabled:       authUser.disabled,
        createdAt:      authUser.metadata.creationTime,
        lastSignInAt:   authUser.metadata.lastSignInTime,
        providers:      (authUser.providerData || []).map((p) => ({ providerId: p.providerId, email: p.email })),
        customClaims:   authUser.customClaims || null,
      } : null,
      profile:     userDoc.exists ? userDoc.data() : null,
      purchases:   purchaseSnap.docs.map((d: any) => Object.assign({ id: d.id }, d.data())),
      sequences:   sequenceSnap.docs.map((d: any) => Object.assign({ id: d.id }, d.data())),
      earnings:    earningsDoc.exists ? earningsDoc.data() : null,
      earningsLedger: ledgerSnap.docs.map((d: any) => Object.assign({ id: d.id }, d.data())),
      dmcaNotices: dmcaSnap.docs.map((d: any) => Object.assign({ id: d.id }, d.data())),
    };

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const storagePath = "user-exports/" + uid + "/" + ts + ".json";
    const bucket = admin.storage().bucket();
    await bucket.file(storagePath).save(JSON.stringify(blob, null, 2), {
      contentType: "application/json",
      metadata: { metadata: { uid, generatedAt: blob.generatedAt } },
    });
    const [signedUrl] = await bucket.file(storagePath).getSignedUrl({
      version: "v4",
      action:  "read",
      expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });

    const reqRef = await db.collection("data_requests").add({
      uid,
      type:        "export",
      status:      "completed",
      storagePath,
      createdAt:   admin.firestore.Timestamp.now(),
      completedAt: admin.firestore.Timestamp.now(),
    });

    await writeAudit({
      actor: uid,
      action: "gdpr.export",
      target: reqRef.id,
      targetCollection: "data_requests",
      extra: { storagePath, counts: {
        purchases: blob.purchases.length,
        sequences: blob.sequences.length,
        dmcaNotices: blob.dmcaNotices.length,
      }},
    });

    return { ok: true, url: signedUrl, requestId: reqRef.id, expiresInDays: 7 };
  } catch (err) {
    functions.logger.error("userRequestDataExport error", err);
    throw new functions.https.HttpsError("internal", "Export failed.");
  }
});

// ─── userRequestDataDeletion (callable) ───────────────────────────────────────
// Marks the user for deletion with a 30-day grace period.
export const userRequestDataDeletion = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Sign-in required.");
  }
  const uid = context.auth.uid;
  const confirm = typeof data?.confirmText === "string" ? data.confirmText.trim().toLowerCase() : "";
  if (confirm !== "delete my account") {
    throw new functions.https.HttpsError("invalid-argument", 'Type "delete my account" to confirm.');
  }

  const scheduledFor = admin.firestore.Timestamp.fromMillis(
    Date.now() + DATA_DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000
  );

  await db.collection("users").doc(uid).set({
    deletionRequestedAt: admin.firestore.Timestamp.now(),
    deletionScheduledFor: scheduledFor,
    updatedAt:           admin.firestore.Timestamp.now(),
  }, { merge: true });

  const reqRef = await db.collection("data_requests").add({
    uid,
    type:         "delete",
    status:       "pending",
    requestedAt:  admin.firestore.Timestamp.now(),
    scheduledFor,
    createdAt:    admin.firestore.Timestamp.now(),
    initiatedBy:  "user",
  });

  await writeAudit({
    actor: uid,
    action: "gdpr.deletion_requested",
    target: reqRef.id,
    targetCollection: "data_requests",
    extra: { scheduledFor: scheduledFor.toMillis() },
  });

  return { ok: true, requestId: reqRef.id, scheduledFor: scheduledFor.toMillis(), graceDays: DATA_DELETION_GRACE_DAYS };
});

// ─── userCancelDeletion (callable) ────────────────────────────────────────────
export const userCancelDeletion = functions.https.onCall(async (_data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Sign-in required.");
  const uid = context.auth.uid;

  const snap = await db.collection("data_requests")
    .where("uid", "==", uid).where("type", "==", "delete").where("status", "==", "pending").get();

  const batch = db.batch();
  snap.docs.forEach((d) => batch.update(d.ref, {
    status: "cancelled",
    cancelledAt: admin.firestore.Timestamp.now(),
  }));
  batch.update(db.collection("users").doc(uid), {
    deletionRequestedAt: admin.firestore.FieldValue.delete(),
    deletionScheduledFor: admin.firestore.FieldValue.delete(),
    updatedAt: admin.firestore.Timestamp.now(),
  });
  await batch.commit();

  await writeAudit({
    actor: uid, action: "gdpr.deletion_cancelled", target: uid, targetCollection: "users",
  });
  return { ok: true, cancelled: snap.size };
});

// ─── adminRequestUserDeletion (callable) ──────────────────────────────────────
export const adminRequestUserDeletion = functions.https.onCall(async (data, context) => {
  const adminUid = await requireAdmin(context);
  const uid = data?.uid;
  const reason = typeof data?.reason === "string" ? data.reason.slice(0, 1000) : "";
  if (typeof uid !== "string" || !uid) {
    throw new functions.https.HttpsError("invalid-argument", "uid is required.");
  }
  const scheduledFor = admin.firestore.Timestamp.fromMillis(
    Date.now() + DATA_DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000
  );
  await db.collection("users").doc(uid).set({
    deletionRequestedAt:   admin.firestore.Timestamp.now(),
    deletionScheduledFor:  scheduledFor,
    deletionInitiatedBy:   adminUid,
    deletionReason:        reason || null,
    updatedAt:             admin.firestore.Timestamp.now(),
  }, { merge: true });
  const reqRef = await db.collection("data_requests").add({
    uid,
    type:         "delete",
    status:       "pending",
    requestedAt:  admin.firestore.Timestamp.now(),
    scheduledFor,
    createdAt:    admin.firestore.Timestamp.now(),
    initiatedBy:  "admin",
    adminActor:   adminUid,
    reason:       reason || null,
  });
  await writeAudit({
    actor: adminUid, action: "gdpr.admin_deletion_requested", target: uid,
    targetCollection: "users", reason, extra: { requestId: reqRef.id, scheduledFor: scheduledFor.toMillis() },
  });
  return { ok: true, requestId: reqRef.id, scheduledFor: scheduledFor.toMillis() };
});

// ─── processPendingDeletions (scheduled) ──────────────────────────────────────
// Runs nightly, processes any data_requests where scheduledFor <= now and status=pending.
export const processPendingDeletions = functions.pubsub
  .schedule("every day 03:00")
  .timeZone("America/Denver")
  .onRun(async () => {
    const now = admin.firestore.Timestamp.now();
    const snap = await db.collection("data_requests")
      .where("type", "==", "delete")
      .where("status", "==", "pending")
      .where("scheduledFor", "<=", now)
      .get();

    for (const doc of snap.docs) {
      const req = doc.data();
      const uid = req.uid as string;
      try {
        await doc.ref.update({ status: "processing", processingStartedAt: now });

        // Delete Firebase Auth user.
        try { await admin.auth().deleteUser(uid); }
        catch (e) { functions.logger.warn("deleteUser(" + uid + ") failed (already gone?)", e); }

        // Anonymize purchases (keep for tax/accounting).
        const purchases = await db.collection("purchases").where("userId", "==", uid).get();
        const pb = db.batch();
        purchases.docs.forEach((p) => pb.update(p.ref, {
          userId:        "DELETED-USER",
          anonymizedAt:  admin.firestore.Timestamp.now(),
        }));
        await pb.commit();

        // Handle creator-uploaded sequences.
        const seqs = await db.collection("sequences").where("creatorUid", "==", uid).get();
        const bucket = admin.storage().bucket();
        for (const s of seqs.docs) {
          const seqId = s.id;
          const hasBuyers = await db.collection("purchases")
            .where("sequenceId", "==", seqId).limit(1).get();
          if (hasBuyers.empty) {
            // Delete files + doc entirely.
            await Promise.all([
              bucket.file("sequences/" + seqId + ".fseq").delete({ ignoreNotFound: true } as any).catch(() => null),
              bucket.file("sequences/" + seqId + ".mp3").delete({ ignoreNotFound: true } as any).catch(() => null),
            ]);
            await s.ref.delete();
          } else {
            // Transfer to AFTERGLO Archive, flag for refund option.
            await s.ref.update({
              creatorUid:      "AFTERGLO_ARCHIVE",
              creator:         "AFTERGLO Archive",
              transferredAt:   admin.firestore.Timestamp.now(),
              transferReason:  "creator_deletion",
              refundEligible:  true,
            });
          }
        }

        // Delete user doc last.
        await db.collection("users").doc(uid).delete();

        await doc.ref.update({
          status:      "completed",
          completedAt: admin.firestore.Timestamp.now(),
        });
        await writeAudit({
          actor: "system",
          action: "gdpr.deletion_processed",
          target: uid,
          targetCollection: "users",
          extra: { requestId: doc.id, sequencesCount: seqs.size, purchasesAnonymized: purchases.size },
        });
        functions.logger.info("processPendingDeletions: completed " + uid);
      } catch (err) {
        functions.logger.error("processPendingDeletions failed for " + uid, err);
        await doc.ref.update({
          status: "failed",
          failedAt: admin.firestore.Timestamp.now(),
          error: String((err as any)?.message || err),
        });
      }
    }
    return null;
  });

// ─── Feedback ────────────────────────────────────────────────────────────────
// submitFeedback: callable. Auth is OPTIONAL. Suite (and other clients) post a
// short message plus optional category, log tail, app version, and OS string.
// We validate length, strip absurd sizes, and stamp uid/email only when the
// caller is signed in. Writes live in /feedback. Direct client writes are
// blocked by firestore.rules; this callable is the only way in.
const FEEDBACK_CATEGORIES = new Set(["bug", "idea", "other"]);

export const submitFeedback = functions.https.onCall(async (data, context) => {
  const raw = (data && typeof data.message === "string") ? data.message : "";
  const message = raw.trim();
  if (message.length < 3 || message.length > 5000) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Message must be between 3 and 5000 characters."
    );
  }

  let category: string = "other";
  if (typeof data?.category === "string" && FEEDBACK_CATEGORIES.has(data.category)) {
    category = data.category;
  }

  // Cap log tail and version/os so a misbehaving client cannot bloat the doc.
  const logTail    = typeof data?.logTail    === "string" ? data.logTail.slice(0, 20000) : null;
  const appVersion = typeof data?.appVersion === "string" ? data.appVersion.slice(0, 64)  : null;
  const os         = typeof data?.os         === "string" ? data.os.slice(0, 128)         : null;

  const doc: Record<string, unknown> = {
    message,
    category,
    logTail,
    appVersion,
    os,
    status: "new",
    reply: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (context.auth) {
    doc.uid   = context.auth.uid;
    doc.email = context.auth.token?.email || null;
  } else {
    doc.uid   = null;
    doc.email = null;
  }

  const ref = await db.collection("feedback").add(doc);
  functions.logger.info("submitFeedback: wrote " + ref.id + " category=" + category);
  return { id: ref.id };
});

// adminReplyFeedback({id, status?, reply?}) . admin-only. Updates feedback
// status and/or reply. Status must be one of new, read, resolved.
const FEEDBACK_STATUSES = new Set(["new", "read", "resolved"]);

export const adminReplyFeedback = functions.https.onCall(async (data, context) => {
  const actor = await requireAdmin(context);

  const id = data?.id;
  if (typeof id !== "string" || !isValidId(id)) {
    throw new functions.https.HttpsError("invalid-argument", "id is required.");
  }

  const update: Record<string, unknown> = {
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: actor,
  };

  if (typeof data?.status === "string") {
    if (!FEEDBACK_STATUSES.has(data.status)) {
      throw new functions.https.HttpsError("invalid-argument", "Invalid status.");
    }
    update.status = data.status;
  }

  if (typeof data?.reply === "string") {
    const reply = data.reply.trim();
    if (reply.length > 5000) {
      throw new functions.https.HttpsError("invalid-argument", "Reply too long.");
    }
    update.reply = reply.length ? reply : null;
    update.repliedAt = admin.firestore.FieldValue.serverTimestamp();
  }

  const ref = db.collection("feedback").doc(id);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new functions.https.HttpsError("not-found", "Feedback not found.");
  }
  await ref.update(update);

  await writeAudit({
    actor,
    action: "feedback.update",
    target: id,
    targetCollection: "feedback",
    extra: {
      status: update.status ?? null,
      hasReply: typeof data?.reply === "string" && data.reply.trim().length > 0,
    },
  });

  return { ok: true, id };
});

// ─── adminPurgeSeedData ───────────────────────────────────────────────────────
// One-off admin-gated callable. Deletes every doc in /sequences, /packs,
// /purchases, /users that is tagged as seed/placeholder data.
//
// Seed criteria (any one is enough):
//   . isSeed === true
//   . source === 'seed'
//   . creatorUid === 'system'            (legacy marker from seed-sequences.js)
//   . name in SEED_TITLES                (belt-and-suspenders fallback)
//   . id in SEED_IDS                     (for packs, which have fixed ids)
//
// Safe to run more than once. Returns counts per collection.
const SEED_TITLES_SERVER = new Set<string>([
  "Candy Cane Dream", "Star-Spangled Roofline", "Spooky Strobe-Free",
  "Winter Wonderland Chase", "Firecracker Finale", "Pumpkin Pulse",
  "Be My Valentine", "Northern Lights Effect", "Freedom Waves",
  "Twinkle & Sparkle", "Rocket's Red Glare", "Haunted Mansion Fade",
]);
const SEED_PACK_IDS = new Set<string>([
  "pack_christmas", "pack_halloween", "pack_patriotic",
]);

function _isSeedSequenceDoc(d: Record<string, unknown>): boolean {
  if (!d) return false;
  if (d.isSeed === true) return true;
  if (d.isTest === true) return true;
  if (d.source === "seed") return true;
  if (d.creatorUid === "system") return true;
  const name = typeof d.name === "string" ? d.name : "";
  if (name && SEED_TITLES_SERVER.has(name)) return true;
  return false;
}

export const adminPurgeSeedData = functions.https.onCall(async (data, context) => {
  const actor = await requireAdmin(context);

  let seqDeleted = 0;
  let packDeleted = 0;
  let purchaseDeleted = 0;
  let userDeleted = 0;

  // /sequences
  const seqSnap = await db.collection("sequences").get();
  for (const doc of seqSnap.docs) {
    const d = doc.data() || {};
    if (_isSeedSequenceDoc(d)) {
      await doc.ref.delete();
      seqDeleted++;
    }
  }

  // /packs (always treated as seed if id matches or marker set)
  const packSnap = await db.collection("packs").get();
  for (const doc of packSnap.docs) {
    const d = doc.data() || {};
    if (d.isSeed === true || d.source === "seed" || SEED_PACK_IDS.has(doc.id)) {
      await doc.ref.delete();
      packDeleted++;
    }
  }

  // /purchases
  const purSnap = await db.collection("purchases").get();
  for (const doc of purSnap.docs) {
    const d = doc.data() || {};
    if (d.isSeed === true || d.isTest === true || d.source === "seed") {
      await doc.ref.delete();
      purchaseDeleted++;
    }
  }

  // /users
  const userSnap = await db.collection("users").get();
  for (const doc of userSnap.docs) {
    const d = doc.data() || {};
    if (d.isSeed === true || d.isTest === true || d.source === "seed") {
      await doc.ref.delete();
      userDeleted++;
    }
  }

  await writeAudit({
    actor,
    action: "admin.purgeSeedData",
    target: null,
    targetCollection: null,
    extra: {
      sequences: seqDeleted,
      packs: packDeleted,
      purchases: purchaseDeleted,
      users: userDeleted,
    },
  });

  functions.logger.info(
    `adminPurgeSeedData by ${actor}: ` +
    `sequences=${seqDeleted} packs=${packDeleted} ` +
    `purchases=${purchaseDeleted} users=${userDeleted}`
  );

  return {
    ok: true,
    sequences: seqDeleted,
    packs: packDeleted,
    purchases: purchaseDeleted,
    users: userDeleted,
  };
});
