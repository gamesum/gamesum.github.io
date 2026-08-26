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
exports.onContactSubmissionCreated = void 0;
const functions = __importStar(require("firebase-functions"));
const params_1 = require("firebase-functions/params");
const ZAPIER_CONTACT_WEBHOOK_URL = (0, params_1.defineSecret)("ZAPIER_CONTACT_WEBHOOK_URL");
// Zapier handles all outbound notification emails for contact form leads.
// This function's only job is to relay the new submission to the Zapier
// catch webhook; Zapier's own automation takes it from there.
exports.onContactSubmissionCreated = functions
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
    const zapierUrl = ZAPIER_CONTACT_WEBHOOK_URL.value();
    if (zapierUrl && zapierUrl !== "unset") {
        try {
            const res = await fetch(zapierUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    source: "contact form",
                    submissionId, name, email, phone, address,
                    addressStreet, addressCity, addressState, addressZip,
                    interest, message,
                    submittedAt: new Date().toISOString(),
                }),
            });
            functions.logger.info(`onContactSubmissionCreated: Zapier responded ${res.status} for ${submissionId}`);
        }
        catch (err) {
            functions.logger.error("onContactSubmissionCreated: Zapier webhook failed", err);
        }
    }
    else {
        functions.logger.warn(`onContactSubmissionCreated: ZAPIER_CONTACT_WEBHOOK_URL not configured, skipped ${submissionId}`);
    }
    return null;
});
//# sourceMappingURL=contactNotify.js.map