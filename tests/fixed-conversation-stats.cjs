"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createRun, compareRuns, ORDER } = require("../experiments/process-memory/comparison-study.cjs");

const options = { metric: "windows-private-bytes", intervalMs: 10, warmupMs: 20, graceMs: 20, windowMs: 50 };
const point = (run, t, value, ws = null) => run.sample(t, { primaryBytes: value, workingSetBytes: ws });
function finished(number = 1, { pre = Array(5).fill(100), post = Array(5).fill(110), peak = 150,
  reason = "completed", pidCheck = "same", metric = options.metric } = {}) {
  const s = createRun({ ...options, metric, run: number, condition: ORDER[number - 1] });
  s.start(0); point(s, 0, 50); point(s, 10, 50);
  pre.forEach((v, i) => point(s, 20 + 10 * i, v)); s.advance(70);
  point(s, 70, peak, peak + 1000); point(s, 80, peak - 1, peak + 999); s.startPost(90);
  point(s, 90, 900); point(s, 100, 900);
  post.forEach((v, i) => point(s, 110 + 10 * i, v)); s.advance(160);
  return { s, result: s.end(reason, pidCheck) };
}
function matchedRuns() {
  return [[100, 110, 150], [140, 150, 200], [160, 170, 230], [110, 130, 190]].map(([pre, post, peak], i) =>
    finished(i + 1, { pre: Array(5).fill(pre), post: Array(5).fill(post), peak }).result);
}

test("warmup and return grace do not enter quiet medians; late confirmation cannot change duration or peak", () => {
  const s = createRun({ ...options, run: 1, condition: "on" }); s.start(0);
  point(s, 0, 999); point(s, 10, 999);
  [130, 100, 110, 100, 110].forEach((v, i) => point(s, 20 + 10 * i, v));
  assert.equal(s.region(69), "pre-window"); assert.equal(s.region(70), "scroll");
  point(s, 70, 3000, 4600); point(s, 80, 2000); s.startPost(90);
  point(s, 90, 900); point(s, 100, 900);
  [180, 167, 173, 175, 169].forEach((v, i) => point(s, 110 + 10 * i, v));
  point(s, 160, 999999); assert.equal(s.phase(), "await-confirm");
  point(s, 9999, 999999); s.advance(20000);
  const r = s.end("completed", "same");
  assert.ok(r.complete && r.allWindowsValid);
  assert.equal(r.pre.medianBytes, 110); assert.equal(r.pre.sampleCount, 5);
  assert.equal(r.post.medianBytes, 173); assert.equal(r.post.sampleCount, 5);
  assert.equal(r.postMinusPreBytes, 63);
  assert.equal(r.scroll.sampledPeakBytes, 3000); assert.equal(r.overall.sampledPeakBytes, 3000);
  assert.equal(r.overall.sampledPeakPhase, "scroll"); assert.equal(r.overall.workingSetSampledPeakBytes, 4600);
  assert.equal(r.overall.durationMs, 160); assert.equal(r.overall.maxGapMs, 10);
  assert.equal(r.warmup.durationMs, 20); assert.equal(r.scroll.durationMs, 20);
  assert.equal(r.pre.firstHalfMedianBytes, 110); assert.equal(r.pre.lastHalfMedianBytes, 105);
  assert.equal(r.pre.halfMedianDeltaBytes, -5);
});

test("region predicts automatic boundaries without changing phase, including zero warmup", () => {
  const s = createRun({ ...options, run: 1, condition: "on" }); s.start(0);
  assert.equal(s.region(19), "warmup"); assert.equal(s.region(20), "pre-window");
  assert.equal(s.region(70), "scroll"); assert.equal(s.phase(), "warmup");
  s.advance(70); s.startPost(90);
  assert.equal(s.region(109), "post-grace"); assert.equal(s.region(110), "post-window");
  assert.equal(s.region(160), "await-confirm"); assert.equal(s.phase(), "post");
  const immediate = createRun({ ...options, warmupMs: 0, run: 1, condition: "on" });
  immediate.start(0); assert.equal(immediate.phase(), "pre"); point(immediate, 0, 100);
  assert.equal(immediate.report().pre.sampleCount, 1); assert.equal(immediate.report().warmup.durationMs, 0);
});

