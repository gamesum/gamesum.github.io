"use strict";
/**
 * AFTERGLO remote support — the server side of the controller check-in
 * (firmware 1.4.0+, lib/agcore/agcloud.h holds the device side).
 *
 * SECURITY MODEL
 *  - Controllers call in; nothing here can call a controller. A controller
 *    checks in every 10 minutes (every 15 seconds while a support session is
 *    open) and collects any commands queued for it.
 *  - Each controller authenticates with its own 256-bit secret, generated on
 *    the device. Only its SHA-256 is stored (supportDevices/{id}.secretHash).
 *    The first check-in from a MAC enrolls it; an admin can reset that.
 *  - Commands are limited TWICE: by ALLOWED below (so the panel cannot even
 *    queue anything else), and by the firmware's own allowlist, which is the
 *    one that matters — it holds even if this server or an admin account is
 *    compromised. Neither allows network/WiFi, firmware, time or device
 *    identity changes, and no route on the controller exposes WiFi passwords.
 *  - The controller strips the home location before anything is sent; this
 *    side strips it again before storing.
 *  - Data is admin-read-only (firestore.rules) and every command records who
 *    queued it. Diagnostics are dropped when the customer switches remote
 *    support off.
 *
 * Firestore:
 *   supportDevices/{macHex}            one per controller (admin read only)
 *   supportDevices/{macHex}/commands/* queued/sent/done/failed/expired
 *   supportCheckinIp/{ipHash_hour}     abuse counter
 */
const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const crypto = require("crypto");
const db = () => admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const OWNER_EMAIL = "shaneward852@gmail.com";
const MAC = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;
const DEVICE_ID = /^[0-9a-f]{12}$/;
const SECRET = /^[0-9a-f]{64}$/;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_FIELD_BYTES = 24 * 1024;
const MAX_COMMAND_BODY = 12 * 1024;
// The controller refuses any reply over 16 KB (kCloudMaxReplyBytes) without
// reading it, so commands are packed into replies well under that.
const MAX_REPLY_BYTES = 14 * 1024;
const MAX_RESULT_BODY = 2048;
const COMMANDS_PER_REPLY = 8;
const COMMAND_TTL_MS = 24 * 3600 * 1000;
const POLL_IDLE_S = 600;
const POLL_SESSION_S = 15;
const SESSION_DEFAULT_MIN = 30;
const SESSION_MAX_MIN = 120;
// Applies only to traffic that is NOT an already-enrolled controller with its
// right secret (enrollments and failed secrets), so an enrolled controller is
// never throttled and a neighbourhood behind one shared IP still works.
const UNVERIFIED_PER_IP_HOURLY = 30;
const SENT_REPLY_TIMEOUT_MS = 60 * 60 * 1000;
// Mirror of the firmware allowlist (agcloud.cpp remoteCommandAllowed). Keep the
// two in step; the firmware wins if they ever disagree.
function plainId(s) {
    return typeof s === "string" && /^[A-Za-z0-9_-]{1,48}$/.test(s);
}
function commandAllowed(method, path) {
    if (typeof method !== "string" || typeof path !== "string")
        return false;
    if (path.length > 96 || path.includes("?") || path.includes("..") || path.includes("//"))
        return false;
    const tail = (p) => path.startsWith(p) ? path.slice(p.length) : null;
    if (method === "GET") {
        return ["/api/v1/state", "/api/v1/presets", "/api/v1/patterns", "/api/v1/schedules",
            "/api/v1/schedules/status", "/api/v1/leds", "/api/v1/segments", "/api/v1/connect"]
            .includes(path) || plainId(tail("/api/v1/patterns/"));
    }
    const one = (...ms) => ms.includes(method);
    if (path === "/api/v1/state")
        return one("PATCH", "POST");
    if (path === "/api/v1/presets/apply")
        return method === "POST";
    if (path === "/api/v1/patterns")
        return method === "POST";
    if (tail("/api/v1/patterns/") !== null)
        return one("PUT", "DELETE") && plainId(tail("/api/v1/patterns/"));
    if (path === "/api/v1/schedules")
        return one("PUT", "POST");
    if (path === "/api/v1/leds")
        return one("PUT", "POST");
    if (path === "/api/v1/segments")
        return one("PUT", "POST");
    if (tail("/api/v1/segments/") !== null)
        return one("PATCH", "POST") && plainId(tail("/api/v1/segments/"));
    if (path === "/api/v1/locate")
        return one("POST", "PUT", "DELETE");
    if (path === "/cloud/restart")
        return method === "POST";
    return false;
}
function sha256Hex(s) {
    return crypto.createHash("sha256").update(s).digest("hex");
}
function sameHash(a, b) {
    if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length)
        return false;
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
/** Remove the home location at any depth. */
function scrub(v) {
    if (Array.isArray(v))
        return v.map(scrub);
    if (v && typeof v === "object") {
        const out = {};
        for (const [k, x] of Object.entries(v)) {
            if (["latitude", "longitude", "lat", "lon", "password", "pass", "wifi_pass"].includes(k))
                continue;
            out[k] = scrub(x);
        }
        return out;
    }
    return v;
}
/** A snapshot field stored as a JSON string: no device-chosen Firestore keys. */
function field(v) {
    if (v === undefined || v === null)
        return null;
    const s = JSON.stringify(scrub(v));
    return s.length > MAX_FIELD_BYTES ? JSON.stringify({ truncated: true }) : s;
}
function clean(s, max) {
    return String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}
