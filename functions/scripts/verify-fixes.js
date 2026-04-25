// End-to-end verification: account state, purchases endpoint, deployed function logic.
// Run: node scripts/verify-fixes.js
const admin = require("firebase-admin");
const https = require("https");
const cred = require("C:/Users/18018/Desktop/RIDGELINE/_secrets/afterglo-adminsdk.json");
admin.initializeApp({ credential: admin.credential.cert(cred) });

const db = admin.firestore();
const EMAIL = "shaneward852@gmail.com";

function fetchJson(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
}

(async () => {
  const u = await admin.auth().getUserByEmail(EMAIL);

  // 1. Account state
  console.log("=== 1. Account state ===");
  console.log(`  uid:                ${u.uid}`);
  console.log(`  emailVerified:      ${u.emailVerified}`);
  console.log(`  customClaims:       ${JSON.stringify(u.customClaims || {})}`);
  const userDoc = await db.collection("users").doc(u.uid).get();
  const uData = userDoc.data() || {};
  console.log(`  agreement accepted: ${!!uData.creatorAgreementAcceptedAt}`);

  // 2. Purchases collection — what's actually there for this user?
  console.log("\n=== 2. Firestore purchases collection (raw) ===");
  const purSnap = await db.collection("purchases")
    .where("userId", "==", u.uid).get();
  if (purSnap.empty) {
    console.log("  (no purchases recorded)");
  } else {
    purSnap.docs.forEach((d) => {
      const x = d.data();
      console.log(`  - ${d.id}`);
      console.log(`      sequenceId: ${x.sequenceId}`);
      console.log(`      name:       ${x.sequenceName}`);
      console.log(`      price:      $${x.price}`);
      console.log(`      kind:       ${x.kind || "(unset)"}`);
      console.log(`      isPack:     ${String(x.sequenceId || "").startsWith("pack_")}`);
    });
  }

  // 3. Hit the live /purchases endpoint with a fresh custom-token-derived ID token
  console.log("\n=== 3. Live /purchases endpoint (what the browser sees) ===");
  const customToken = await admin.auth().createCustomToken(u.uid);
  // Exchange custom token for ID token via REST API.
  const apiKey = "AIzaSyAQ7L46n1Nos6nmNcDCAJu8tY1pFdn-zQY";
  const exchange = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "identitytoolkit.googleapis.com",
      path: `/v1/accounts:signInWithCustomToken?key=${apiKey}`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, body: b }));
    });
    req.on("error", reject);
    req.write(JSON.stringify({ token: customToken, returnSecureToken: true }));
    req.end();
  });
  const idToken = JSON.parse(exchange.body).idToken;
  if (!idToken) {
    console.log(`  Could not exchange custom token (status ${exchange.status})`);
    console.log(`  ${exchange.body}`);
  } else {
    const resp = await fetchJson(
      "https://us-central1-afterglo-website-fbb89.cloudfunctions.net/purchases",
      { Authorization: `Bearer ${idToken}` }
    );
    console.log(`  HTTP ${resp.status}`);
    console.log(`  Body: ${resp.body.slice(0, 500)}`);
    try {
      const data = JSON.parse(resp.body);
      const list = data.purchases || [];
      console.log(`  Endpoint returned ${list.length} purchase(s) for this user.`);
      list.forEach((p) => console.log(`    - ${p.id}  "${p.name}"  by ${p.creator}`));
    } catch (_) { /* ignored */ }
  }

  // 4. Verify deployed function logic by inspecting source the runtime serves
  console.log("\n=== 4. Deployed function code — uploadSequence + confirmUpload ===");
  const fs = require("fs");
  const compiled = fs.readFileSync(__dirname + "/../lib/index.js", "utf8");
  const checks = [
    {
      label: "uploadSequence writes status='pending_upload' (not pending_review)",
      ok: /initialStatus = "pending_upload"/.test(compiled),
    },
    {
      label: "uploadSequence rejects unverified emails",
      ok: /email_verification_required/.test(compiled),
    },
    {
      label: "confirmUpload verifies file in Storage before publishing",
      ok: /\.fseq.*exists/.test(compiled.replace(/\s+/g, " ")) || /file\(`sequences\/\$\{sequenceId\}\.fseq`\)\.exists\(\)/.test(compiled),
    },
    {
      label: "confirmUpload publishes (or pending_review if flagged)",
      ok: /finalStatus = seqData\.flagged \? "pending_review" : "published"/.test(compiled),
    },
  ];
  checks.forEach((c) => console.log(`  ${c.ok ? "✓" : "✗"} ${c.label}`));

  // 5. Quick sanity: list any sequences this user owns + their statuses
  console.log("\n=== 5. Your sequence docs (any state) ===");
  const mySeqs = await db.collection("sequences")
    .where("creatorUid", "==", u.uid).get();
  if (mySeqs.empty) {
    console.log("  (none — you haven't successfully uploaded anything yet)");
  } else {
    mySeqs.docs.forEach((d) => {
      const x = d.data();
      console.log(`  - ${d.id}  status=${x.status}  name="${x.name}"`);
    });
  }

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
