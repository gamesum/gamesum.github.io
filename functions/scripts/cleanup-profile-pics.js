// One-off: delete legacy non-JPEG profile pictures (.png/.jpeg/.webp) so the
// JPEG-only storage rule is consistent with what's on disk. The current
// my-library.html upload flow always writes <uid>.jpg, so any other extension
// is leftover from before.
//
// Run: node scripts/cleanup-profile-pics.js
const admin = require("firebase-admin");
const cred = require("C:/Users/18018/Desktop/RIDGELINE/_secrets/afterglo-adminsdk.json");
admin.initializeApp({
  credential: admin.credential.cert(cred),
  storageBucket: "afterglo-website-fbb89.firebasestorage.app",
});

(async () => {
  const bucket = admin.storage().bucket();
  const [files] = await bucket.getFiles({ prefix: "profile_pictures/" });
  const stale = files.filter((f) => /\.(png|jpeg|webp)$/i.test(f.name));
  if (!stale.length) {
    console.log("No legacy profile pic variants found. Bucket is clean.");
    process.exit(0);
  }
  console.log(`Deleting ${stale.length} legacy profile pic variant(s):`);
  for (const f of stale) {
    const sizeKB = (parseInt(f.metadata.size || "0", 10) / 1024).toFixed(1);
    console.log(`  - ${f.name}  (${sizeKB} KB)`);
    await f.delete();
  }
  console.log("Done.");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
