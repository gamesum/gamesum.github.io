import * as admin from "firebase-admin";
import * as functions from "firebase-functions";
import { defineSecret } from "firebase-functions/params";
import Stripe from "stripe";

admin.initializeApp();
const db = admin.firestore();

const STRIPE_SECRET = defineSecret("STRIPE_SECRET");
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");

const SITE_URL = "https://afterglolighting.github.io";

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
// Called by firmware: GET https://api.afterglolighting.org/purchases?token={uid}
// Returns the list of purchased sequence IDs for that user account.
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

  const token = req.query.token as string;
  if (!token || token.trim().length === 0) {
    res.status(400).json({ error: "Missing token parameter" });
    return;
  }

  try {
    // token == Firebase UID (Google sub)
    const snap = await db
      .collection("purchases")
      .where("userId", "==", token)
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
  res.set("Access-Control-Allow-Origin", "https://afterglolighting.github.io");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");

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

    // Idempotent
    const existing = await db.collection("purchases")
      .where("userId", "==", uid).where("sequenceId", "==", sequenceId).limit(1).get();
    if (!existing.empty) { res.status(200).json({ status: "already_owned" }); return; }

    const meta = session.metadata!;
    const priceNum = parseFloat(meta.price ?? "0");

    // Look up creatorUid from sequences collection (key by UID, not display name)
    const seqDoc = await db.collection("sequences").doc(sequenceId).get();
    const creatorUid = seqDoc.exists ? (seqDoc.data()?.creatorUid ?? meta.creator) : meta.creator;

    await db.collection("purchases").add({
      userId: uid,
      sequenceId,
      sequenceName: meta.sequenceName,
      creator: meta.creator ?? "Unknown",
      price: priceNum,
      purchasedAt: admin.firestore.Timestamp.now(),
      stripeSessionId,
    });

    // Creator earnings keyed by UID, not display name
    const creatorShare = Math.round(priceNum * 0.7 * 100) / 100;
    await db.collection("creator_earnings").doc(creatorUid).set(
      { totalEarnings: admin.firestore.FieldValue.increment(creatorShare) },
      { merge: true }
    );

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
  res.set("Access-Control-Allow-Origin", "https://afterglolighting.github.io");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");

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

  const { sequenceId, name, category, durationSecs, channelCount, price } =
    req.body as {
      sequenceId: string;
      name: string;
      category: string;
      durationSecs: number;
      channelCount: number;
      price: number;
    };

  if (!sequenceId || !name) {
    res.status(400).json({ error: "Missing required fields" });
    return;
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
      status: "pending_upload",
      createdAt: admin.firestore.Timestamp.now(),
      downloadCount: 0,
    });

    res.status(200).json({ uploadUrl: signedUrl, sequenceId });
  } catch (err) {
    functions.logger.error("uploadSequence error", err);
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
  res.set("Access-Control-Allow-Origin", SITE_URL);
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");

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
    const meta = session.metadata ?? {};
    const { userId, sequenceId, sequenceName, creator, price } = meta;

    if (!userId || !sequenceId) {
      functions.logger.warn("stripeWebhook: missing metadata", meta);
      res.status(200).send("OK");
      return;
    }

    // Idempotent: skip if already recorded
    const existing = await db.collection("purchases")
      .where("userId", "==", userId)
      .where("sequenceId", "==", sequenceId)
      .limit(1).get();

    if (existing.empty) {
      const priceNum = parseFloat(price ?? "0");
      await db.collection("purchases").add({
        userId,
        sequenceId,
        sequenceName,
        creator:          creator ?? "Unknown",
        price:            priceNum,
        purchasedAt:      admin.firestore.Timestamp.now(),
        stripeSessionId:  session.id,
      });

      // Creator earnings keyed by creatorUid (not display name) so renames don't lose earnings
      const seqSnap = await db.collection("sequences").doc(sequenceId).get();
      const creatorUid = seqSnap.exists ? (seqSnap.data()?.creatorUid ?? creator) : creator;
      if (creatorUid) {
        await db.collection("creator_earnings").doc(creatorUid).set(
          { totalEarnings: admin.firestore.FieldValue.increment(Math.round(priceNum * 0.7 * 100) / 100) },
          { merge: true }
        );
      }

      functions.logger.info(`Purchase recorded via webhook: ${userId} → ${sequenceId}`);
    }
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
  res.set("Access-Control-Allow-Origin", SITE_URL);
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");

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

    await seqRef.update({ status: "published" });

    functions.logger.info(`Sequence published: ${sequenceId} by ${uid}`);
    res.status(200).json({ status: "published" });
  } catch (err) {
    functions.logger.error("confirmUpload error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
