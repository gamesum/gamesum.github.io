// node functions/test_deviceSupport.js — pure checks for deviceSupport.js.
const assert = require("assert");
const { _test } = require("./src/deviceSupport.js");
const { commandAllowed, scrub, field, sameHash } = _test;

for (const [m, p] of [["GET", "/api/v1/leds"], ["PUT", "/api/v1/leds"], ["PATCH", "/api/v1/state"],
  ["POST", "/api/v1/presets/apply"], ["PUT", "/api/v1/schedules"], ["PATCH", "/api/v1/segments/s1"],
  ["DELETE", "/api/v1/patterns/u-x"], ["POST", "/cloud/restart"], ["GET", "/api/v1/connect"]]) {
  assert.ok(commandAllowed(m, p), `${m} ${p} should be allowed`);
}
for (const p of ["/api/v1/network", "/api/v1/network/reset", "/api/v1/network/scan", "/api/v1/ota",
  "/api/v1/time", "/api/v1/device", "/api/v1/live", "/api/v1/preview", "/api/v1/support", "/api/update"]) {
  for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    assert.ok(!commandAllowed(m, p), `${m} ${p} must be refused`);
  }
}
for (const [m, p] of [["GET", "/api/v1/leds?x=1"], ["GET", "/api/v1/patterns/../network"],
  ["PUT", "/api/v1/connect"], ["get", "/api/v1/leds"], ["GET", "//api/v1/leds"], ["PUT", "/api/v1/patterns/a/b"]]) {
  assert.ok(!commandAllowed(m, p), `${m} ${p} must be refused`);
}
const s = scrub({ latitude: 40.7, longitude: -111.9, a: [{ lat: 1, lon: 2, password: "x", keep: 3 }] });
assert.deepStrictEqual(s, { a: [{ keep: 3 }] });
assert.ok(!field({ latitude: 40.7 }).includes("40.7"));
assert.ok(field({ big: "x".repeat(30000) }).includes("truncated"));
assert.ok(sameHash("ab".repeat(32), "ab".repeat(32)));
assert.ok(!sameHash("ab".repeat(32), "cd".repeat(32)));
assert.ok(!sameHash("ab", "ab".repeat(32)));
console.log("deviceSupport: all checks passed");
