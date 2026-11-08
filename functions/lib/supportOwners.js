"use strict";
/**
 * supportOwners — who owns these controller label serials, asked live from
 * Porchlight's controllerOwners function. Admin only. Nothing is stored on
 * the website side.
 *
 * NOT IMPORTED YET. It needs the AG_SUPPORT_LINK_KEY secret, and declaring a
 * secret that does not exist makes every functions deploy fail. To enable:
 *   1. Set the same random value in both projects:
 *        firebase functions:secrets:set AG_SUPPORT_LINK_KEY --project afterglo-website-fbb89
 *        firebase functions:secrets:set AG_SUPPORT_LINK_KEY --project porchlight-f1d62
 *   2. Porchlight: export controllerOwners (functions/controller_owners.js) and deploy it.
 *   3. Here: add `export { supportOwners } from "./supportOwners";` to index.ts
 *      and deploy functions:supportOwners.
 * Until then the admin panel shows serials without names.
 */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { _internal } = require("./deviceSupport");
const { requireAdmin, callOpts, SERIAL } = _internal;
const AG_SUPPORT_LINK_KEY = defineSecret("AG_SUPPORT_LINK_KEY");
const PORCHLIGHT_OWNERS_URL = "https://us-central1-porchlight-f1d62.cloudfunctions.net/controllerOwners";
/** Who owns these serials, asked live from Porchlight. Nothing is stored. */
exports.supportOwners = onCall({ ...callOpts, secrets: [AG_SUPPORT_LINK_KEY] }, async (request) => {
    await requireAdmin(request);
    const serials = Array.isArray(request.data && request.data.serials) ? request.data.serials : [];
    const wanted = [...new Set(serials.map((x) => String(x || "").toUpperCase()).filter((x) => SERIAL.test(x)))].slice(0, 100);
    if (!wanted.length)
        return { owners: {} };
    let r;
    try {
        r = await fetch(PORCHLIGHT_OWNERS_URL, {
            method: "POST",
            headers: { "content-type": "application/json", "x-ag-link-key": AG_SUPPORT_LINK_KEY.value() },
            body: JSON.stringify({ serials: wanted }),
            signal: AbortSignal.timeout(10000),
        });
    }
    catch (e) {
        throw new HttpsError("unavailable", "Porchlight did not answer.");
    }
    if (!r.ok)
        throw new HttpsError("unavailable", `Porchlight answered ${r.status}.`);
    const j = await r.json();
    return { owners: j && typeof j.owners === "object" ? j.owners : {} };
});
//# sourceMappingURL=supportOwners.js.map