function clientIpHash(req) {
    const ip = String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
    return sha256Hex("ag-support-ip:" + ip).slice(0, 24);
}
async function ipAllowed(req, limit) {
    const hour = new Date().toISOString().slice(0, 13);
    const ref = db().collection("supportCheckinIp").doc(`${clientIpHash(req)}_${hour}`);
    return db().runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const n = snap.exists ? snap.data().n || 0 : 0;
        if (n >= limit)
            return false;
        tx.set(ref, {
            n: n + 1,
            expireAt: admin.firestore.Timestamp.fromMillis(Date.now() + 2 * 3600 * 1000),
        }, { merge: true });
        return true;
    });
}
// ── Controller check-in ──────────────────────────────────────────────────────
exports.deviceCheckin = onRequest({ region: "us-central1", memory: "256MiB", maxInstances: 10, timeoutSeconds: 30, cors: false }, async (req, res) => {
    try {
        if (req.method !== "POST") {
            res.status(405).json({ error: "method" });
            return;
        }
        const mac = String(req.headers["x-ag-mac"] || "").toUpperCase();
        // A custom header, not Authorization: Google's front end treats a Bearer
        // value there as a Google identity token and rejects it before this runs.
        const secret = String(req.headers["x-ag-secret"] || "");
        if (!MAC.test(mac) || !SECRET.test(secret)) {
            res.status(400).json({ error: "bad request" });
            return;
        }
        const raw = req.rawBody ? req.rawBody.length : 0;
        if (raw > MAX_BODY_BYTES) {
            res.status(413).json({ error: "too large" });
            return;
        }
        const body = req.body && typeof req.body === "object" ? req.body : {};
        const id = mac.replace(/:/g, "").toLowerCase();
        const ref = db().collection("supportDevices").doc(id);
        const hash = sha256Hex(secret);
        const now = Date.now();
        // Anything other than a known controller with its right secret counts
        // against the per-IP budget: that is where abuse would come from
        // (spamming fake enrollments, guessing secrets).
        const pre = await ref.get();
        const preD = pre.exists ? pre.data() : null;
        const known = !!(preD && preD.secretHash && sameHash(preD.secretHash, hash));
        if (!known && !(await ipAllowed(req, UNVERIFIED_PER_IP_HOURLY))) {
            res.status(429).json({ error: "slow down" });
            return;
        }
        // Authenticate (and enroll on first contact) in one transaction, so two
        // racing first check-ins cannot both enroll. A wrong secret is counted
        // for the panel but never locks the controller out: the right secret
        // always works, so nobody can deny service just by knowing a MAC.
        const verdict = await db().runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            const d = snap.exists ? snap.data() : null;
            if (d && d.blocked === true)
                return { code: 410 };
            if (!d || !d.secretHash) {
                tx.set(ref, {
                    mac,
                    secretHash: hash,
                    enrolledAt: FieldValue.serverTimestamp(),
                    authFailures: 0,
                }, { merge: true });
                return { code: 200, enrolled: true, d: d || {} };
            }
            if (!sameHash(d.secretHash, hash)) {
                tx.update(ref, {
                    authFailures: FieldValue.increment(1),
                    lastAuthFailureAt: FieldValue.serverTimestamp(),
                });
                return { code: 401 };
            }
            return { code: 200, d };
        });
        if (verdict.code !== 200) {
            res.status(verdict.code).json({ error: "refused" });
            return;
        }
        // The customer switched remote support off: keep only the enrollment.
        if (body.optOut === true) {
            await ref.set({
                optedOut: true,
                optedOutAt: FieldValue.serverTimestamp(),
                lastSeen: FieldValue.serverTimestamp(),
                snapshot: FieldValue.delete(),
                supportUntil: FieldValue.delete(),
            }, { merge: true });
            const queued = await ref.collection("commands").where("status", "in", ["queued", "sent"]).get();
            const b = db().batch();
            queued.forEach((c) => b.update(c.ref, { status: "cancelled", doneAt: FieldValue.serverTimestamp(),
                result: { status: 0, body: "customer switched remote support off" } }));
            await b.commit();
            res.status(200).json({ poll: 3600, commands: [] });
            return;
        }
        const device = body.device && typeof body.device === "object" ? body.device : {};
        await ref.set({
            mac,
            lastSeen: FieldValue.serverTimestamp(),
            optedOut: false,
            name: clean(device.name, 64),
            prop: clean(device.prop, 16),
            fw: clean(device.fw || req.headers["x-ag-fw"], 16),
            snapshot: {
                device: field(device),
                state: field(body.state),
                leds: field(body.leds),
                segments: field(body.segments),
                schedule: field(body.schedule),
                diag: field(body.diag),
            },
        }, { merge: true });
        // Results for commands sent earlier.
        const results = Array.isArray(body.results) ? body.results.slice(0, 16) : [];
        for (const r of results) {
            const cid = clean(r && r.id, 40);
            if (!/^[A-Za-z0-9]{1,40}$/.test(cid))
                continue;
            const cref = ref.collection("commands").doc(cid);
            const status = Number.isInteger(r.status) ? r.status : 0;
            await db().runTransaction(async (tx) => {
                const c = await tx.get(cref);
                if (!c.exists || c.data().status !== "sent")
                    return;
                tx.update(cref, {
                    status: status >= 200 && status < 300 ? "done" : "failed",
                    doneAt: FieldValue.serverTimestamp(),
                    result: { status, body: clean(r.body, MAX_RESULT_BODY) },
                });
            });
        }
        // Sent but never answered (the controller restarted mid-command, or the
        // reply was lost): close them out so the panel does not wait forever.
        const sentSnap = await ref.collection("commands").where("status", "==", "sent").limit(20).get();
        const stale = sentSnap.docs.filter((c) => now - (c.data().sentAt?.toMillis?.() || now) > SENT_REPLY_TIMEOUT_MS);
        if (stale.length) {
            const sb = db().batch();
            stale.forEach((c) => sb.update(c.ref, { status: "no-reply", doneAt: FieldValue.serverTimestamp() }));
            await sb.commit();
        }
        // Hand out queued commands, oldest first; expire stale ones.
        const queuedSnap = await ref.collection("commands").where("status", "==", "queued").limit(50).get();
        const queued = queuedSnap.docs
            .map((c) => ({ ref: c.ref, id: c.id, ...c.data() }))
            .sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0));
        const out = [];
        let replyBytes = 64;
        const batch = db().batch();
        for (const c of queued) {
            const age = now - (c.createdAt?.toMillis?.() || now);
            if (age > COMMAND_TTL_MS || !commandAllowed(c.method, c.path)) {
                batch.update(c.ref, { status: "expired", doneAt: FieldValue.serverTimestamp() });
                continue;
            }
            if (out.length >= COMMANDS_PER_REPLY)
                continue;
            const item = { id: c.id, method: c.method, path: c.path, body: c.body || "" };
            const size = Buffer.byteLength(JSON.stringify(item)) + 1;
            if (replyBytes + size > MAX_REPLY_BYTES)
                continue; // next round
            replyBytes += size;
            out.push(item);
            batch.update(c.ref, { status: "sent", sentAt: FieldValue.serverTimestamp() });
        }
        await batch.commit();
        const until = verdict.d.supportUntil?.toMillis?.() || 0;
        const more = queued.length > out.length;
        const poll = until > now || more || out.length ? POLL_SESSION_S : POLL_IDLE_S;
        res.status(200).json({ poll, commands: out });
    }
    catch (e) {
        console.error("deviceCheckin failed", String(e && e.message).slice(0, 200));
        res.status(500).json({ error: "server" });
    }
});
// ── Admin callables (the support panel in admin.html) ───────────────────────
async function requireAdmin(request) {
    const tok = request.auth && request.auth.token;
    if (!tok)
        throw new HttpsError("unauthenticated", "Sign-in required.");
    // Re-verify with revocation checked, so a removed admin is out at once.
    const header = String(request.rawRequest?.headers?.authorization || "");
    if (header.startsWith("Bearer ")) {
        try {
            await admin.auth().verifyIdToken(header.slice(7), true);
        }
        catch (_) {
            throw new HttpsError("permission-denied", "Session revoked. Sign in again.");
        }
    }
    if (tok.admin === true)
        return request.auth.uid;
    if (String(tok.email || "").toLowerCase() === OWNER_EMAIL && tok.email_verified === true) {
        return request.auth.uid;
    }
    throw new HttpsError("permission-denied", "Admin access required.");
}
function deviceIdOf(data) {
    const id = String((data && data.deviceId) || "").toLowerCase();
    if (!DEVICE_ID.test(id))
        throw new HttpsError("invalid-argument", "deviceId");
    return id;
}
async function audit(uid, email, action, target, extra) {
    try {
        await db().collection("admin_audit").add({
            actor: uid, actorEmail: email || null, action, target,
            targetCollection: "supportDevices", extra: extra || null,
            createdAt: FieldValue.serverTimestamp(),
        });
    }
    catch (e) {
        console.error("audit failed", String(e && e.message).slice(0, 200));
    }
}
const callOpts = { region: "us-central1", memory: "256MiB", maxInstances: 5 };
exports.supportQueueCommand = onCall(callOpts, async (request) => {
    const uid = await requireAdmin(request);
    const id = deviceIdOf(request.data);
    const method = String(request.data.method || "").toUpperCase();
    const path = String(request.data.path || "");
    const body = request.data.body == null ? "" : String(request.data.body);
    if (!commandAllowed(method, path))
        throw new HttpsError("invalid-argument", "That command is not allowed remotely.");
    if (body.length > MAX_COMMAND_BODY)
        throw new HttpsError("invalid-argument", "Body too large.");
    if (body) {
        try {
            JSON.parse(body);
        }
        catch (_) {
            throw new HttpsError("invalid-argument", "Body must be JSON.");
        }
    }
    const ref = db().collection("supportDevices").doc(id);
    const snap = await ref.get();
    if (!snap.exists)
        throw new HttpsError("not-found", "Unknown controller.");
    if (snap.data().optedOut === true)
        throw new HttpsError("failed-precondition", "The customer has switched remote support off.");
    const cref = ref.collection("commands").doc();
    await cref.set({
        method, path, body, status: "queued",
        note: clean(request.data.note, 200),
        createdAt: FieldValue.serverTimestamp(),
        createdBy: uid,
        createdByEmail: request.auth.token.email || null,
    });
    // A queued command opens a short session so it is picked up within ~15 s
    // of the controller's next check-in rather than waiting out the idle poll.
    const until = Date.now() + SESSION_DEFAULT_MIN * 60 * 1000;
    const cur = snap.data().supportUntil?.toMillis?.() || 0;
    if (cur < until)
        await ref.update({ supportUntil: admin.firestore.Timestamp.fromMillis(until) });
    await audit(uid, request.auth.token.email, "support_command", id, { method, path, commandId: cref.id });
    return { commandId: cref.id };
});
exports.supportSession = onCall(callOpts, async (request) => {
    const uid = await requireAdmin(request);
    const id = deviceIdOf(request.data);
    const minutes = Math.max(0, Math.min(SESSION_MAX_MIN, Number.parseInt(request.data.minutes, 10) || 0));
    const ref = db().collection("supportDevices").doc(id);
    if (!(await ref.get()).exists)
        throw new HttpsError("not-found", "Unknown controller.");
    await ref.update({
        supportUntil: minutes ? admin.firestore.Timestamp.fromMillis(Date.now() + minutes * 60000) : FieldValue.delete(),
    });
    await audit(uid, request.auth.token.email, minutes ? "support_session_start" : "support_session_end", id, { minutes });
    return { ok: true };
});
/** Forget the stored secret: the next check-in from this MAC enrolls afresh.
 *  Use after a controller is factory-reset or replaced. */
exports.supportResetEnrollment = onCall(callOpts, async (request) => {
    const uid = await requireAdmin(request);
    const id = deviceIdOf(request.data);
    const ref = db().collection("supportDevices").doc(id);
    if (!(await ref.get()).exists)
        throw new HttpsError("not-found", "Unknown controller.");
    await ref.update({
        secretHash: FieldValue.delete(), authFailures: 0,
        enrollmentResetAt: FieldValue.serverTimestamp(),
    });
    await audit(uid, request.auth.token.email, "support_reset_enrollment", id, null);
    return { ok: true };
});
exports.supportSetBlocked = onCall(callOpts, async (request) => {
    const uid = await requireAdmin(request);
    const id = deviceIdOf(request.data);
    const blocked = request.data.blocked === true;
    const ref = db().collection("supportDevices").doc(id);
    if (!(await ref.get()).exists)
        throw new HttpsError("not-found", "Unknown controller.");
    await ref.update({ blocked });
    await audit(uid, request.auth.token.email, blocked ? "support_block" : "support_unblock", id, null);
    return { ok: true };
});
// Exposed for tests only.
exports._test = { commandAllowed, scrub, field, sameHash };
//# sourceMappingURL=deviceSupport.js.map