test("valid coverage may be volatile; temporal half medians and range expose movement without a stability verdict", () => {
  const r = finished(1, { pre: [100, 100, 200, 200, 200] }).result;
  assert.equal(r.pre.valid, true); assert.equal(r.allWindowsValid, true);
  assert.equal(r.pre.rangeBytes, 100); assert.equal(r.pre.relativeRangePercent, 50);
  assert.equal(r.pre.firstHalfMedianBytes, 100); assert.equal(r.pre.lastHalfMedianBytes, 200);
  assert.equal(r.pre.halfMedianDeltaBytes, 100); assert.equal(r.pre.medianBytes, 200);
  assert.equal(r.protocol.stability, "not-established-by-valid-coverage");
  assert.equal(r.pre.stable, undefined);
});

test("missing primary readings and sampling holes invalidate windows without substituting zeros or working-set bytes", () => {
  for (const value of [0, -1, undefined, null, NaN, Infinity, "500", 1.5]) {
    const s = createRun({ ...options, run: 1, condition: "on" }); s.start(0);
    point(s, 20, 100); point(s, 30, 110); point(s, 40, value, 999999); point(s, 50, 120); point(s, 60, 130);
    s.advance(70); const w = s.report().pre;
    assert.equal(w.validSamples, 4); assert.equal(w.invalidReason, "missing-reading");
    assert.equal(w.medianBytes, 115); assert.equal(w.workingSetMedianBytes, 999999);
    assert.equal(w.maxBytes, 130);
  }
  const s = createRun({ ...options, windowMs: 100, run: 1, condition: "on" }); s.start(0);
  for (const t of [20, 30, 40, 50, 60, 80, 90, 100, 110]) point(s, t, 123);
  s.advance(120); const w = s.report().pre;
  assert.equal(w.sampleCount, 9); assert.equal(w.medianBytes, 123);
  assert.equal(w.maxGapMs, 20); assert.equal(w.invalidReason, "sampling-gap");
});

test("unfinished or unverified runs preserve measurements but cannot create formal differences", () => {
  for (const [reason, pidCheck] of [["completed", "different"], ["completed", "unverified"],
    ["reader-failed", "same"], ["context-changed", "same"], ["confirmation-timeout", "unverified"]]) {
    const r = finished(1, { reason, pidCheck }).result;
    assert.equal(r.post.medianBytes, 110); assert.equal(r.postMinusPreBytes, null);
    const runs = matchedRuns(); runs[0] = r;
    const comparison = compareRuns(runs);
    assert.equal(comparison.pairedDifferencesAvailable, false); assert.equal(comparison.pairs, null);
  }
  const s = createRun({ ...options, run: 1, condition: "on" }); s.start(0);
  for (const t of [20, 30, 40, 50, 60]) point(s, t, 100);
  s.advance(70); point(s, 70, 200); s.startPost(80);
  point(s, 100, 120); point(s, 110, 130);
  const r = s.end("user-stop", "same");
  assert.equal(r.post.complete, false); assert.equal(r.post.invalidReason, "unfinished-window");
  assert.equal(r.post.medianBytes, 125); assert.equal(r.postMinusPreBytes, null); assert.equal(r.complete, false);
});

test("paired contrasts preserve ON minus OFF signs in both orders and disclose repeat spread", () => {
  const c = compareRuns(matchedRuns());
  assert.equal(c.pairedDifferencesAvailable, true); assert.equal(c.scrollPeakDifferencesAvailable, true);
  assert.deepEqual(c.unavailableReasons, []); assert.deepEqual(c.order, ["on", "off", "off", "on"]);
  assert.deepEqual(c.pairs, [
    { pair: 1, onRun: 1, offRun: 2, preMedianOnMinusOffBytes: -40, postMedianOnMinusOffBytes: -40,
      postMinusPreOnMinusOffBytes: 0, scrollPeakOnMinusOffBytes: -50, scrollDurationOnMinusOffMs: 0 },
    { pair: 2, onRun: 4, offRun: 3, preMedianOnMinusOffBytes: -50, postMedianOnMinusOffBytes: -40,
      postMinusPreOnMinusOffBytes: 10, scrollPeakOnMinusOffBytes: -40, scrollDurationOnMinusOffMs: 0 }
  ]);
  assert.equal(c.conditions.on.preRepeatSpreadBytes, 10); assert.equal(c.conditions.on.postRepeatSpreadBytes, 20);
  assert.equal(c.conditions.off.preRepeatSpreadBytes, 20); assert.equal(c.conditions.on.postMedianOfRunMediansBytes, 120);
  assert.deepEqual(c.onMinusOff, { preMedianOfRunMediansBytes: -45, postMedianOfRunMediansBytes: -40,
    postMinusPreMedianOfRunDeltasBytes: 5, scrollMedianOfRunPeaksBytes: -45 });
  assert.equal(c.extensionNetMemoryBenefit, "not-established"); assert.equal(c.attribution, "descriptive-only");
});

