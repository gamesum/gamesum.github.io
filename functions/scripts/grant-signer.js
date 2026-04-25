// One-shot: grant roles/iam.serviceAccountTokenCreator to the Cloud Functions
// runtime service account on itself, so getSignedUrl() can sign blobs.
//
// Without this, uploadSequence/getDownloadUrl etc. throw at signing time:
//   "Permission 'iam.serviceAccounts.signBlob' denied on resource"
//
// Run: node scripts/grant-signer.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");

const PROJECT = "afterglo-website-fbb89";
const SA_EMAIL = `${PROJECT}@appspot.gserviceaccount.com`;
const ROLE = "roles/iam.serviceAccountTokenCreator";

function loadToken() {
  const p = path.join(os.homedir(), ".config", "configstore", "firebase-tools.json");
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!j.tokens?.access_token) throw new Error("Run `firebase login` first.");
  return j.tokens.access_token;
}

function request(method, url, token, body) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request({
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
    }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

(async () => {
  const token = loadToken();
  const base = `https://iam.googleapis.com/v1/projects/${PROJECT}/serviceAccounts/${SA_EMAIL}`;

  // 1. Read current IAM policy on the SA
  const get = await request("POST", `${base}:getIamPolicy`, token, {});
  if (get.status !== 200) {
    console.error("getIamPolicy failed:", get.status, get.body);
    process.exit(1);
  }
  const policy = JSON.parse(get.body);
  policy.bindings = policy.bindings || [];

  const member = `serviceAccount:${SA_EMAIL}`;
  let binding = policy.bindings.find((b) => b.role === ROLE);
  if (binding) {
    if ((binding.members || []).includes(member)) {
      console.log(`[ok] ${SA_EMAIL} already has ${ROLE} on itself`);
      process.exit(0);
    }
    binding.members = (binding.members || []).concat(member);
  } else {
    policy.bindings.push({ role: ROLE, members: [member] });
  }

  const set = await request("POST", `${base}:setIamPolicy`, token, { policy });
  if (set.status === 200) {
    console.log(`[ok] granted ${ROLE} to ${SA_EMAIL} on itself`);
  } else {
    console.error("setIamPolicy failed:", set.status, set.body);
    process.exit(1);
  }
})();
