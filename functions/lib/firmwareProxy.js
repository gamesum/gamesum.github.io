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
exports.firmwareBin = exports.firmwareManifest = void 0;
// Serves AFTERGLO controller firmware to the browser-based flasher at
// afterglolighting.org/firmware.html.
//
// WHY THIS EXISTS: the browser cannot fetch GitHub release assets directly.
// github.com/.../releases/download/... redirects to an Azure-backed host that
// sends no Access-Control-Allow-Origin header, so a cross-origin fetch() from
// our page fails with an opaque "Failed to fetch". Server-to-server requests
// aren't subject to CORS, so we fetch it here and hand it back same-origin.
//
// SHARED CONTRACT: the manifest shape below is also consumed by the AFTERGLO
// app (gamesum/Afterglo-Fable, app/lib/data/firmware_update_service.dart) and
// by docs/firmware.html. If gamesum/firmware-update changes its schema, all
// three break — see the comments in those files.
const functions = __importStar(require("firebase-functions"));
const MANIFEST_URL = "https://raw.githubusercontent.com/gamesum/firmware-update/main/afterglo2_manifest.json";
const SITE_URL = "https://afterglolighting.org";
// Fixture families we're willing to serve. Keep in sync with the picker in
// docs/firmware.html — a family here that the page doesn't offer is harmless,
// but the reverse silently 404s for the customer.
const ALLOWED_FAMILIES = new Set(["roofline", "arch", "tree"]);
async function loadManifest() {
    const res = await fetch(MANIFEST_URL, { cache: "no-store" });
    if (!res.ok)
        throw new Error(`manifest fetch failed: HTTP ${res.status}`);
    return (await res.json());
}
async function sha256Hex(buf) {
    const { createHash } = await Promise.resolve().then(() => __importStar(require("crypto")));
    return createHash("sha256").update(Buffer.from(buf)).digest("hex");
}
// GET /api/firmware/manifest  →  { version, families: [...] }
exports.firmwareManifest = functions.https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", SITE_URL);
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    if (req.method === "OPTIONS") {
        res.status(204).send("");
        return;
    }
    if (req.method !== "GET") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    try {
        const manifest = await loadManifest();
        const families = Object.keys(manifest.images || {}).filter((f) => ALLOWED_FAMILIES.has(f));
        // Short cache: new firmware should reach customers quickly, but we don't
        // need to hit GitHub on every page load.
        res.set("Cache-Control", "public, max-age=300, s-maxage=300");
        res.status(200).json({ version: manifest.version, families });
    }
    catch (err) {
        functions.logger.error("firmwareManifest error", err);
        res.status(502).json({ error: "Could not reach the firmware feed." });
    }
});
// GET /api/firmware/bin?family=roofline  →  the .bin bytes
exports.firmwareBin = functions
    .runWith({ memory: "512MB", timeoutSeconds: 120 })
    .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", SITE_URL);
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    if (req.method === "OPTIONS") {
        res.status(204).send("");
        return;
    }
    if (req.method !== "GET") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    const family = String(req.query.family || "").toLowerCase();
    if (!ALLOWED_FAMILIES.has(family)) {
        res.status(400).json({ error: "Unknown fixture family." });
        return;
    }
    try {
        const manifest = await loadManifest();
        const image = manifest.images?.[family];
        if (!image) {
            res.status(404).json({ error: "No build published for this fixture yet." });
            return;
        }
        const binRes = await fetch(image.url);
        if (!binRes.ok)
            throw new Error(`asset fetch failed: HTTP ${binRes.status}`);
        const buf = await binRes.arrayBuffer();
        // Verify before serving: if the feed and the asset ever disagree, we
        // refuse rather than hand a customer's controller an unexpected image.
        const got = await sha256Hex(buf);
        if (got !== image.sha256.toLowerCase()) {
            functions.logger.error("firmwareBin checksum mismatch", {
                family, expected: image.sha256, got,
            });
            res.status(502).json({ error: "Firmware failed verification upstream." });
            return;
        }
        res.set("Content-Type", "application/octet-stream");
        res.set("Content-Disposition", `attachment; filename="${image.asset}"`);
        res.set("X-Afterglo-Firmware-Version", manifest.version);
        res.set("X-Afterglo-Firmware-Sha256", image.sha256);
        res.set("Cache-Control", "public, max-age=300, s-maxage=300");
        res.status(200).send(Buffer.from(buf));
    }
    catch (err) {
        functions.logger.error("firmwareBin error", err);
        res.status(502).json({ error: "Could not fetch firmware." });
    }
});
//# sourceMappingURL=firmwareProxy.js.map