test("study-level completion, all four passes, order, metric and protocol must match before contrasts are published", () => {
  for (const reason of [null, "recording", "user-stop", "context-changed", "output-failed"]) {
    const c = compareRuns(matchedRuns(), { reason });
    assert.equal(c.pairedDifferencesAvailable, false); assert.equal(c.onMinusOff, null);
    assert.ok(c.unavailableReasons.includes("study-not-completed"));
  }
  const partial = compareRuns(matchedRuns().slice(0, 3));
  assert.equal(partial.pairedDifferencesAvailable, false); assert.equal(partial.conditions, null);
  const cases = [
    [runs => { [runs[1], runs[2]] = [runs[2], runs[1]]; }, "run-2-order-mismatch"],
    [runs => { runs[2] = finished(3, { metric: "linux-anon-rss-plus-swap" }).result; }, "metric-mismatch"],
    [runs => { runs[2].protocol.windowMs += 1; }, "timing-mismatch"],
    [runs => { runs[3].post.valid = false; }, "run-4-invalid-window"]
  ];
  for (const [change, code] of cases) {
    const runs = matchedRuns(); change(runs); const c = compareRuns(runs);
    assert.equal(c.pairedDifferencesAvailable, false); assert.equal(c.pairs, null);
    assert.ok(c.unavailableReasons.includes(code));
  }
});

test("missing scroll coverage suppresses peak comparisons separately from valid tail windows", () => {
  for (const scroll of [null, { complete: true, coverage: "partial", sampledPeakBytes: 99999, durationMs: 20 }]) {
    const runs = matchedRuns(); runs[0].scroll = scroll; const c = compareRuns(runs);
    assert.equal(c.pairedDifferencesAvailable, true); assert.equal(c.scrollPeakDifferencesAvailable, false);
    assert.deepEqual(c.scrollPeakUnavailableReasons, ["run-1-scroll-coverage"]);
    assert.equal(c.pairs[0].postMedianOnMinusOffBytes, -40);
    assert.equal(c.pairs[0].scrollPeakOnMinusOffBytes, null);
    assert.equal(c.onMinusOff.scrollMedianOfRunPeaksBytes, null);
  }
});

test("burst sampling is bounded; oversized buffers cannot masquerade as complete medians", () => {
  const s = createRun({ ...options, run: 1, condition: "on" }); s.start(0);
  for (let i = 0; i < 50; i++) point(s, 20 + i / 2, 110 + i);
  s.advance(70); const w = s.report().pre;
  assert.equal(w.invalidReason, "sample-cap"); assert.equal(w.medianBytes, null);
  assert.equal(w.firstHalfMedianBytes, null); assert.equal(w.lastHalfMedianBytes, null);
  assert.equal(w.maxBytes, 159);
});

test("invalid labels and out-of-order marks fail closed; reports cannot mutate live state or retain private metadata", () => {
  assert.throws(() => createRun({ ...options, run: 1, condition: "off" }), RangeError);
  assert.throws(() => createRun({ ...options, run: 1, condition: "on", metric: "private-canary" }), RangeError);
  const s = createRun({ ...options, run: 1, condition: "on" });
  s.start(1000000000); s.sample(1000000020, { primaryBytes: 100, pid: 1234567, title: "private-canary" });
  assert.throws(() => point(s, 1000000020, 100), RangeError);
  assert.throws(() => point(s, 1000000019, 100), RangeError);
  assert.throws(() => s.startPost(1000000020), RangeError); assert.throws(() => s.end("completed", "same"), RangeError);
  assert.throws(() => s.end("private-canary"), RangeError);
  const r = s.end("user-stop"), clone = s.report();
  assert.doesNotMatch(JSON.stringify(r), /private-canary|1234567|10000000/);
  r.pre.medianBytes = -100; clone.overall.sampledPeakBytes = 1234567;
  assert.equal(s.report().pre.medianBytes, 100); assert.equal(s.end("completed", "same").overall.sampledPeakBytes, 100);
  point(s, 1000000200, 99999); assert.equal(s.report().overall.sampledPeakBytes, 100);
});
