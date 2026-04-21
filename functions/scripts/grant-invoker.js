// One-shot: grants roles/cloudfunctions.invoker to allUsers on the public
// HTTP Cloud Functions (Gen1) that the website calls directly. This is
// normally auto-applied by `firebase deploy` but newer Firebase CLI
// versions no longer grant it, causing the Google Frontend to return 403
// on every request and the UI to show "Payment unavailable".
//
// Uses the user OAuth token from the Firebase CLI's configstore (must be
// logged in as a project Owner / Cloud Functions Admin).
//
// Run: node scripts/grant-invoker.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");

const PROJECT = "afterglo-website-fbb89";
const REGION = "us-central1";

const PUBLIC_FUNCTIONS = [
  "createCheckout",
  "recordPurchase",
  "stripeWebhook",
  "purchases",
  "sequenceList",
  "reportContentIssue",
];

function loadToken() {
  const p = path.join(os.homedir(), ".config", "configstore", "firebase-tools.json");
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!j.tokens?.access_token) {
    throw new Error("No access_token in firebase-tools configstore. Run `firebase login` first.");
  }
  return j.tokens.access_token;
}

function request(method, url, token, body) {
  const u = new URL(url);
  const opts = {
    method,
    hostname: u.hostname,
    path: u.pathname + u.search,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let buf = "";
      res.on("data", (d) => (buf += d));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(buf ? JSON.parse(buf) : {});
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${buf}`));
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  const token = loadToken();

  for (const fn of PUBLIC_FUNCTIONS) {
    const base =
      `https://cloudfunctions.googleapis.com/v1/projects/${PROJECT}` +
      `/locations/${REGION}/functions/${fn}`;

    try {
      const policy = await request("GET", `${base}:getIamPolicy`, token);
      const bindings = policy.bindings || [];
      let b = bindings.find((x) => x.role === "roles/cloudfunctions.invoker");
      if (!b) {
        b = { role: "roles/cloudfunctions.invoker", members: [] };
        bindings.push(b);
      }
      if (!b.members.includes("allUsers")) b.members.push("allUsers");

      await request("POST", `${base}:setIamPolicy`, token, {
        policy: { bindings, etag: policy.etag },
      });
      console.log(`[ok]   ${fn}  -> allUsers invoker`);
    } catch (err) {
      console.error(`[fail] ${fn}: ${err.message.split("\n")[0]}`);
    }
  }
})();
