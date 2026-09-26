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
Object.defineProperty(exports, "__esModule", { value: true });
exports.onGiveawayEntryCreated = exports.onEmailSignupCreated = exports.emailSignup = exports.onContactSubmissionCreated = void 0;
const firestore_1 = require("firebase-admin/firestore");
const functions = __importStar(require("firebase-functions"));
const params_1 = require("firebase-functions/params");
const nodemailer = __importStar(require("nodemailer"));
// Website leads are emailed straight to the inbox from here. This replaced a
// relay to a Zapier webhook, whose only job was to send this same email.
//
// Sends through Gmail with an app password (Google Account -> Security ->
// 2-Step Verification -> App passwords), stored as a secret:
//   firebase functions:secrets:set GMAIL_APP_PASSWORD
const GMAIL_APP_PASSWORD = (0, params_1.defineSecret)("GMAIL_APP_PASSWORD");
const INBOX = "afterglolights@gmail.com";
const TZ = "America/Denver";
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const str = (v, max) => String(v ?? "").trim().slice(0, max);
const when = () => new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
}).format(new Date());
/** Sends one lead email. Reply-To is the lead, so hitting Reply answers them. */
async function sendLeadEmail(opts) {
    const pass = GMAIL_APP_PASSWORD.value();
    if (!pass || pass === "unset") {
        functions.logger.warn("GMAIL_APP_PASSWORD not configured; lead email skipped", { subject: opts.subject });
        return;
    }
    const rows = opts.rows.filter(([, v]) => v);
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#111;max-width:600px">
<h2 style="margin:0 0 12px">${esc(opts.heading)}</h2>
<table cellpadding="6" style="border-collapse:collapse">${rows
        .map(([k, v, href]) => `<tr><td style="color:#666;vertical-align:top;white-space:nowrap">${esc(k)}</td>` +
        `<td style="vertical-align:top">${href ? `<a href="${esc(href)}">${esc(v)}</a>` : esc(v).replace(/\n/g, "<br>")}</td></tr>`)
        .join("")}</table>
<p style="color:#888;font-size:12px;margin-top:16px">Received ${esc(when())} (Mountain) from afterglolighting.org</p></div>`;
    const text = rows.map(([k, v]) => `${k}: ${v}`).join("\n");
    const mail = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth: { user: INBOX, pass },
    });
    await mail.sendMail({
        from: `"AFTERGLO Website" <${INBOX}>`,
        to: INBOX,
        replyTo: opts.replyTo || undefined,
        subject: opts.subject,
        text,
        html,
    });
}
const tel = (p) => (p.replace(/\D/g, "").length >= 10 ? `tel:${p.replace(/[^\d+]/g, "")}` : undefined);
const maps = (a) => (a ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a)}` : undefined);
const mailto = (e) => (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? `mailto:${e}` : undefined);
/** Quote requests: landing page, contact page, Model Home page. */
exports.onContactSubmissionCreated = functions
    .runWith({ secrets: ["GMAIL_APP_PASSWORD"] })
    .firestore.document("contact_submissions/{submissionId}")
    .onCreate(async (snap, context) => {
    const d = snap.data() || {};
    const name = str(d.name, 200);
    const email = str(d.email, 320);
    const phone = str(d.phone, 40);
    const street = str(d.addressStreet, 200);
    const city = str(d.addressCity, 100);
    const state = str(d.addressState, 50);
    const zip = str(d.addressZip, 20);
    const address = [street, [city, state].filter(Boolean).join(", "), zip].filter(Boolean).join(" ") || str(d.address, 300);
    const source = str(d.source, 100) || "contact form";
    // Ad attribution captured from the landing URL, which ties a lead back to
    // the ad that paid for it.
    const a = d.attribution && typeof d.attribution === "object" ? d.attribution : {};
    const at = (k) => str(a[k], 200);
    try {
        await sendLeadEmail({
            subject: `New lead: ${name || "someone"}${city ? ` (${city})` : ""} - ${source}`,
            heading: `New quote request from ${name || "the website"}`,
            replyTo: mailto(email) ? email : undefined,
            rows: [
                ["Name", name],
                ["Phone", phone, tel(phone)],
                ["Email", email, mailto(email)],
                ["Address", address, maps(address)],
                ["Interested in", str(d.interest, 100)],
                ["Best way to reach", str(d.preferredContact, 20)],
                ["Message", str(d.message, 5000)],
                ["Marketing opt-in", d.marketingOptIn === true ? "Yes" : "No"],
                ["Came from", source],
                ["Ad source", [at("utm_source"), at("utm_medium")].filter(Boolean).join(" / ")],
                ["Campaign", [at("utm_campaign"), at("utm_content"), at("utm_term")].filter(Boolean).join(" / ")],
                ["Facebook click", at("fbclid") ? "Yes" : ""],
                ["Landing page", at("landingPath")],
                ["Referrer", at("referrer")],
                ["Lead id", context.params.submissionId],
            ],
        });
        functions.logger.info(`lead email sent for ${context.params.submissionId}`);
    }
    catch (err) {
        functions.logger.error("lead email failed", err);
    }
    return null;
});
/**
 * POST /api/signup {email, action?} from the homepage email pop-up. The
 * homepage does not load the Firebase SDK, so it posts here (same origin,
 * see the hosting rewrite) and this stores the signup. Keyed by address, so
 * the same email submitted twice only emails the inbox once.
 */
