// Sends the last N days of website quote requests (contact_submissions) to
// Porchlight as customers. Safe to re-run: Porchlight files each one under
// w<submission id> and skips any it already has.
//
// Run from the repo root, after `npm run build` in functions/:
//   gcloud auth login wardlegacygroup@gmail.com     (once)
//   node scripts/backfill-porchlight.mjs [days=30]
//
// It reads the lead key from the PORCHLIGHT_LEAD_KEY secret and never prints it.
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sendToPorchlight } = require('../functions/lib/contactNotify.js');

const PROJECT = 'afterglo-website-fbb89';
const days = Number(process.argv[2]) || 30;
const sh = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], shell: true }).trim();

const token = sh('gcloud auth print-access-token --account wardlegacygroup@gmail.com');
const key = sh(`firebase functions:secrets:access PORCHLIGHT_LEAD_KEY --project ${PROJECT}`);
if (!key) throw new Error('PORCHLIGHT_LEAD_KEY is empty. Set it first.');

/** Firestore REST value -> plain JS. */
function plain(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, plain(x)]));
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(plain);
  return null;
}

const since = new Date(Date.now() - days * 86400000).toISOString();
const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents:runQuery`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-goog-user-project': PROJECT },
  body: JSON.stringify({
    structuredQuery: {
      from: [{ collectionId: 'contact_submissions' }],
      where: { fieldFilter: { field: { fieldPath: 'submittedAt' }, op: 'GREATER_THAN_OR_EQUAL', value: { timestampValue: since } } },
    },
  }),
});
if (!r.ok) throw new Error(`Firestore query failed ${r.status}: ${await r.text()}`);
const docs = (await r.json()).filter((x) => x.document).map((x) => x.document);
console.log(`${docs.length} submissions in the last ${days} days`);

let added = 0, existing = 0, dupes = 0, failed = 0;
for (const doc of docs) {
  const id = doc.name.split('/').pop();
  const d = Object.fromEntries(Object.entries(doc.fields || {}).map(([k, v]) => [k, plain(v)]));
  try {
    const res = await sendToPorchlight(id, d, key);
    if (res.duplicate) dupes++;
    else if (res.existing) existing++;
    else added++;
    console.log(`  ${id}  ${d.name || ''}  ${res.duplicate ? 'already sent' : res.existing ? 'matched an existing customer' : 'added'}`);
  } catch (e) {
    failed++;
    console.log(`  ${id}  FAILED  ${e.message}`);
  }
}
console.log(`Done: ${added} added, ${existing} matched existing customers, ${dupes} already sent, ${failed} failed.`);
