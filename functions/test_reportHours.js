// node functions/test_reportHours.js — pure checks for the warranty hours record.
const assert = require("assert");
const { mergeReport, mergeCheckin } = require("./src/reportHours.js")._test;

const H = 3600, T0 = 1_800_000_000_000;
const rep = (p, l, source = "controller") => ({ mac: "AA:BB:CC:DD:EE:FF", poweredSeconds: p, litSeconds: l, fw: "1.6.0", name: "x", source });

// First report creates; never lowers afterwards.
let r = mergeCheckin(null, rep(100 * H, 40 * H), false, T0);
assert.strictEqual(r.outcome, "created");
assert.strictEqual(r.meter, null);
let doc = r.doc;
assert.strictEqual(doc.lastSource, "controller");

// Normal growth an hour later.
r = mergeCheckin(doc, rep(101 * H, 41 * H), false, T0 + H * 1000);
assert.strictEqual(r.outcome, "updated");
doc = r.doc;
assert.strictEqual(doc.poweredSeconds, 101 * H);

// Flash erased: controller reports 5 min and asks for a restore.
const t2 = T0 + 2 * H * 1000;
r = mergeCheckin(doc, rep(300, 200), true, t2);
assert.strictEqual(r.outcome, "low");
assert.deepStrictEqual(r.meter, { poweredSeconds: 101 * H, litSeconds: 41 * H });
doc = r.doc;
assert.strictEqual(doc.poweredSeconds, 101 * H, "never lowered");
assert.strictEqual(doc.lowReports, 1);
assert.strictEqual(doc.restores, 1);
assert.strictEqual(doc.restoreCreditS, 300);

// The controller now reports prior + what it counted since: accepted.
r = mergeCheckin(doc, rep(101 * H + 300 + 900, 41 * H + 200 + 900), false, t2 + 15 * 60 * 1000);
assert.strictEqual(r.outcome, "updated");
assert.strictEqual(r.doc.poweredSeconds, 101 * H + 1200);
assert.strictEqual(r.doc.restoreCreditS, undefined, "credit used once");

// A low report WITHOUT the restore flag (old firmware): history kept, nothing sent.
r = mergeCheckin(doc, rep(300, 200), false, t2 + 60 * 60 * 1000);
assert.strictEqual(r.meter, null);
assert.strictEqual(r.doc.poweredSeconds, 101 * H);

// A restore request when the server holds no more than the controller: nothing sent.
r = mergeCheckin({ ...doc, poweredSeconds: 400, litSeconds: 100, updatedAtMs: T0 }, rep(350, 100), true, T0 + 3600 * 1000);
assert.strictEqual(r.meter, null);
r = mergeCheckin(null, rep(300, 200), true, T0);
assert.strictEqual(r.meter, null);

// Impossible growth is still rejected.
r = mergeReport({ ...doc, restoreCreditS: undefined, updatedAtMs: T0 }, rep(500 * H, 1), T0 + 20 * 60 * 1000);
assert.strictEqual(r.outcome, "rejected");

console.log("reportHours: all checks passed");
