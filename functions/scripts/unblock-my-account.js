// One-off: bypass creator-agreement + creator-verified gates for the super-admin
// account so uploads aren't blocked by terms-of-service flows that already
// implicitly apply to the project owner.
const admin = require("firebase-admin");
const cred = require("C:/Users/18018/Desktop/RIDGELINE/_secrets/afterglo-adminsdk.json");
admin.initializeApp({ credential: admin.credential.cert(cred) });

const db = admin.firestore();
const EMAIL = "shaneward852@gmail.com";

(async () => {
  const u = await admin.auth().getUserByEmail(EMAIL);
  console.log(`Unblocking ${EMAIL} (${u.uid})`);

  // Mark creator agreement accepted server-side.
  await db.collection("users").doc(u.uid).set({
    creatorAgreementAcceptedAt: admin.firestore.Timestamp.now(),
    creatorVerificationStatus: "approved",
  }, { merge: true });
  console.log("  ✓ creatorAgreementAcceptedAt set");
  console.log("  ✓ creatorVerificationStatus = approved");

  // Add creatorVerified custom claim (required for Premium uploads).
  const existing = u.customClaims || {};
  await admin.auth().setCustomUserClaims(u.uid, {
    ...existing,
    creatorVerified: true,
  });
  console.log("  ✓ creatorVerified claim added");
  console.log("\nForce-refresh your ID token in the browser to pick up the new claim:");
  console.log("  await firebase.auth().currentUser.getIdToken(true)");

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
