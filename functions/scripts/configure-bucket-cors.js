// One-shot: configure CORS on the Firebase Storage bucket so that browser
// PUTs to GCS signed URLs (e.g. uploadSequence's FSEQ upload step) work.
//
// Without this, Chrome sends a CORS preflight to storage.googleapis.com,
// the bucket returns no Access-Control-Allow-Origin, and the PUT fails
// with "TypeError: Failed to fetch".
//
// Run: node scripts/configure-bucket-cors.js
const admin = require("firebase-admin");
const cred = require("C:/Users/18018/Desktop/RIDGELINE/_secrets/afterglo-adminsdk.json");
admin.initializeApp({
  credential: admin.credential.cert(cred),
  storageBucket: "afterglo-website-fbb89.firebasestorage.app",
});

const corsRules = [
  {
    origin: [
      "https://afterglolighting.org",
      "https://www.afterglolighting.org",
      "https://gamesum.github.io",
      "https://afterglo-website-fbb89.web.app",
      "https://afterglo-website-fbb89.firebaseapp.com",
      "http://localhost:5000",
      "http://localhost:5500",
      "http://127.0.0.1:5500",
    ],
    method: ["GET", "HEAD", "PUT", "POST", "OPTIONS"],
    responseHeader: [
      "Content-Type",
      "Authorization",
      "Content-Length",
      "User-Agent",
      "x-goog-resumable",
      "x-goog-meta-*",
    ],
    maxAgeSeconds: 3600,
  },
];

(async () => {
  const bucket = admin.storage().bucket();
  console.log(`Setting CORS on ${bucket.name}...`);
  await bucket.setCorsConfiguration(corsRules);
  console.log("[ok] CORS configured");
  // Read it back to verify.
  const [meta] = await bucket.getMetadata();
  console.log("Live CORS rules:");
  console.log(JSON.stringify(meta.cors, null, 2));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
