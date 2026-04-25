// Diagnose what gates are blocking the super-admin account from uploading.
// Run: node scripts/check-my-account.js
const admin = require("firebase-admin");
const cred = require("C:/Users/18018/Desktop/RIDGELINE/_secrets/afterglo-adminsdk.json");
admin.initializeApp({ credential: admin.credential.cert(cred) });

const db = admin.firestore();
const SUPER_ADMIN_EMAIL = "shaneward852@gmail.com";

(async () => {
  let authUser;
  try {
    authUser = await admin.auth().getUserByEmail(SUPER_ADMIN_EMAIL);
  } catch (e) {
    console.log("Auth user not found for", SUPER_ADMIN_EMAIL);
    process.exit(0);
  }

  console.log(`=== Firebase Auth (${SUPER_ADMIN_EMAIL}) ===`);
  console.log(`  uid:           ${authUser.uid}`);
  console.log(`  emailVerified: ${authUser.emailVerified}     ${authUser.emailVerified ? "✓" : "✗ → BLOCKS uploadSequence (email_verification_required)"}`);
  console.log(`  customClaims:  ${JSON.stringify(authUser.customClaims || {})}`);
  const claims = authUser.customClaims || {};
  console.log(`    admin claim:           ${claims.admin === true ? "✓" : "✗"}`);
  console.log(`    creatorVerified claim: ${claims.creatorVerified === true ? "✓" : "✗ → BLOCKS Premium uploads (creator_verification_required)"}`);

  console.log(`\n=== Firestore /users/${authUser.uid} ===`);
  const userDoc = await db.collection("users").doc(authUser.uid).get();
  if (!userDoc.exists) {
    console.log("  (no user doc) → BLOCKS uploadSequence (agreement_required)");
  } else {
    const u = userDoc.data();
    const accepted = !!u.creatorAgreementAcceptedAt;
    console.log(`  email:                       ${u.email || "-"}`);
    console.log(`  role:                        ${u.role || "-"}`);
    console.log(`  creatorAgreementAcceptedAt:  ${accepted ? u.creatorAgreementAcceptedAt.toDate().toISOString() + " ✓" : "(not set) ✗ → BLOCKS uploadSequence (agreement_required)"}`);
    console.log(`  creatorVerificationStatus:   ${u.creatorVerificationStatus || "-"}`);
  }

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