exports.emailSignup = functions.https.onRequest(async (req, res) => {
    if (req.method !== "POST") {
        res.status(405).json({ error: "POST only" });
        return;
    }
    const body = typeof req.body === "object" && req.body ? req.body : {};
    const email = str(body.email, 320).toLowerCase();
    if (!/^[^@\s/]+@[^@\s/]+\.[^@\s/]+$/.test(email)) {
        res.status(400).json({ error: "Enter a valid email." });
        return;
    }
    const action = ["call", "email"].includes(str(body.action, 10)) ? str(body.action, 10) : "";
    try {
        await (0, firestore_1.getFirestore)().collection("email_signups").doc(email).create({
            email, action, source: "homepage", submittedAt: firestore_1.FieldValue.serverTimestamp(),
        });
    }
    catch (err) {
        // Already signed up: fine, nothing new to tell anyone.
        if (err.code !== 6)
            functions.logger.error("emailSignup store failed", err);
    }
    res.json({ ok: true });
});
/** Homepage "be the first to hear" email signups. */
exports.onEmailSignupCreated = functions
    .runWith({ secrets: ["GMAIL_APP_PASSWORD"] })
    .firestore.document("email_signups/{signupId}")
    .onCreate(async (snap) => {
    const d = snap.data() || {};
    const email = str(d.email, 320);
    const action = str(d.action, 20);
    try {
        await sendLeadEmail({
            subject: `New email signup: ${email}`,
            heading: "New email signup from the homepage",
            replyTo: mailto(email) ? email : undefined,
            rows: [
                ["Email", email, mailto(email)],
                ["Was about to", action === "call" ? "Call you" : action ? "Email you" : ""],
                ["Came from", str(d.source, 100) || "homepage"],
            ],
        });
    }
    catch (err) {
        functions.logger.error("signup email failed", err);
    }
    return null;
});
/** Giveaway entries, only the ones who asked for a quote. */
exports.onGiveawayEntryCreated = functions
    .runWith({ secrets: ["GMAIL_APP_PASSWORD"] })
    .firestore.document("giveaway_entries/{phone}")
    .onCreate(async (snap) => {
    const d = snap.data() || {};
    if (d.wantsQuote !== true && d.wantsQuote !== "yes")
        return null;
    const name = str(d.name, 200);
    const email = str(d.email, 320);
    const phone = str(d.phone, 20);
    const address = [str(d.addressStreet, 200), str(d.addressCity, 100), "UT", str(d.addressZip, 20)]
        .filter(Boolean).join(", ");
    try {
        await sendLeadEmail({
            subject: `Giveaway entry wants a quote: ${name}`,
            heading: `${name || "A giveaway entrant"} entered the giveaway and wants a quote`,
            replyTo: mailto(email) ? email : undefined,
            rows: [
                ["Name", name],
                ["Phone", phone, tel(phone)],
                ["Email", email, mailto(email)],
                ["Address", address, maps(address)],
                ["Instagram", str(d.instagram, 60)],
                ["Owns the home", str(d.owner, 40)],
                ["Home style", str(d.homeStyle, 60)],
                ["Would use it for", Array.isArray(d.uses) ? d.uses.join(", ") : str(d.uses, 200)],
            ],
        });
    }
    catch (err) {
        functions.logger.error("giveaway email failed", err);
    }
    return null;
});
//# sourceMappingURL=contactNotify.js.map