import * as admin from "firebase-admin";
import * as functions from "firebase-functions";
import { defineSecret } from "firebase-functions/params";
import Stripe from "stripe";

admin.initializeApp();
const db = admin.firestore();

const STRIPE_SECRET = defineSecret("STRIPE_SECRET");
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");

const SITE_URL = "https://afterglolighting.org";

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

    // FIX 2: deterministic doc ID for idempotency + atomic transaction
    const purchaseDocRef = db.collection("purchases").doc(`${uid}_${sequenceId}`);
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(purchaseDocRef);
      if (existing.exists) return; // already recorded

      tx.set(purchaseDocRef, {
        userId: uid,
        sequenceId,
        sequenceName: meta.sequenceName,
        creator: meta.creator ?? "Unknown",
        price: priceNum,
        purchasedAt: admin.firestore.Timestamp.now(),
        stripeSessionId,
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

  const { sequenceId, name, category, durationSecs, channelCount, price, songName, youtubeUrl, hasMp3 } =
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
    };

  if (!sequenceId || !name) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  // FIX 1: validate sequenceId
  if (!isValidId(sequenceId)) {
    res.status(400).json({ error: "Invalid sequenceId" }); return;
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
      status: "pending_upload",
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
    const session = await stripe.checkout.sessions.create({
      mode:          "payment",
      customer_email: email,
      line_items: [{
        quantity: 1,
        price_data: {
          currency:     "usd",
          unit_amount:  Math.round(price * 100),
          product_data: {
            name:        sequenceName,
            description: `By ${creator} · AFTERGLO Light Show`,
          },
        },
      }],
      allow_promotion_codes: true,
      metadata: { userId: uid, sequenceId, sequenceName, creator, price: String(price) },
      success_url: `${SITE_URL}/platform.html?purchase=success&seq=${sequenceId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${SITE_URL}/platform.html?purchase=cancel`,
    });

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

    if (!userId || !sequenceId) {
      functions.logger.warn("stripeWebhook: missing metadata", meta);
      res.status(200).send("OK");
      return;
    }

    const priceNum = parseFloat(price ?? "0");

    // Look up creatorUid by UID so renames don't lose earnings
    const seqSnap = await db.collection("sequences").doc(sequenceId).get();
    const creatorUid = seqSnap.exists ? (seqSnap.data()?.creatorUid ?? creator) : creator;

    // FIX 2: deterministic doc ID + atomic transaction for idempotency
    const purchaseDocRef = db.collection("purchases").doc(`${userId}_${sequenceId}`);
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(purchaseDocRef);
      if (existing.exists) return; // already recorded

      tx.set(purchaseDocRef, {
        userId,
        sequenceId,
        sequenceName,
        creator:         creator ?? "Unknown",
        price:           priceNum,
        purchasedAt:     admin.firestore.Timestamp.now(),
        stripeSessionId: session.id,
      });

      if (creatorUid) {
        const creatorEarningsRef = db.collection("creator_earnings").doc(creatorUid);
        tx.set(creatorEarningsRef,
          { totalEarnings: admin.firestore.FieldValue.increment(Math.round(priceNum * 0.7 * 100) / 100) },
          { merge: true }
        );
      }
    });

    functions.logger.info(`Purchase recorded via webhook: ${userId} → ${sequenceId}`);
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

function requireAdmin(context: functions.https.CallableContext): string {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Sign-in required.");
  }
  if (context.auth.token.admin !== true) {
    throw new functions.https.HttpsError("permission-denied", "Admin access required.");
  }
  return context.auth.uid;
}

// adminSetUserRole(uid, role). role is one of: 'user', 'creator', 'admin'.
// Writes custom claim {admin, creator} and mirrors role into /users/{uid}.
export const adminSetUserRole = functions.https.onCall(async (data, context) => {
  requireAdmin(context);

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
  requireAdmin(context);

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
  requireAdmin(context);

  const uploadId = data?.uploadId;
  const status   = data?.status;
  if (typeof uploadId !== "string" || !isValidId(uploadId)) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid uploadId.");
  }
  const allowed = new Set(["pending", "approved", "rejected", "published", "pending_upload"]);
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
  requireAdmin(context);

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
  requireAdmin(context);

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
