import * as functions from "firebase-functions";
import { defineSecret } from "firebase-functions/params";
import * as nodemailer from "nodemailer";

const GMAIL_APP_PASSWORD = defineSecret("GMAIL_APP_PASSWORD");
const ZAPIER_CONTACT_WEBHOOK_URL = defineSecret("ZAPIER_CONTACT_WEBHOOK_URL");
const NOTIFY_TO = "afterglolights@gmail.com";
const NOTIFY_FROM = "afterglolights@gmail.com";

export const onContactSubmissionCreated = functions
  .runWith({ secrets: ["GMAIL_APP_PASSWORD", "ZAPIER_CONTACT_WEBHOOK_URL"] })
  .firestore.document("contact_submissions/{submissionId}")
  .onCreate(async (snap, context) => {
    const data = snap.data() || {};
    const submissionId = context.params.submissionId;
    const name = String(data.name || "").slice(0, 200);
    const email = String(data.email || "").slice(0, 320);
    const phone = String(data.phone || "").slice(0, 40);
    const address = String(data.address || "").slice(0, 300);
    const interest = String(data.interest || "").slice(0, 100);
    const message = String(data.message || "").slice(0, 5000);

    const subject = `New Contact Form Lead — ${name || "Unknown"} (${interest || "Not Sure"})`;
    const text = [
      "New lead from afterglolighting.org/contact.html", "",
      `Name: ${name}`, `Phone: ${phone}`, `Email: ${email}`,
      `Interested In: ${interest}`, `Address / City: ${address}`,
      `Message: ${message || "(none)"}`, "",
      `Submission ID: ${submissionId}`,
    ].join("\n");

    try {
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: NOTIFY_FROM, pass: GMAIL_APP_PASSWORD.value() },
      });
      await transporter.sendMail({
        from: `Afterglo Website <${NOTIFY_FROM}>`,
        to: NOTIFY_TO,
        replyTo: email || undefined,
        subject,
        text,
      });
      functions.logger.info(`onContactSubmissionCreated: emailed lead ${submissionId}`);
    } catch (err) {
      functions.logger.error("onContactSubmissionCreated: email send failed", err);
    }

    const zapierUrl = ZAPIER_CONTACT_WEBHOOK_URL.value();
    if (zapierUrl && zapierUrl !== "unset") {
      try {
        const res = await fetch(zapierUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source: "contact form",
            submissionId, name, email, phone, address, interest, message,
            submittedAt: new Date().toISOString(),
          }),
        });
        functions.logger.info(`onContactSubmissionCreated: Zapier responded ${res.status}`);
      } catch (err) {
        functions.logger.error("onContactSubmissionCreated: Zapier webhook failed", err);
      }
    }

    return null;
  });
