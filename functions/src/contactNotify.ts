import { FieldValue, getFirestore } from "firebase-admin/firestore";
import * as functions from "firebase-functions";
import { defineSecret } from "firebase-functions/params";
import * as nodemailer from "nodemailer";

// Website leads are emailed straight to the inbox from here. This replaced a
// relay to a Zapier webhook, whose only job was to send this same email.
//
// Sends through Gmail with an app password (Google Account -> Security ->
// 2-Step Verification -> App passwords), stored as a secret:
//   firebase functions:secrets:set GMAIL_APP_PASSWORD
const GMAIL_APP_PASSWORD = defineSecret("GMAIL_APP_PASSWORD");

// Each quote request also becomes a customer in Porchlight (the CRM, project
// porchlight-f1d62). The key is Porchlight's private/webLeads.key:
//   firebase functions:secrets:set PORCHLIGHT_LEAD_KEY
const PORCHLIGHT_LEAD_KEY = defineSecret("PORCHLIGHT_LEAD_KEY");
const PORCHLIGHT_WEB_LEAD = "https://us-central1-porchlight-f1d62.cloudfunctions.net/webLead";

const INBOX = "afterglolights@gmail.com";
const TZ = "America/Denver";

type Row = [label: string, value: string, href?: string];

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const str = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);

const when = () =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(new Date());

/** Sends one lead email. Reply-To is the lead, so hitting Reply answers them. */
async function sendLeadEmail(opts: { subject: string; heading: string; rows: Row[]; replyTo?: string }) {
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

const tel = (p: string) => (p.replace(/\D/g, "").length >= 10 ? `tel:${p.replace(/[^\d+]/g, "")}` : undefined);
const maps = (a: string) => (a ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a)}` : undefined);
const mailto = (e: string) => (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? `mailto:${e}` : undefined);

/**
 * Sends one contact submission to Porchlight, which files it as a customer
 * tagged Website (id w<submission id>, so a re-send never duplicates).
 * Exported for the backfill script.
 */
export async function sendToPorchlight(id: string, d: Record<string, unknown>, key: string) {
  const a: Record<string, unknown> = d.attribution && typeof d.attribution === "object" ? d.attribution as Record<string, unknown> : {};
  const r = await fetch(PORCHLIGHT_WEB_LEAD, {
    method: "POST",
    headers: { "content-type": "application/json", "x-lead-key": key },
    body: JSON.stringify({
      id,
      name: str(d.name, 200),
      email: str(d.email, 320),
      phone: str(d.phone, 40),
      street: str(d.addressStreet, 200) || str(d.address, 300),
      city: str(d.addressCity, 100),
      state: str(d.addressState, 50),
      zip: str(d.addressZip, 20),
      source: str(d.source, 100) || "contact form",
      interest: str(d.interest, 100),
      message: str(d.message, 5000),
      utmSource: str(a.utm_source, 60),
      utmCampaign: str(a.utm_campaign, 80),
      // Ad click ids for Meta's Conversions API, so a later sale matches the ad.
      fbclid: str(a.fbclid, 200),
      fbp: str(a.fbp, 200),
      fbc: str(a.fbc, 200),
      // Google Ads click ids, for uploading a later sale as an offline conversion.
      gclid: str(a.gclid, 200),
      gbraid: str(a.gbraid, 200),
      wbraid: str(a.wbraid, 200),
      // The text-message consent shown beside the submit button. Porchlight's
      // automated texts go only to leads with smsConsent.
      smsConsent: !!str(d.consentText, 600),
      consentText: str(d.consentText, 600),
      userAgent: str(d.userAgent, 400),
      submittedAt: (d.submittedAt as { toMillis?: () => number } | undefined)?.toMillis?.() || Date.now(),
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`Porchlight webLead ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

/** Quote requests: landing page, contact page, Model Home page, mockup offer page. */
export const onContactSubmissionCreated = functions
  .runWith({ secrets: ["GMAIL_APP_PASSWORD", "PORCHLIGHT_LEAD_KEY"] })
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
    const a: Record<string, unknown> = d.attribution && typeof d.attribution === "object" ? d.attribution : {};
    const at = (k: string) => str(a[k], 200);

    // Into Porchlight, alongside the email. A failure here never blocks the email.
    const crm = (async () => {
      const key = PORCHLIGHT_LEAD_KEY.value();
      if (!key || key === "unset") return functions.logger.warn("PORCHLIGHT_LEAD_KEY not set; lead not sent to Porchlight");
      try {
        const r = await sendToPorchlight(context.params.submissionId, d, key);
        functions.logger.info(`lead ${context.params.submissionId} sent to Porchlight`, r);
      } catch (err) {
        functions.logger.error("Porchlight lead failed", err);
      }
    })();

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
          ["Google click", at("gclid") || at("gbraid") || at("wbraid") ? "Yes" : ""],
          ["Agreed to texts", str(d.consentText, 600) ? "Yes" : ""],
          ["Landing page", at("landingPath")],
          ["Referrer", at("referrer")],
          ["Lead id", context.params.submissionId],
        ],
      });
      functions.logger.info(`lead email sent for ${context.params.submissionId}`);
    } catch (err) {
      functions.logger.error("lead email failed", err);
    }
    await crm;
    return null;
  });

/**
 * POST /api/signup {email, action?} from the homepage email pop-up. The
 * homepage does not load the Firebase SDK, so it posts here (same origin,
 * see the hosting rewrite) and this stores the signup. Keyed by address, so
 * the same email submitted twice only emails the inbox once.
 */
export const emailSignup = functions.https.onRequest(async (req, res) => {
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
    await getFirestore().collection("email_signups").doc(email).create({
      email, action, source: "homepage", submittedAt: FieldValue.serverTimestamp(),
    });
  } catch (err: unknown) {
    // Already signed up: fine, nothing new to tell anyone.
    if ((err as { code?: number }).code !== 6) functions.logger.error("emailSignup store failed", err);
  }
  res.json({ ok: true });
});

/** Homepage "be the first to hear" email signups. */
export const onEmailSignupCreated = functions
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
    } catch (err) {
      functions.logger.error("signup email failed", err);
    }
    return null;
  });

/** Giveaway entries, only the ones who asked for a quote. */
export const onGiveawayEntryCreated = functions
  .runWith({ secrets: ["GMAIL_APP_PASSWORD"] })
  .firestore.document("giveaway_entries/{phone}")
  .onCreate(async (snap) => {
    const d = snap.data() || {};
    if (d.wantsQuote !== true && d.wantsQuote !== "yes") return null;
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
    } catch (err) {
      functions.logger.error("giveaway email failed", err);
    }
    return null;
  });
