// One-off diagnostic: list sequence docs and orphaned storage files.
// Run: node scripts/diagnose-uploads.js
const admin = require("firebase-admin");
const path = require("path");

const cred = require("C:/Users/18018/Desktop/RIDGELINE/_secrets/afterglo-adminsdk.json");
const TARGET_BUCKET = process.env.BUCKET || "afterglo-website-fbb89.firebasestorage.app";
admin.initializeApp({
  credential: admin.credential.cert(cred),
  storageBucket: TARGET_BUCKET,
});
console.log(`(querying bucket: ${TARGET_BUCKET})\n`);

const db = admin.firestore();
const bucket = admin.storage().bucket();

(async () => {
  console.log("=== ALL sequence docs (most recent 30) ===");
  const seqSnap = await db.collection("sequences")
    .orderBy("createdAt", "desc").limit(30).get();
  if (seqSnap.empty) {
    console.log("(no sequence docs)");
  } else {
    seqSnap.docs.forEach(d => {
      const x = d.data();
      console.log(`  ${d.id.padEnd(28)} status=${(x.status||"-").padEnd(18)} creator=${x.creatorUid||"-"}  name=${x.name||x.title||"-"}  createdAt=${x.createdAt && x.createdAt.toDate ? x.createdAt.toDate().toISOString() : x.createdAt}`);
    });
  }

  console.log("\n=== Storage: sequences/ folder ===");
  const [files] = await bucket.getFiles({ prefix: "sequences/" });
  if (!files.length) console.log("(empty)");
  files.forEach(f => {
    console.log(`  ${f.name.padEnd(50)} size=${f.metadata.size}B  updated=${f.metadata.updated}`);
  });

  console.log("\n=== Storage: sequence_photos/ folder ===");
  const [photos] = await bucket.getFiles({ prefix: "sequence_photos/" });
  if (!photos.length) console.log("(empty)");
  photos.slice(0, 30).forEach(f => {
    console.log(`  ${f.name}`);
  });

  console.log("\n=== ALL Storage files (every prefix) ===");
  const [allFiles] = await bucket.getFiles();
  if (!allFiles.length) console.log("(bucket empty)");
  allFiles.forEach(f => {
    const sizeKB = (parseInt(f.metadata.size||"0",10)/1024).toFixed(1);
    console.log(`  ${sizeKB.padStart(10)} KB  ${f.name}`);
  });

  console.log("\n=== Users (first 20) ===");
  const usersSnap = await db.collection("users").limit(20).get();
  usersSnap.docs.forEach(d => {
    const x = d.data();
    console.log(`  ${d.id.padEnd(30)} email=${x.email||"-"}  role=${x.role||"-"}  emailVerified=${x.emailVerified}`);
  });

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
