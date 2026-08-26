import * as functions from "firebase-functions";
import { defineSecret } from "firebase-functions/params";

const ZAPIER_CONTACT_WEBHOOK_URL = defineSecret("ZAPIER_CONTACT_WEBHOOK_URL");

// Zapier handles all outbound notification emails for contact form leads.
// This function's only job is to relay the new submission to the Zapier
// catch webhook; Zapier's own automation takes it from there.
export const onContactSubmissionCreated = functions
  .runWith({ secrets: ["ZAPIER_CONTACT_WEBHOOK_URL"] })
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
        functions.logger.info(`onContactSubmissionCreated: Zapier responded ${res.status} for ${submissionId}`);
      } catch (err) {
        functions.logger.error("onContactSubmissionCreated: Zapier webhook failed", err);
      }
    } else {
      functions.logger.warn(`onContactSubmissionCreated: ZAPIER_CONTACT_WEBHOOK_URL not configured, skipped ${submissionId}`);
    }

    return null;
  });
