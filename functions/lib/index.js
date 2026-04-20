"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.confirmUpload = exports.getDownloadUrl = exports.stripeWebhook = exports.createCheckout = exports.sequenceList = exports.uploadSequence = exports.recordPurchase = exports.purchases = void 0;
const admin = __importStar(require("firebase-admin"));
const functions = __importStar(require("firebase-functions"));
const params_1 = require("firebase-functions/params");
const stripe_1 = __importDefault(require("stripe"));
admin.initializeApp();
const db = admin.firestore();
const STRIPE_SECRET = (0, params_1.defineSecret)("STRIPE_SECRET");
const STRIPE_WEBHOOK_SECRET = (0, params_1.defineSecret)("STRIPE_WEBHOOK_SECRET");
const SITE_URL = "https://afterglolighting.github.io";
// ─── Validation helper ────────────────────────────────────────────────────────
// FIX 1: prevents path-traversal / injection via sequenceId
function isValidId(id) {
    return typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
}
// ─── GET /purchases ───────────────────────────────────────────────────────────
// Called by firmware: GET https://api.afterglolighting.org/purchases
// Accepts Firebase ID token in Authorization: Bearer header OR ?token= query param.
// FIX 3: token is now verified as a Firebase ID token, not used raw as a UID.
exports.purchases = functions.https.onRequest(async (req, res) => {
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
        : req.query.token) ?? "";
    if (!rawToken) {
        res.status(400).json({ error: "Missing token" });
        return;
    }
    let uid;
    try {
        const decoded = await admin.auth().verifyIdToken(rawToken);
        uid = decoded.uid;
    }
    catch {
        res.status(401).json({ error: "Invalid token" });
        return;
    }
    try {
        const snap = await db
            .collection("purchases")
            .where("userId", "==", uid)
            .get();
        const purchaseList = snap.docs.map((doc) => {
            const data = doc.data();
            return {
                id: data.sequenceId,
                name: data.sequenceName,
                creator: data.creator,
            };
        });
        res.status(200).json({ purchases: purchaseList });
    }
    catch (err) {
        functions.logger.error("purchases fetch error", err);
        res.status(500).json({ error: "Internal server error" });
    }
});
// ─── POST /recordPurchase ─────────────────────────────────────────────────────
// Called by website after Stripe Checkout redirect.
// Requires stripeSessionId — verifies payment with Stripe before recording.
exports.recordPurchase = functions
    .runWith({ secrets: ["STRIPE_SECRET"] })
    .https.onRequest(async (req, res) => {
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
    const authHeader = req.headers.authorization ?? "";
    if (!authHeader.startsWith("Bearer ")) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    let uid;
    try {
        const decoded = await admin.auth().verifyIdToken(authHeader.slice(7));
        uid = decoded.uid;
    }
    catch {
        res.status(401).json({ error: "Invalid or expired token" });
        return;
    }
    const { sequenceId, stripeSessionId } = req.body;
    if (!sequenceId || !stripeSessionId) {
        res.status(400).json({ error: "Missing sequenceId or stripeSessionId" });
        return;
    }
    // FIX 1: validate sequenceId
    if (!isValidId(sequenceId)) {
        res.status(400).json({ error: "Invalid sequenceId" });
        return;
    }
    try {
        // Verify payment actually happened with Stripe
        const stripe = new stripe_1.default(STRIPE_SECRET.value(), { apiVersion: "2023-10-16" });
        const session = await stripe.checkout.sessions.retrieve(stripeSessionId);
        if (session.payment_status !== "paid") {
            res.status(402).json({ error: "Payment not completed" });
            return;
        }
        if (session.metadata?.userId !== uid || session.metadata?.sequenceId !== sequenceId) {
            res.status(403).json({ error: "Session mismatch" });
            return;
        }
        const meta = session.metadata;
        const priceNum = parseFloat(meta.price ?? "0");
        // FIX 6: price validation
        if (typeof priceNum !== "number" || !isFinite(priceNum) || priceNum < 0 || priceNum > 999) {
            res.status(400).json({ error: "Invalid price" });
            return;
        }
        // Look up creatorUid from sequences collection (key by UID, not display name)
        const seqDoc = await db.collection("sequences").doc(sequenceId).get();
        const creatorUid = seqDoc.exists ? (seqDoc.data()?.creatorUid ?? meta.creator) : meta.creator;
        // FIX 2: deterministic doc ID for idempotency + atomic transaction
        const purchaseDocRef = db.collection("purchases").doc(`${uid}_${sequenceId}`);
        await db.runTransaction(async (tx) => {
            const existing = await tx.get(purchaseDocRef);
            if (existing.exists)
                return; // already recorded
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
            tx.set(creatorEarningsRef, { totalEarnings: admin.firestore.FieldValue.increment(Math.round(priceNum * 0.7 * 100) / 100) }, { merge: true });
        });
        functions.logger.info(`Purchase recorded: ${uid} → ${sequenceId}`);
        res.status(201).json({ status: "recorded" });
    }
    catch (err) {
        functions.logger.error("recordPurchase error", err);
        res.status(500).json({ error: "Internal server error" });
    }
});
// ─── POST /uploadSequence ─────────────────────────────────────────────────────
// Called by platform.html upload form.
// Stores metadata in Firestore; the actual FSEQ file goes to Firebase Storage
// (or CDN) separately via a signed upload URL returned from this function.
exports.uploadSequence = functions.https.onRequest(async (req, res) => {
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
    let uid;
    let displayName;
    try {
        const decoded = await admin.auth().verifyIdToken(idToken);
        uid = decoded.uid;
        displayName = decoded.name ?? decoded.email ?? "Unknown";
    }
    catch {
        res.status(401).json({ error: "Invalid or expired token" });
        return;
    }
    const { sequenceId, name, category, durationSecs, channelCount, price } = req.body;
    if (!sequenceId || !name) {
        res.status(400).json({ error: "Missing required fields" });
        return;
    }
    // FIX 1: validate sequenceId
    if (!isValidId(sequenceId)) {
        res.status(400).json({ error: "Invalid sequenceId" });
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
    }
    catch (err) {
        functions.logger.error("uploadSequence error", err);
        res.status(500).json({ error: "Internal server error" });
    }
});
// ─── GET /sequences ───────────────────────────────────────────────────────────
// Public endpoint: list published sequences for the store.
exports.sequenceList = functions.https.onRequest(async (req, res) => {
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
    }
    catch (err) {
        functions.logger.error("sequenceList error", err);
        res.status(500).json({ error: "Internal server error" });
    }
});
// ─── POST /createCheckout ─────────────────────────────────────────────────────
// Creates a Stripe Checkout Session for a sequence or pack purchase.
// Body: { sequenceId, sequenceName, creator, price }  (price in dollars)
// Requires Firebase ID token in Authorization header.
exports.createCheckout = functions
    .runWith({ secrets: ["STRIPE_SECRET"] })
    .https.onRequest(async (req, res) => {
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
    const authHeader = req.headers.authorization ?? "";
    if (!authHeader.startsWith("Bearer ")) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    let uid;
    let email;
    try {
        const decoded = await admin.auth().verifyIdToken(authHeader.slice(7));
        uid = decoded.uid;
        email = decoded.email;
    }
    catch {
        res.status(401).json({ error: "Invalid token" });
        return;
    }
    const { sequenceId, sequenceName, creator, price } = req.body;
    if (!sequenceId || !sequenceName || price == null) {
        res.status(400).json({ error: "Missing required fields" });
        return;
    }
    // FIX 1: validate sequenceId
    if (!isValidId(sequenceId)) {
        res.status(400).json({ error: "Invalid sequenceId" });
        return;
    }
    // FIX 6: price validation
    if (typeof price !== "number" || !isFinite(price) || price < 0 || price > 999) {
        res.status(400).json({ error: "Invalid price" });
        return;
    }
    const existingSnap = await db.collection("purchases")
        .where("userId", "==", uid)
        .where("sequenceId", "==", sequenceId)
        .limit(1).get();
    if (!existingSnap.empty) {
        res.status(200).json({ status: "already_owned" });
        return;
    }
    try {
        const stripe = new stripe_1.default(STRIPE_SECRET.value(), { apiVersion: "2023-10-16" });
        const session = await stripe.checkout.sessions.create({
            mode: "payment",
            customer_email: email,
            line_items: [{
                    quantity: 1,
                    price_data: {
                        currency: "usd",
                        unit_amount: Math.round(price * 100),
                        product_data: {
                            name: sequenceName,
                            description: `By ${creator} · AFTERGLO Light Show`,
                        },
                    },
                }],
            allow_promotion_codes: true,
            metadata: { userId: uid, sequenceId, sequenceName, creator, price: String(price) },
            success_url: `${SITE_URL}/platform.html?purchase=success&seq=${sequenceId}&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${SITE_URL}/platform.html?purchase=cancel`,
        });
        res.status(200).json({ url: session.url });
    }
    catch (err) {
        functions.logger.error("createCheckout error", err);
        res.status(500).json({ error: "Failed to create checkout session" });
    }
});
// ─── POST /stripeWebhook ──────────────────────────────────────────────────────
// Stripe calls this after a successful payment.
// Verifies the signature, then records the purchase in Firestore.
exports.stripeWebhook = functions
    .runWith({ secrets: ["STRIPE_SECRET", "STRIPE_WEBHOOK_SECRET"] })
    .https.onRequest(async (req, res) => {
    const sig = req.headers["stripe-signature"];
    const stripe = new stripe_1.default(STRIPE_SECRET.value(), { apiVersion: "2023-10-16" });
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.rawBody, sig, STRIPE_WEBHOOK_SECRET.value());
    }
    catch (err) {
        functions.logger.warn("stripeWebhook signature verification failed", err);
        res.status(400).send("Webhook signature invalid");
        return;
    }
    if (event.type === "checkout.session.completed") {
        const session = event.data.object;
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
            if (existing.exists)
                return; // already recorded
            tx.set(purchaseDocRef, {
                userId,
                sequenceId,
                sequenceName,
                creator: creator ?? "Unknown",
                price: priceNum,
                purchasedAt: admin.firestore.Timestamp.now(),
                stripeSessionId: session.id,
            });
            if (creatorUid) {
                const creatorEarningsRef = db.collection("creator_earnings").doc(creatorUid);
                tx.set(creatorEarningsRef, { totalEarnings: admin.firestore.FieldValue.increment(Math.round(priceNum * 0.7 * 100) / 100) }, { merge: true });
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
exports.getDownloadUrl = functions.https.onRequest(async (req, res) => {
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
    let uid;
    try {
        const decoded = await admin.auth().verifyIdToken(idToken);
        uid = decoded.uid;
    }
    catch {
        res.status(401).json({ error: "Invalid or expired token" });
        return;
    }
    const sequenceId = req.query.sequenceId;
    if (!sequenceId || sequenceId.trim().length === 0) {
        res.status(400).json({ error: "Missing sequenceId parameter" });
        return;
    }
    // FIX 1: validate sequenceId
    if (!isValidId(sequenceId)) {
        res.status(400).json({ error: "Invalid sequenceId" });
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
            const seqData = seqDoc.data();
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
    }
    catch (err) {
        functions.logger.error("getDownloadUrl error", err);
        res.status(500).json({ error: "Internal server error" });
    }
});
// ─── POST /confirmUpload ──────────────────────────────────────────────────────
// Called by the creator's client after the FSEQ file has been PUT to Storage.
// Body: { sequenceId }
// Header: Authorization: Bearer {Firebase ID token}
// Verifies the caller owns the sequence, then sets status → "published".
exports.confirmUpload = functions.https.onRequest(async (req, res) => {
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
    let uid;
    try {
        const decoded = await admin.auth().verifyIdToken(idToken);
        uid = decoded.uid;
    }
    catch {
        res.status(401).json({ error: "Invalid or expired token" });
        return;
    }
    const { sequenceId } = req.body;
    if (!sequenceId) {
        res.status(400).json({ error: "Missing sequenceId" });
        return;
    }
    // FIX 1: validate sequenceId
    if (!isValidId(sequenceId)) {
        res.status(400).json({ error: "Invalid sequenceId" });
        return;
    }
    try {
        const seqRef = db.collection("sequences").doc(sequenceId);
        const seqDoc = await seqRef.get();
        if (!seqDoc.exists) {
            res.status(404).json({ error: "Sequence not found" });
            return;
        }
        const seqData = seqDoc.data();
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
            res.status(400).json({ error: "File not yet uploaded" });
            return;
        }
        await seqRef.update({ status: "published" });
        functions.logger.info(`Sequence published: ${sequenceId} by ${uid}`);
        res.status(200).json({ status: "published" });
    }
    catch (err) {
        functions.logger.error("confirmUpload error", err);
        res.status(500).json({ error: "Internal server error" });
    }
});
//# sourceMappingURL=index.js.map