/**
 * AFTERGLO — AI preset generator (Firebase Cloud Function v2 HTTPS).
 *
 * ⚠ TEST-MODE BUILD — read before deploying:
 *   • No Firebase Auth required (anyone who knows the URL can call this).
 *   • No App Check (no signed-app-binary requirement).
 *   • Quota keyed by client IP, not user — easy to bypass with a VPN.
 *
 * This is intentional so the device's web UI (served from the controller on
 * the customer's LAN, no Firebase session cookie available) can call this
 * directly. Before opening this URL beyond personal testing, lock it down by:
 *   1. Switching back to onCall + enforceAppCheck once the device UI mints
 *      App Check tokens, OR
 *   2. Adding a shared-secret header check (X-AG-AI-TOKEN) wired to a
 *      gitignored value that ships in firmware secrets.h.
 * Also set a HARD MONTHLY SPEND CAP on your Gemini API key in Google AI
 * Studio — that is your real backstop while this URL is open.
 *
 * Drop into your Firebase functions/ folder, add to functions/index.js:
 *   const { aiPreset } = require("./aiPreset");
 *   exports.aiPreset = aiPreset;
 *
 * Then:
 *   firebase functions:secrets:set GEMINI_API_KEY
 *   firebase deploy --only functions:aiPreset
 *
 * Front-end calls this via plain fetch(); see device's data/index.html.
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

// ── Firmware schema (must stay in sync with src/main.cpp CustomProfile) ────
const VALID_EFFECTS = new Set([0,1,2,3,4,6,7,8,9,10,11,12,13,14,15,16,17,18]);
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
const MAX_PATTERN = 70;
const MAX_NAME_LEN = 32;
const MAX_PROMPT_LEN = 500;
const MONTHLY_QUOTA = 50;       // per-IP in test mode; tighten when wired to uid
const RATE_LIMIT_HOURLY = 10;

// Strobe-safety (mirror of firmware-side clamp).
function clampForSafety(p) {
    let clamped = false;
    if (p.effect === 7  && p.speed > 70) { p.speed = 70; clamped = true; }
    if (p.effect === 11 && p.speed > 80) { p.speed = 80; clamped = true; }
    return clamped;
}

// ── System prompt ───────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You generate JSON presets for the AFTERGLO LED controller. Output ONLY valid JSON matching this exact shape, with no prose, code fences, or extra fields:

{
  "name": "<≤32 char display name>",
  "effect": <integer enum>,
  "speed": <1-100>,
  "reverse": <boolean>,
  "allLedsMode": <boolean — true ONLY when pattern has 1 color>,
  "pattern": ["#RRGGBB", ...]   // 1..70 hex colors, repeats along the LED strip
}

Effect enum:
 0 Solid          1 Rainbow Wave   2 Color Chase    3 Fire           4 Twinkle
 6 Meteor         7 Strobe         8 Breathe        9 Theater Marquee
10 Shooting Star  11 Heartbeat    12 Color Wipe    13 Sparkle Overlay
14 Drip Fade     15 Shimmer       16 Snake         17 Snake Pattern
18 Golden Glow                   (note: no 5)

Rules:
- Pick the effect that best matches the user's vibe. Solid colors → 0. Continuous color motion → 1, 2, 12. Glow/ambient → 8, 15, 18, 4. Holiday/seasonal → 2, 9, 13. Fire/storm → 3, 10. Heart/pulse themes → 11.
- For Strobe (7), speed MUST be ≤70 — higher rates can trigger seizures (W3C 3 Hz rule).
- For Heartbeat (11), speed MUST be ≤80.
- Patterns: use 4-12 colors for chases/marquees; 1-3 for solid/breathe; 6-12 for rainbow-like flows. Avoid pure black (#000000) unless explicitly asked — it makes the strip look broken.
- name should be evocative but ≤32 chars.

Few-shot examples:
{"name":"Candlelight","effect":15,"speed":25,"reverse":false,"allLedsMode":false,"pattern":["#FF9329","#FFA500","#FFC864","#FFDC96"]}
{"name":"Christmas Chase","effect":2,"speed":50,"reverse":false,"allLedsMode":false,"pattern":["#FF0000","#FF0000","#FF0000","#FF0000","#FFFFFF","#FFFFFF","#008000","#008000","#008000","#008000","#FFFFFF","#FFFFFF"]}
{"name":"Ocean Waves","effect":2,"speed":35,"reverse":false,"allLedsMode":false,"pattern":["#00008B","#00008B","#00008B","#00008B","#00008B","#00BFFF"]}
{"name":"Party Mode","effect":8,"speed":65,"reverse":false,"allLedsMode":false,"pattern":["#FF0000","#FFA500","#FFFF00","#008000","#0000FF","#800080","#FF007F"]}
{"name":"Solid White","effect":0,"speed":50,"reverse":false,"allLedsMode":true,"pattern":["#FFFFFF"]}`;

// ── Validate / sanitize the model's output ──────────────────────────────────
function validatePreset(raw) {
    if (!raw || typeof raw !== "object") throw new Error("Preset is not an object");
    const out = {};
    out.name = String(raw.name || "Generated").slice(0, MAX_NAME_LEN).replace(/[\x00-\x1F]/g, "").trim();
    if (!out.name) out.name = "Generated";

    const eff = parseInt(raw.effect, 10);
    if (!VALID_EFFECTS.has(eff)) throw new Error("Invalid effect");
    out.effect = eff;

    let spd = parseInt(raw.speed, 10);
    if (isNaN(spd)) spd = 50;
    out.speed = Math.max(1, Math.min(100, spd));

    out.reverse = !!raw.reverse;
    out.allLedsMode = !!raw.allLedsMode;

    if (!Array.isArray(raw.pattern) || raw.pattern.length === 0)
        throw new Error("pattern must be a non-empty array");
    const pattern = [];
    for (const c of raw.pattern) {
        if (typeof c !== "string" || !HEX_COLOR.test(c)) continue;
        pattern.push(c.toUpperCase());
        if (pattern.length >= MAX_PATTERN) break;
    }
    if (pattern.length === 0) throw new Error("No valid colors in pattern");
    if (out.allLedsMode) pattern.length = 1;
    out.pattern = pattern;

    return out;
}

// ── Quota / rate-limit by client IP (TEST MODE — keyed by uid in production) ─
async function checkAndIncQuota(clientKey) {
    const monthKey = new Date().toISOString().slice(0, 7);
    const hourKey  = new Date().toISOString().slice(0, 13);
    const monthRef = db.collection("aiQuota").doc(`${clientKey}_${monthKey}`);
    const hourRef  = db.collection("aiQuotaHourly").doc(`${clientKey}_${hourKey}`);
    return db.runTransaction(async (tx) => {
        const m = await tx.get(monthRef);
        const h = await tx.get(hourRef);
        const monthCount = (m.exists ? m.data().count : 0) || 0;
        const hourCount  = (h.exists ? h.data().count : 0) || 0;
        if (monthCount >= MONTHLY_QUOTA) { const e = new Error(`Monthly limit of ${MONTHLY_QUOTA} reached`); e.status = 429; throw e; }
        if (hourCount  >= RATE_LIMIT_HOURLY) { const e = new Error(`Hourly limit of ${RATE_LIMIT_HOURLY} reached`); e.status = 429; throw e; }
        tx.set(monthRef, { count: monthCount + 1, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        tx.set(hourRef,  { count: hourCount  + 1, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    });
}

// ── Exact-match cache ───────────────────────────────────────────────────────
function hashPrompt(s) {
    const crypto = require("crypto");
    return crypto.createHash("sha256").update(s.trim().toLowerCase()).digest("hex");
}
async function cacheLookup(promptHash) {
    const snap = await db.collection("aiPresetCache").doc(promptHash).get();
    return snap.exists ? snap.data().preset : null;
}
async function cacheStore(promptHash, preset, prompt) {
    await db.collection("aiPresetCache").doc(promptHash).set({
        preset, prompt,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
}

// ── Gemini call ─────────────────────────────────────────────────────────────
async function callGemini(prompt, basePreset, apiKey) {
    const userParts = [];
    if (basePreset) {
        userParts.push(`Refine this preset based on the new instruction. Previous preset:\n${JSON.stringify(basePreset)}\n\nRefinement: ${prompt}`);
    } else {
        userParts.push(`User vibe: ${prompt}\n\nReturn only the JSON preset.`);
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    const body = {
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: userParts.join("\n") }] }],
        generationConfig: {
            temperature: 0.8,
            maxOutputTokens: 512,
            responseMimeType: "application/json",
        },
    };
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Gemini error ${res.status}: ${txt.slice(0, 200)}`);
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Empty Gemini response");
    try { return JSON.parse(text); } catch (e) { throw new Error("Gemini returned non-JSON: " + text.slice(0, 200)); }
}

// ── HTTPS entrypoint ────────────────────────────────────────────────────────
exports.aiPreset = onRequest(
    {
        secrets: [GEMINI_API_KEY],
        cors: true,                 // allow calls from any origin (the device UI is served locally)
        timeoutSeconds: 30,
        memory: "256MiB",
        maxInstances: 5,            // cost cap — prevents runaway scaling
    },
    async (req, res) => {
        if (req.method === "OPTIONS") { res.status(204).send(""); return; }
        if (req.method !== "POST")    { res.status(405).json({ error: "Method not allowed" }); return; }

        try {
            const prompt = String(req.body?.prompt || "").slice(0, MAX_PROMPT_LEN).trim();
            if (!prompt) { res.status(400).json({ error: "Prompt required" }); return; }
            const basePreset = req.body?.basePreset;

            // TEST-MODE quota key: client IP. Forwarded-For is set by Cloud Run / Functions.
            const ip = (req.headers["x-forwarded-for"] || req.ip || "unknown").toString().split(",")[0].trim();
            const clientKey = "ip:" + ip;

            try { await checkAndIncQuota(clientKey); }
            catch (e) {
                if (e.status === 429) { res.status(429).json({ error: e.message }); return; }
                throw e;
            }

            // Exact-match cache (only on fresh prompts).
            const phash = hashPrompt(prompt);
            if (!basePreset) {
                const cached = await cacheLookup(phash);
                if (cached) {
                    res.json({ preset: cached, cached: true, clamped: clampForSafety(cached) });
                    return;
                }
            }

            // Generate, validate, clamp.
            const raw = await callGemini(prompt, basePreset, GEMINI_API_KEY.value());
            let preset;
            try { preset = validatePreset(raw); }
            catch (e) {
                const raw2 = await callGemini(prompt + "\n\nReturn STRICT valid JSON matching the schema.", basePreset, GEMINI_API_KEY.value());
                preset = validatePreset(raw2);
            }
            const clamped = clampForSafety(preset);
            if (!basePreset) cacheStore(phash, preset, prompt).catch(() => {});

            res.json({ preset, cached: false, clamped });
        } catch (e) {
            console.error("aiPreset error:", e);
            res.status(500).json({ error: e.message || "Internal error" });
        }
    }
);
