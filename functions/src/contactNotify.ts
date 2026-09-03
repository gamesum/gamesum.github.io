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
    const addressStreet = String(data.addressStreet || "").slice(0, 200);
    const addressCity = String(data.addressCity || "").slice(0, 100);
    const addressState = String(data.addressState || "").slice(0, 50);
    const addressZip = String(data.addressZip || "").slice(0, 20);
    const interest = String(data.interest || "").slice(0, 100);
    const message = String(data.message || "").slice(0, 5000);
    const marketingOptIn = data.marketingOptIn === true;
    const source = String(data.source || "contact form").slice(0, 100);

    // Ad attribution captured from the landing URL (utm_* / fbclid). Flattened
    // alongside the raw object because Zapier maps top level fields far more
    // easily than nested ones, and this is what ties a lead back to the ad
    // that paid for it.
    const attribution: Record<string, string> =
      data.attribution && typeof data.attribution === "object" ? data.attribution : {};
    const attr = (k: string) => String(attribution[k] || "").slice(0, 200);

    const zapierUrl = ZAPIER_CONTACT_WEBHOOK_URL.value();
    if (zapierUrl && zapierUrl !== "unset") {
      try {
        const res = await fetch(zapierUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source,
            submissionId, name, email, phone, address,
            addressStreet, addressCity, addressState, addressZip,
            interest, message, marketingOptIn,
            utmSource: attr("utm_source"),
            utmMedium: attr("utm_medium"),
            utmCampaign: attr("utm_campaign"),
            utmContent: attr("utm_content"),
            utmTerm: attr("utm_term"),
            fbclid: attr("fbclid"),
            landingPath: attr("landingPath"),
            referrer: attr("referrer"),
            attribution,
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
