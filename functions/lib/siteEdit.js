"use strict";
/**
 * AFTERGLO — admin-only AI site editor (Firebase Cloud Function, callable).
 *
 * Lets an admin describe a change in plain English; this function pulls the
 * current file from GitHub, asks Claude to rewrite it, sanity-checks the
 * result, and commits it straight back to `main` via the GitHub Contents
 * API. GitHub Pages serves `docs/` from `main`, so a successful commit goes
 * live within about a minute — no separate deploy step.
 *
 * Scope is intentionally narrow: only files in EDITABLE_FILES can be
 * touched, and the model must return a complete, plausible HTML document or
 * the commit is refused.
 */
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
exports.siteEdit = void 0;
const admin = __importStar(require("firebase-admin"));
const functions = __importStar(require("firebase-functions"));
const params_1 = require("firebase-functions/params");
const ANTHROPIC_API_KEY = (0, params_1.defineSecret)("ANTHROPIC_API_KEY");
const SITE_EDITOR_GITHUB_TOKEN = (0, params_1.defineSecret)("SITE_EDITOR_GITHUB_TOKEN");
const GITHUB_OWNER = "gamesum";
const GITHUB_REPO = "gamesum.github.io";
const GITHUB_BRANCH = "main";
// Only these files can be edited from the page — keeps the blast radius of
// a bad instruction (or a compromised admin session) to marketing pages,
// never functions/, rules, secrets, or anything outside docs/.
const EDITABLE_FILES = [
    "index.html",
    "platform.html",
    "arches.html",
    "circuit-board.html",
    "firmware.html",
    "support.html",
    "privacy.html",
    "terms.html",
    "creator-agreement.html",
    "creator-dashboard.html",
    "my-library.html",
    "upload.html",
    "signin.html",
    "account.html",
    "afterglo-visualizer.html",
];
const MAX_INSTRUCTION_LEN = 2000;
const CLAUDE_MODEL = "claude-sonnet-5";
function isSuperAdminEmail(email) {
    const SUPER_ADMIN_EMAILS = ["shaneward852@gmail.com"];
    if (!email)
        return false;
    return SUPER_ADMIN_EMAILS.includes(String(email).toLowerCase());
}
async function githubRequest(token, path, init) {
    const res = await fetch(`https://api.github.com${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "afterglo-site-editor",
            ...(init?.headers || {}),
        },
    });
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`GitHub API ${res.status}: ${body.slice(0, 500)}`);
    }
    return res.json();
}
function looksLikeValidHtml(original, candidate) {
    if (typeof candidate !== "string" || candidate.trim().length === 0)
        return false;
    const c = candidate.trim().toLowerCase();
    if (!c.startsWith("<!doctype html"))
        return false;
    if (!c.includes("</html>"))
        return false;
    // Guard against wildly truncated or bloated output.
    const ratio = candidate.length / Math.max(original.length, 1);
    if (ratio < 0.3 || ratio > 3)
        return false;
    return true;
}
exports.siteEdit = functions
    .runWith({ secrets: ["ANTHROPIC_API_KEY", "SITE_EDITOR_GITHUB_TOKEN"], timeoutSeconds: 300, memory: "512MB" })
    .https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "Sign in required.");
    }
    const isAdminClaim = context.auth.token.admin === true;
    if (!isAdminClaim && !isSuperAdminEmail(context.auth.token.email)) {
        throw new functions.https.HttpsError("permission-denied", "Admin access required.");
    }
    const file = typeof data?.file === "string" ? data.file : "";
    const instruction = typeof data?.instruction === "string" ? data.instruction.trim() : "";
    if (!EDITABLE_FILES.includes(file)) {
        throw new functions.https.HttpsError("invalid-argument", "That file isn't editable from here.");
    }
    if (!instruction || instruction.length > MAX_INSTRUCTION_LEN) {
        throw new functions.https.HttpsError("invalid-argument", `Instruction must be 1-${MAX_INSTRUCTION_LEN} characters.`);
    }
    const ghToken = SITE_EDITOR_GITHUB_TOKEN.value();
    const path = `docs/${file}`;
    const db = admin.firestore();
    const logRef = db.collection("admin_site_edits").doc();
    await logRef.set({
        file,
        instruction,
        status: "running",
        requestedBy: context.auth.uid,
        requestedByEmail: context.auth.token.email || null,
        createdAt: admin.firestore.Timestamp.now(),
    });
    try {
        // 1. Pull current file content from GitHub.
        const fileMeta = await githubRequest(ghToken, `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}?ref=${GITHUB_BRANCH}`);
        const currentContent = Buffer.from(fileMeta.content, "base64").toString("utf8");
        const currentSha = fileMeta.sha;
        // 2. Ask Claude to rewrite the file.
        const systemPrompt = "You are editing a single HTML file for a live marketing website (AFTERGLO, permanent holiday " +
            "lighting). You will be given the full current contents of the file and a plain-English instruction. " +
            "Apply exactly what the instruction asks, preserving everything else — layout, other copy, scripts, " +
            "styles, structure — unless the instruction requires changing it. " +
            "Reply with ONLY the complete, valid, updated HTML document — no markdown code fences, no explanation, " +
            "no commentary before or after. The response must start with '<!doctype html' and be a complete file " +
            "that could replace the original outright.";
        const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-api-key": ANTHROPIC_API_KEY.value(),
                "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
                model: CLAUDE_MODEL,
                max_tokens: 16000,
                system: systemPrompt,
                messages: [
                    {
                        role: "user",
                        content: `Instruction: ${instruction}\n\n` +
                            `Current contents of ${file}:\n\n${currentContent}`,
                    },
                ],
            }),
        });
        if (!anthropicRes.ok) {
            const errBody = await anthropicRes.text().catch(() => "");
            throw new Error(`Anthropic API ${anthropicRes.status}: ${errBody.slice(0, 500)}`);
        }
        const anthropicJson = (await anthropicRes.json());
        const newContent = (anthropicJson.content || [])
            .filter((b) => b.type === "text")
            .map((b) => b.text || "")
            .join("")
            .trim();
        if (!looksLikeValidHtml(currentContent, newContent)) {
            throw new Error("Model output failed validation (not a complete HTML document) — nothing was committed.");
        }
        // 3. Commit the new content back to GitHub.
        const commitMessage = `Site editor: ${instruction.slice(0, 72)}`;
        const commitRes = await githubRequest(ghToken, `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`, {
            method: "PUT",
            body: JSON.stringify({
                message: commitMessage,
                content: Buffer.from(newContent, "utf8").toString("base64"),
                sha: currentSha,
                branch: GITHUB_BRANCH,
            }),
        });
        const commitUrl = commitRes?.commit?.html_url || null;
        await logRef.update({
            status: "committed",
            commitUrl,
            commitSha: commitRes?.commit?.sha || null,
            finishedAt: admin.firestore.Timestamp.now(),
        });
        return { ok: true, commitUrl, file };
    }
    catch (err) {
        functions.logger.error("siteEdit failed", err);
        await logRef.update({
            status: "error",
            error: String(err?.message || err).slice(0, 1000),
            finishedAt: admin.firestore.Timestamp.now(),
        });
        throw new functions.https.HttpsError("internal", `Edit failed: ${String(err?.message || err).slice(0, 300)}`);
    }
});
//# sourceMappingURL=siteEdit.js.map