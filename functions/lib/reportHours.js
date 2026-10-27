"use strict";
/**
 * AFTERGLO app — controller run-hours reports (Firebase Cloud Function v2 HTTPS).
 *
 * Each controller (fw 1.1.0+) keeps a lifetime odometer of seconds powered and
 * seconds lit. The app forwards it here when it talks to the controller, at
 * most every few hours, so the company has every unit's hours without a
 * site visit.
 *
 * The record for a controller (keyed by MAC) only ever goes UP: a report lower
 * than what's stored is kept as evidence (`lowReports`, `lastLowReport`) but
 * never lowers the totals — so a controller whose flash was wiped, or someone
 * sending a fake low report, can't erase the history.
 *
 * Fake HIGH reports are bounded instead: after the first report, the totals
 * can grow by at most the wall-clock time since the last accepted report plus
 * an hour of slack. Anything faster is counted in `rejectedReports` and
 * dropped.
 *
 * Abuse limits: app client header, no CORS, one accepted report per controller
 * per 10 minutes, and a per-IP hourly cap on writes.
 *
 * Read the data in the Firebase console: Firestore → controllerHours.
 */
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const crypto = require("crypto");
const db = () => admin.firestore();
const MIN_REPORT_GAP_MS = 10 * 60 * 1000;
const GROWTH_SLACK_S = 3600;
const FIRST_REPORT_MAX_S = 20 * 365 * 24 * 3600; // 20 years
const PER_IP_HOURLY = 30;
const LOW_REPORT_TOLERANCE_S = 600; // one firmware save interval
const MAC = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;
function seconds(v) {
    // Number(null) and Number("") are 0 — a missing field must not read as zero.
    if (typeof v !== "number" && !(typeof v === "string" && /^\d+$/.test(v)))
        return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 0xFFFFFFFF)
        return null;
    return n;
}
function clean(s, max) {
    return String(s || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}
/**
 * Pure merge of a report into the stored record. Returns { doc, outcome }
 * where outcome is "created" | "updated" | "throttled" | "rejected" | "low".
 * `doc` is the full record to write, or null when nothing should be written.
 */
function mergeReport(old, rep, nowMs) {
    if (!old) {
        if (rep.poweredSeconds > FIRST_REPORT_MAX_S) {
            return { doc: null, outcome: "rejected" };
        }
        return {
            outcome: "created",
            doc: {
                mac: rep.mac,
                litSeconds: Math.min(rep.litSeconds, rep.poweredSeconds),
                poweredSeconds: rep.poweredSeconds,
                fw: rep.fw,
                name: rep.name,
                firstSeenMs: nowMs,
                updatedAtMs: nowMs,
                reports: 1,
                lowReports: 0,
                rejectedReports: 0,
            },
        };
    }
    const elapsedMs = nowMs - (old.updatedAtMs || 0);
    if (elapsedMs < MIN_REPORT_GAP_MS)
        return { doc: null, outcome: "throttled" };
    const allowed = Math.floor(Math.max(0, elapsedMs) / 1000) + GROWTH_SLACK_S;
    const doc = { ...old, fw: rep.fw || old.fw, name: rep.name || old.name };
    if (rep.poweredSeconds - old.poweredSeconds > allowed ||
        rep.litSeconds - old.litSeconds > allowed) {
        doc.rejectedReports = (old.rejectedReports || 0) + 1;
        doc.lastRejectedReport = { poweredSeconds: rep.poweredSeconds, litSeconds: rep.litSeconds, atMs: nowMs };
        return { doc, outcome: "rejected" };
    }
    let outcome = "updated";
    if (rep.poweredSeconds < old.poweredSeconds - LOW_REPORT_TOLERANCE_S) {
        // The controller has fewer hours than we've already recorded: its flash
        // was erased or the board swapped. Keep the history, note the event.
        doc.lowReports = (old.lowReports || 0) + 1;
        doc.lastLowReport = { poweredSeconds: rep.poweredSeconds, litSeconds: rep.litSeconds, atMs: nowMs };
        outcome = "low";
    }
    doc.poweredSeconds = Math.max(old.poweredSeconds, rep.poweredSeconds);
    doc.litSeconds = Math.min(doc.poweredSeconds, Math.max(old.litSeconds, Math.min(rep.litSeconds, rep.poweredSeconds)));
    doc.updatedAtMs = nowMs;
    doc.reports = (old.reports || 0) + 1;
    return { doc, outcome };
}
async function ipAllowed(ip) {
    const hour = new Date().toISOString().slice(0, 13);
    const ipKey = crypto.createHash("sha256").update("ip|" + ip).digest("hex").slice(0, 32);
    const ref = db().collection("controllerHoursQuota").doc(`a_${ipKey}_${hour}`);
    return db().runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const n = snap.exists ? snap.data().n || 0 : 0;
        if (n >= PER_IP_HOURLY)
            return false;
        tx.set(ref, {
            n: n + 1,
            expireAt: admin.firestore.Timestamp.fromMillis(Date.now() + 2 * 3600 * 1000),
        });
        return true;
    });
}
exports.reportHours = onRequest({ cors: false, timeoutSeconds: 15, memory: "256MiB", maxInstances: 3 }, async (req, res) => {
    if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    if (!String(req.headers["x-ag-client"] || "").startsWith("afterglo-app/")) {
        res.status(403).json({ error: "Forbidden" });
        return;
    }
    const b = req.body || {};
    const mac = String(b.mac || "").toUpperCase();
    const litSeconds = seconds(b.litSeconds);
    const poweredSeconds = seconds(b.poweredSeconds);
    if (!MAC.test(mac) || mac === "00:00:00:00:00:00" ||
        litSeconds === null || poweredSeconds === null) {
        res.status(400).json({ error: "Bad request" });
        return;
    }
    const rep = {
        mac,
        litSeconds,
        poweredSeconds,
        fw: clean(b.fw, 24),
        name: clean(b.name, 40),
    };
    const ip = String(req.headers["x-forwarded-for"] || req.ip || "unknown").split(",")[0].trim();
    try {
        if (!(await ipAllowed(ip))) {
            res.status(429).json({ error: "Too many reports" });
            return;
        }
        const ref = db().collection("controllerHours").doc(mac.replace(/:/g, ""));
        const outcome = await db().runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            const r = mergeReport(snap.exists ? snap.data() : null, rep, Date.now());
            if (r.doc)
                tx.set(ref, r.doc);
            return r.outcome;
        });
        res.json({ ok: true, outcome });
    }
    catch (e) {
        console.error("reportHours failed", String(e && e.message).slice(0, 200));
        res.status(503).json({ error: "Unavailable" });
    }
});
// Exported for unit tests.
exports._test = { mergeReport, seconds };
//# sourceMappingURL=reportHours.js.map