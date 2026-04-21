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
exports.adminListCreatorsPayoutStatus = exports.checkConnectStatus = exports.createConnectOnboardingLink = exports.createConnectAccount = exports.adminRefundPurchase = exports.adminClaimBootstrap = exports.adminListUsers = exports.adminDeleteUpload = exports.adminSetUploadStatus = exports.adminDisableUser = exports.adminSetUserRole = exports.confirmUpload = exports.getDownloadUrl = exports.stripeWebhook = exports.createCheckout = exports.sequenceList = exports.getListings = exports.uploadSequence = exports.recordPurchase = exports.purchases = void 0;
const admin = __importStar(require("firebase-admin"));
const functions = __importStar(require("firebase-functions"));
const params_1 = require("firebase-functions/params");
const stripe_1 = __importDefault(require("stripe"));
admin.initializeApp();
const db = admin.firestore();
const STRIPE_SECRET = (0, params_1.defineSecret)("STRIPE_SECRET");
const STRIPE_WEBHOOK_SECRET = (0, params_1.defineSecret)("STRIPE_WEBHOOK_SECRET");
const SITE_URL = "https://afterglolighting.org";
const ALLOWED_ORIGINS = new Set([
    "https://afterglolighting.org",
    "https://www.afterglolighting.org",
    "https://afterglolighting.github.io",
    "https://afterglo-website-fbb89.web.app",
    "https://afterglo-website-fbb89.firebaseapp.com",
]);
function applyCors(req, res) {
    const origin = req.headers.origin || "";
    if (ALLOWED_ORIGINS.has(origin)) {
        res.set("Access-Control-Allow-Origin", origin);
        res.set("Vary", "Origin");
    }
    else {
        res.set("Access-Control-Allow-Origin", SITE_URL);
    }
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
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
    applyCors(req, res);
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
    const { sequenceId, name, category, durationSecs, channelCount, price, songName, youtubeUrl, hasMp3 } = req.body;
    if (!sequenceId || !name) {
        res.status(400).json({ error: "Missing required fields" });
        return;
    }
    // FIX 1: validate sequenceId
    if (!isValidId(sequenceId)) {
        res.status(400).json({ error: "Invalid sequenceId" });
        return;
    }
    // Require creator-agreement acceptance before any upload.
    try {
        const userDoc = await db.collection("users").doc(uid).get();
        const accepted = userDoc.exists ? userDoc.data()?.creatorAgreementAcceptedAt : null;
        if (!accepted) {
            res.status(403).json({ error: "Creator agreement not accepted", code: "agreement_required" });
            return;
        }
    }
    catch (e) {
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
        let mp3UploadUrl;
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
            status: "published",
            createdAt: admin.firestore.Timestamp.now(),
            downloadCount: 0,
        });
        res.status(200).json({ uploadUrl: signedUrl, sequenceId, ...(mp3UploadUrl ? { mp3UploadUrl } : {}) });
    }
    catch (err) {
        functions.logger.error("uploadSequence error", err);
        res.status(500).json({ error: "Internal server error" });
    }
});
// ─── GET /getListings ─────────────────────────────────────────────────────────
// Public endpoint: returns both published sequences AND packs from Firestore.
// Used by the Android app and future website versions as the single source of truth.
// Response: { sequences: [...], packs: [...] }
exports.getListings = functions.https.onRequest(async (req, res) => {
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
        const packs = packSnap.docs.map((doc) => doc.data());
        res.set("Cache-Control", "public, max-age=60, s-maxage=60");
        res.status(200).json({ sequences, packs });
    }
    catch (err) {
        functions.logger.error("getListings error", err);
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
    applyCors(req, res);
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
        // Look up the creator's Connect account so 70% routes directly to their
        // Express balance. If they haven't onboarded, we keep the legacy flow
        // and flag the sale as unroutable in the ledger for admin reconciliation.
        const seqDoc = await db.collection("sequences").doc(sequenceId).get();
        const creatorUid = seqDoc.exists ? seqDoc.data()?.creatorUid : undefined;
        let creatorStripeAccountId;
        let creatorOnboardingStatus;
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
        const routeToCreator = !!creatorStripeAccountId && creatorOnboardingStatus === "complete" && creatorShareCents > 0;
        const sessionParams = {
            mode: "payment",
            customer_email: email,
            line_items: [{
                    quantity: 1,
                    price_data: {
                        currency: "usd",
                        unit_amount: totalCents,
                        product_data: {
                            name: sequenceName,
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
            cancel_url: `${SITE_URL}/platform.html?purchase=cancel`,
        };
        if (routeToCreator) {
            sessionParams.payment_intent_data = {
                transfer_data: {
                    destination: creatorStripeAccountId,
                    amount: creatorShareCents,
                },
            };
        }
        const session = await stripe.checkout.sessions.create(sessionParams);
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
        const creatorUid = seqSnap.exists
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
                creator: creator ?? "Unknown",
                creatorUid: creatorUid || null,
                price: priceNum,
                purchasedAt: admin.firestore.Timestamp.now(),
                stripeSessionId: session.id,
                paymentIntentId: paymentIntentId ?? null,
                status: "paid",
            });
            if (creatorUid) {
                const creatorEarningsRef = db.collection("creator_earnings").doc(creatorUid);
                tx.set(creatorEarningsRef, {
                    totalEarnings: admin.firestore.FieldValue.increment(earningsShare),
                    // Track the portion that has already landed in the creator's
                    // Stripe Express balance (or, if unroutable, that still owes them).
                    [routedToCreator ? "routedEarnings" : "unroutableEarnings"]: admin.firestore.FieldValue.increment(earningsShare),
                    updatedAt: admin.firestore.Timestamp.now(),
                }, { merge: true });
                // Ledger entry for the creator dashboard + admin reconciliation.
                const ledgerRef = creatorEarningsRef.collection("ledger").doc(session.id);
                tx.set(ledgerRef, {
                    sequenceId,
                    sequenceName: sequenceName ?? "",
                    saleAmount: priceNum,
                    earnings: earningsShare,
                    status: routedToCreator ? "routed" : "unroutable",
                    stripeSessionId: session.id,
                    createdAt: admin.firestore.Timestamp.now(),
                }, { merge: true });
            }
        });
        functions.logger.info(`Purchase recorded via webhook: ${userId} -> ${sequenceId} (routed=${routedToCreator})`);
    }
    // Stripe Connect: account.updated -> mirror capability flags into /users/{uid}
    if (event.type === "account.updated") {
        const account = event.data.object;
        const userId = (account.metadata && account.metadata.userId) || null;
        if (userId) {
            try {
                const detailsSubmitted = !!account.details_submitted;
                const chargesEnabled = !!account.charges_enabled;
                const payoutsEnabled = !!account.payouts_enabled;
                const onboardingStatus = (detailsSubmitted && chargesEnabled && payoutsEnabled) ? "complete" :
                    detailsSubmitted ? "review" : "pending";
                await db.collection("users").doc(userId).set({
                    stripeAccountId: account.id,
                    detailsSubmitted,
                    chargesEnabled,
                    payoutsEnabled,
                    onboardingStatus,
                    onboardingUpdatedAt: admin.firestore.Timestamp.now(),
                }, { merge: true });
                functions.logger.info(`account.updated synced: ${userId} -> ${onboardingStatus}`);
            }
            catch (err) {
                functions.logger.error("account.updated sync failed", err);
            }
        }
    }
    // ─── Dispute: created ──────────────────────────────────────────────────────
    // Customer filed a chargeback. Mark disputed, revoke entitlement, claw back
    // creator share provisionally. A later charge.dispute.closed(won) restores.
    if (event.type === "charge.dispute.created") {
        const dispute = event.data.object;
        const paymentIntentId = typeof dispute.payment_intent === "string"
            ? dispute.payment_intent
            : dispute.payment_intent?.id ?? null;
        let purchaseDoc = null;
        if (paymentIntentId) {
            const snap = await db.collection("purchases")
                .where("paymentIntentId", "==", paymentIntentId)
                .limit(1).get();
            if (!snap.empty)
                purchaseDoc = snap.docs[0];
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
                    if (!snap.empty)
                        purchaseDoc = snap.docs[0];
                }
            }
            catch (err) {
                functions.logger.warn("dispute: failed to retrieve charge for fallback match", err);
            }
        }
        const purchaseData = purchaseDoc?.data();
        const disputeRef = db.collection("disputes").doc(dispute.id);
        await db.runTransaction(async (tx) => {
            tx.set(disputeRef, {
                id: dispute.id,
                status: dispute.status,
                reason: dispute.reason,
                amount: dispute.amount,
                currency: dispute.currency,
                createdAt: admin.firestore.Timestamp.now(),
                stripeCreated: dispute.created,
                evidenceDueBy: dispute.evidence_details?.due_by ?? null,
                paymentIntentId,
                charge: typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id ?? null,
                purchaseId: purchaseDoc?.id ?? null,
                userId: purchaseData?.userId ?? null,
                sequenceId: purchaseData?.sequenceId ?? null,
                sequenceName: purchaseData?.sequenceName ?? null,
                creatorUid: purchaseData?.creatorUid ?? null,
                livemode: dispute.livemode ?? false,
            }, { merge: true });
            if (purchaseDoc) {
                tx.update(purchaseDoc.ref, {
                    status: "disputed",
                    disputedAt: admin.firestore.Timestamp.now(),
                    disputeId: dispute.id,
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
                        updatedAt: admin.firestore.Timestamp.now(),
                    }, { merge: true });
                    const ledgerRef = earningsRef.collection("ledger").doc();
                    tx.set(ledgerRef, {
                        type: "dispute_provisional",
                        amount: -share,
                        purchaseId: purchaseDoc.id,
                        disputeId: dispute.id,
                        createdAt: admin.firestore.Timestamp.now(),
                    });
                }
            }
            const auditRef = db.collection("admin_audit").doc();
            tx.set(auditRef, {
                action: "dispute.created",
                actor: "stripe_webhook",
                target: purchaseDoc?.id ?? null,
                disputeId: dispute.id,
                reason: dispute.reason,
                amount: dispute.amount,
                createdAt: admin.firestore.Timestamp.now(),
            });
        });
        functions.logger.warn(`Dispute created: ${dispute.id} on purchase ${purchaseDoc?.id ?? "<unmatched>"}`);
    }
    // ─── Dispute: closed ───────────────────────────────────────────────────────
    if (event.type === "charge.dispute.closed") {
        const dispute = event.data.object;
        const disputeRef = db.collection("disputes").doc(dispute.id);
        const disputeSnap = await disputeRef.get();
        const purchaseId = disputeSnap.data()?.purchaseId;
        await db.runTransaction(async (tx) => {
            tx.set(disputeRef, {
                status: dispute.status,
                closedAt: admin.firestore.Timestamp.now(),
            }, { merge: true });
            if (!purchaseId)
                return;
            const purchaseRef = db.collection("purchases").doc(purchaseId);
            const purchaseSnap = await tx.get(purchaseRef);
            if (!purchaseSnap.exists)
                return;
            const p = purchaseSnap.data();
            if (dispute.status === "won") {
                tx.update(purchaseRef, {
                    status: "paid",
                    disputeWonAt: admin.firestore.Timestamp.now(),
                });
                if (p.userId && p.sequenceId) {
                    tx.set(db.collection("users").doc(p.userId), {
                        library: admin.firestore.FieldValue.arrayUnion(p.sequenceId),
                    }, { merge: true });
                }
                const pCreatorUid = p.creatorUid;
                const pPrice = p.price ?? 0;
                if (pCreatorUid && pPrice > 0) {
                    const share = Math.round(pPrice * 0.7 * 100) / 100;
                    const earningsRef = db.collection("creator_earnings").doc(pCreatorUid);
                    tx.set(earningsRef, {
                        totalEarnings: admin.firestore.FieldValue.increment(share),
                        updatedAt: admin.firestore.Timestamp.now(),
                    }, { merge: true });
                    const ledgerRef = earningsRef.collection("ledger").doc();
                    tx.set(ledgerRef, {
                        type: "dispute_reversed",
                        amount: share,
                        purchaseId,
                        disputeId: dispute.id,
                        createdAt: admin.firestore.Timestamp.now(),
                    });
                }
            }
            else {
                tx.update(purchaseRef, {
                    status: "disputed_lost",
                    disputeLostAt: admin.firestore.Timestamp.now(),
                });
            }
            const auditRef = db.collection("admin_audit").doc();
            tx.set(auditRef, {
                action: "dispute.closed",
                actor: "stripe_webhook",
                target: purchaseId,
                disputeId: dispute.id,
                outcome: dispute.status,
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
// ─── ADMIN DASHBOARD CALLABLES ────────────────────────────────────────────────
// Gen 1 HTTPS callables. All require the caller to have a custom claim
// `admin === true` on their Firebase ID token. Every function throws
// HttpsError('permission-denied', ...) if the caller is not an admin.
const OWNER_EMAIL = "shaneward852@gmail.com";
// Re-verifies the caller's ID token with checkRevoked=true so revoked admin
// claims (e.g. just-demoted users) cannot keep calling admin endpoints.
async function requireAdmin(context) {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "Sign-in required.");
    }
    const rawToken = context.rawRequest?.headers?.authorization?.startsWith?.("Bearer ")
        ? context.rawRequest.headers.authorization.slice(7)
        : (context.instanceIdToken || "");
    if (rawToken) {
        try {
            const decoded = await admin.auth().verifyIdToken(rawToken, true);
            if (decoded.admin !== true) {
                throw new functions.https.HttpsError("permission-denied", "Admin access required.");
            }
            return decoded.uid;
        }
        catch (err) {
            if (err?.code === "auth/id-token-revoked") {
                throw new functions.https.HttpsError("permission-denied", "Session revoked. Sign in again.");
            }
            // fall through to legacy check if decoding failed for another reason
        }
    }
    if (context.auth.token.admin !== true) {
        throw new functions.https.HttpsError("permission-denied", "Admin access required.");
    }
    return context.auth.uid;
}
// adminSetUserRole(uid, role). role is one of: 'user', 'creator', 'admin'.
// Writes custom claim {admin, creator} and mirrors role into /users/{uid}.
exports.adminSetUserRole = functions.https.onCall(async (data, context) => {
    await requireAdmin(context);
    const uid = data?.uid;
    const role = data?.role;
    if (typeof uid !== "string" || !uid) {
        throw new functions.https.HttpsError("invalid-argument", "uid is required.");
    }
    if (role !== "user" && role !== "creator" && role !== "admin") {
        throw new functions.https.HttpsError("invalid-argument", "role must be user, creator, or admin.");
    }
    const claims = {
        admin: role === "admin",
        creator: role === "creator" || role === "admin",
    };
    await admin.auth().setCustomUserClaims(uid, claims);
    await db.collection("users").doc(uid).set({
        role,
        updatedAt: admin.firestore.Timestamp.now(),
    }, { merge: true });
    functions.logger.info(`adminSetUserRole: ${uid} -> ${role}`);
    return { ok: true, uid, role, claims };
});
// adminDisableUser(uid, disabled)
exports.adminDisableUser = functions.https.onCall(async (data, context) => {
    await requireAdmin(context);
    const uid = data?.uid;
    const disabled = data?.disabled;
    if (typeof uid !== "string" || !uid) {
        throw new functions.https.HttpsError("invalid-argument", "uid is required.");
    }
    if (typeof disabled !== "boolean") {
        throw new functions.https.HttpsError("invalid-argument", "disabled must be boolean.");
    }
    await admin.auth().updateUser(uid, { disabled });
    await db.collection("users").doc(uid).set({ disabled, updatedAt: admin.firestore.Timestamp.now() }, { merge: true });
    functions.logger.info(`adminDisableUser: ${uid} disabled=${disabled}`);
    return { ok: true, uid, disabled };
});
// adminSetUploadStatus(uploadId, status). Status is one of: pending, approved, rejected, published, pending_upload.
exports.adminSetUploadStatus = functions.https.onCall(async (data, context) => {
    await requireAdmin(context);
    const uploadId = data?.uploadId;
    const status = data?.status;
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
exports.adminDeleteUpload = functions.https.onCall(async (data, context) => {
    await requireAdmin(context);
    const uploadId = data?.uploadId;
    if (typeof uploadId !== "string" || !isValidId(uploadId)) {
        throw new functions.https.HttpsError("invalid-argument", "Invalid uploadId.");
    }
    const bucket = admin.storage().bucket();
    // Best-effort storage deletes (don't fail if the file never existed)
    await Promise.all([
        bucket.file(`sequences/${uploadId}.fseq`).delete({ ignoreNotFound: true }).catch(() => null),
        bucket.file(`sequences/${uploadId}.mp3`).delete({ ignoreNotFound: true }).catch(() => null),
    ]);
    await db.collection("sequences").doc(uploadId).delete();
    functions.logger.info(`adminDeleteUpload: ${uploadId}`);
    return { ok: true, uploadId };
});
// adminListUsers(pageToken?). Joins Firebase Auth user records with /users/{uid} mirror docs.
exports.adminListUsers = functions.https.onCall(async (data, context) => {
    await requireAdmin(context);
    const pageToken = typeof data?.pageToken === "string" ? data.pageToken : undefined;
    const result = await admin.auth().listUsers(1000, pageToken);
    // Fetch mirror docs in parallel (chunked to stay under Firestore batch-get limits)
    const uids = result.users.map((u) => u.uid);
    const docs = {};
    const CHUNK = 30;
    for (let i = 0; i < uids.length; i += CHUNK) {
        const batch = uids.slice(i, i + CHUNK);
        const snaps = await Promise.all(batch.map((uid) => db.collection("users").doc(uid).get()));
        snaps.forEach((s) => {
            if (s.exists)
                docs[s.id] = s.data();
        });
    }
    const users = result.users.map((u) => {
        const mirror = docs[u.uid] || {};
        const claims = (u.customClaims || {});
        const role = claims.admin ? "admin" : claims.creator ? "creator" : mirror.role || "user";
        return {
            uid: u.uid,
            email: u.email || "",
            displayName: u.displayName || mirror.displayName || "",
            emailVerified: u.emailVerified,
            disabled: u.disabled,
            createdAt: u.metadata.creationTime || null,
            lastSignIn: u.metadata.lastSignInTime || null,
            role,
            photoURL: u.photoURL || "",
        };
    });
    return { users, nextPageToken: result.pageToken || null };
});
// adminClaimBootstrap(secretKey). One-time bootstrap for the owner only.
// ONLY the hard-coded owner email may call this, and only with the matching
// ADMIN_BOOTSTRAP_SECRET. After the first successful call, rotate the secret.
exports.adminClaimBootstrap = functions.https.onCall(async (data, context) => {
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
        expected = functions.config()?.admin?.bootstrap || "";
    }
    catch {
        expected = "";
    }
    if (!expected)
        expected = process.env.ADMIN_BOOTSTRAP_SECRET || "";
    if (!expected) {
        throw new functions.https.HttpsError("failed-precondition", "Bootstrap secret is not configured.");
    }
    if (provided !== expected) {
        throw new functions.https.HttpsError("permission-denied", "Invalid bootstrap secret.");
    }
    const uid = context.auth.uid;
    await admin.auth().setCustomUserClaims(uid, { admin: true, creator: true });
    await db.collection("users").doc(uid).set({
        role: "admin",
        email,
        updatedAt: admin.firestore.Timestamp.now(),
    }, { merge: true });
    functions.logger.warn(`adminClaimBootstrap: admin claim granted to ${email} (${uid}). Rotate ADMIN_BOOTSTRAP_SECRET now.`);
    return { ok: true, uid, note: "Admin claim granted. Rotate ADMIN_BOOTSTRAP_SECRET now." };
});
// ─── callable: adminRefundPurchase ────────────────────────────────────────────
// Issues a Stripe refund against the PaymentIntent behind a purchase, revokes
// the user's entitlement, claws back the creator's 70% share of the refunded
// amount, writes a ledger entry, and logs to /admin_audit. Partial refunds are
// supported via amountCents (otherwise full refund).
exports.adminRefundPurchase = functions
    .runWith({ secrets: ["STRIPE_SECRET"] })
    .https.onCall(async (data, context) => {
    const adminUid = await requireAdmin(context);
    const purchaseId = data?.purchaseId;
    const reason = data?.reason;
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
    const purchase = purchaseSnap.data();
    if (purchase.status === "refunded") {
        throw new functions.https.HttpsError("failed-precondition", "Purchase already refunded.");
    }
    if (!purchase.stripeSessionId) {
        throw new functions.https.HttpsError("failed-precondition", "No Stripe session on this purchase.");
    }
    const stripe = new stripe_1.default(STRIPE_SECRET.value(), { apiVersion: "2023-10-16" });
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
    const stripeReason = reason === "fraudulent" ? "fraudulent"
        : reason === "duplicate" ? "duplicate"
            : reason === "customer_request" ? "requested_by_customer"
                : undefined;
    let refund;
    try {
        refund = await stripe.refunds.create({
            payment_intent: paymentIntentId,
            ...(amountCents ? { amount: amountCents } : {}),
            ...(stripeReason ? { reason: stripeReason } : {}),
            metadata: { adminUid, purchaseId, reason },
        });
    }
    catch (err) {
        functions.logger.error("Stripe refund failed", err);
        throw new functions.https.HttpsError("internal", `Stripe refund failed: ${err?.message || "unknown"}`);
    }
    const refundedAmountCents = refund.amount ?? (amountCents ?? Math.round((purchase.price || 0) * 100));
    const refundedAmountDollars = refundedAmountCents / 100;
    const creatorShare = Math.round(refundedAmountDollars * 0.7 * 100) / 100;
    await db.runTransaction(async (tx) => {
        tx.update(purchaseRef, {
            status: "refunded",
            refundedAt: admin.firestore.Timestamp.now(),
            refundedBy: adminUid,
            refundReason: reason,
            refundedAmountCents,
            stripeRefundId: refund.id,
        });
        if (purchase.userId && purchase.sequenceId) {
            tx.set(db.collection("users").doc(purchase.userId), {
                library: admin.firestore.FieldValue.arrayRemove(purchase.sequenceId),
            }, { merge: true });
            // Revoke any outstanding download token for this sequence.
            tx.set(db.collection("users").doc(purchase.userId)
                .collection("download_tokens").doc(purchase.sequenceId), {
                revokedAt: admin.firestore.Timestamp.now(),
                revokedBy: adminUid,
                reason: "refund",
            }, { merge: true });
        }
        const creatorUid = purchase.creatorUid;
        if (creatorUid && creatorShare > 0) {
            const earningsRef = db.collection("creator_earnings").doc(creatorUid);
            tx.set(earningsRef, {
                totalEarnings: admin.firestore.FieldValue.increment(-creatorShare),
                updatedAt: admin.firestore.Timestamp.now(),
            }, { merge: true });
            const ledgerRef = earningsRef.collection("ledger").doc();
            tx.set(ledgerRef, {
                type: "refund",
                amount: -creatorShare,
                purchaseId,
                refundId: refund.id,
                reason,
                createdAt: admin.firestore.Timestamp.now(),
            });
        }
        const auditRef = db.collection("admin_audit").doc();
        tx.set(auditRef, {
            action: "refund",
            actor: adminUid,
            target: purchaseId,
            reason,
            stripeRefundId: refund.id,
            amountCents: refundedAmountCents,
            createdAt: admin.firestore.Timestamp.now(),
        });
    });
    functions.logger.info(`adminRefundPurchase: ${purchaseId} refund=${refund.id} by ${adminUid}`);
    return { status: refund.status, stripeRefundId: refund.id };
});
// ─── STRIPE CONNECT (Express) ─────────────────────────────────────────────────
// Creator payouts via Stripe Connect Express accounts. Stripe hosts the W-9,
// bank, and tax-info flow on their side; we just persist the account id and
// mirror the capability flags so the creator dashboard knows onboarding state.
function requireAuth(context) {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "Sign-in required.");
    }
    return { uid: context.auth.uid, email: context.auth.token.email };
}
async function writeAdminAudit(action, actorUid, payload) {
    try {
        await db.collection("admin_audit").add({
            action,
            actorUid,
            payload,
            createdAt: admin.firestore.Timestamp.now(),
        });
    }
    catch (err) {
        functions.logger.warn("admin_audit write failed", err);
    }
}
function mirrorAccountFlags(account) {
    const detailsSubmitted = !!account.details_submitted;
    const chargesEnabled = !!account.charges_enabled;
    const payoutsEnabled = !!account.payouts_enabled;
    const onboardingStatus = (detailsSubmitted && chargesEnabled && payoutsEnabled) ? "complete" :
        detailsSubmitted ? "review" : "pending";
    return { detailsSubmitted, chargesEnabled, payoutsEnabled, onboardingStatus };
}
// createConnectAccount(): creates a Stripe Connect Express account if the
// caller doesn't already have one, then stores the id on /users/{uid}.
exports.createConnectAccount = functions
    .runWith({ secrets: ["STRIPE_SECRET"] })
    .https.onCall(async (_data, context) => {
    const { uid, email } = requireAuth(context);
    const stripe = new stripe_1.default(STRIPE_SECRET.value(), { apiVersion: "2023-10-16" });
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
        stripeAccountId: account.id,
        onboardingStatus: "pending",
        detailsSubmitted: false,
        chargesEnabled: false,
        payoutsEnabled: false,
        onboardingUpdatedAt: admin.firestore.Timestamp.now(),
    }, { merge: true });
    functions.logger.info(`createConnectAccount: ${uid} -> ${account.id}`);
    return { ok: true, stripeAccountId: account.id, existing: false };
});
// createConnectOnboardingLink({ mode: 'onboarding' | 'update' })
exports.createConnectOnboardingLink = functions
    .runWith({ secrets: ["STRIPE_SECRET"] })
    .https.onCall(async (data, context) => {
    const { uid } = requireAuth(context);
    const stripe = new stripe_1.default(STRIPE_SECRET.value(), { apiVersion: "2023-10-16" });
    const mode = data?.mode === "update" ? "account_update" : "account_onboarding";
    const userSnap = await db.collection("users").doc(uid).get();
    const stripeAccountId = userSnap.data()?.stripeAccountId;
    if (!stripeAccountId) {
        throw new functions.https.HttpsError("failed-precondition", "No Connect account. Call createConnectAccount first.");
    }
    const link = await stripe.accountLinks.create({
        account: stripeAccountId,
        refresh_url: `${SITE_URL}/creator-dashboard.html?connect=refresh`,
        return_url: `${SITE_URL}/creator-dashboard.html?connect=return`,
        type: mode,
    });
    return { ok: true, url: link.url, expiresAt: link.expires_at };
});
// checkConnectStatus(): re-reads the account from Stripe and mirrors flags.
exports.checkConnectStatus = functions
    .runWith({ secrets: ["STRIPE_SECRET"] })
    .https.onCall(async (_data, context) => {
    const { uid } = requireAuth(context);
    const stripe = new stripe_1.default(STRIPE_SECRET.value(), { apiVersion: "2023-10-16" });
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    const stripeAccountId = userSnap.data()?.stripeAccountId;
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
    let nextPayoutDate = null;
    try {
        const payouts = await stripe.payouts.list({ limit: 1, status: "pending" }, { stripeAccount: stripeAccountId });
        if (payouts.data.length) {
            nextPayoutDate = payouts.data[0].arrival_date;
        }
    }
    catch (err) {
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
exports.adminListCreatorsPayoutStatus = functions.https.onCall(async (_data, context) => {
    const actor = await requireAdmin(context);
    const snap = await db.collection("users").get();
    const rows = snap.docs.map((d) => {
        const u = d.data() || {};
        return {
            uid: d.id,
            email: u.email || "",
            role: u.role || "user",
            stripeAccountId: u.stripeAccountId || null,
            onboardingStatus: u.onboardingStatus || null,
            payoutsEnabled: !!u.payoutsEnabled,
            chargesEnabled: !!u.chargesEnabled,
            detailsSubmitted: !!u.detailsSubmitted,
        };
    });
    await writeAdminAudit("listCreatorsPayoutStatus", actor, { count: rows.length });
    return { creators: rows };
});
//# sourceMappingURL=index.js.map