"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createStudy } = require("../experiments/process-memory/study.cjs");

const options = { metric: "windows-private-bytes", intervalMs: 10, graceMs: 20, windowMs: 50, maxRounds: 1 };
const point = (study, t, v, ws = null) => study.sample(t, { primaryBytes: v, workingSetBytes: ws });
function windowSamples(study, mark, values) {
  values.forEach((v, i) => point(study, mark + options.graceMs + i * options.intervalMs, v));
  study.advance(mark + options.graceMs + options.windowMs);
}
function oneRound(pidCheck = "same") {
  const s = createStudy(options);
  s.startBaseline(0);
  point(s, 0, 999); point(s, 15, 999); // Too early to be resting observations.
  windowSamples(s, 0, [130, 100, 110, 100, 110]);
  point(s, 70, 1000, 4000); // Exact end goes to the following append span.
  s.startPre(90, 3);
  point(s, 95, 900);
  windowSamples(s, 90, [150, 140, 170, 1000, 160]);
  point(s, 160, 3000, 4600);
  s.startPost(180);
  windowSamples(s, 180, [180, 167, 173, 175, 169]);
  assert.equal(s.phase(), "await-finish");
  point(s, 9999, 99999); // Do not include time spent verifying the PID.
  return { s, result: s.end("completed", pidCheck) };
}

test("paired scroll and whole-session changes are distinct; peaks are sampled across phases", () => {
  const { result: r } = oneRound(), row = r.rounds[0];
  assert.ok(r.allRoundsFinished && r.allWindowsValid);
  assert.equal(r.baseline.medianBytes, 110); assert.equal(r.baseline.sampleCount, 5);
  assert.equal(row.pre.medianBytes, 160); assert.equal(row.post.medianBytes, 173);
  assert.equal(row.newTurns, 3); assert.equal(row.cumulativeNewTurns, 3);
  assert.equal(row.postMinusPreBytes, 13); assert.equal(row.postMinusBaselineBytes, 63);
  assert.equal(row.append.sampledPeakBytes, 1000); assert.equal(row.scroll.sampledPeakBytes, 3000);
  assert.equal(r.overall.sampledPeakBytes, 3000); assert.equal(r.overall.sampledPeakRound, 1);
  assert.equal(r.overall.sampledPeakPhase, "scroll"); assert.equal(r.overall.workingSetSampledPeakBytes, 4600);
  assert.equal(r.overall.durationMs, 250); assert.equal(row.post.workingSetMedianBytes, null);
});

test("same checkpoint data does not establish deltas if PID assignment changed or was not checked", () => {
  for (const check of ["different", "unverified"]) {
    const { result: r } = oneRound(check);
    assert.equal(r.pidCheck, check); assert.equal(r.rounds[0].post.medianBytes, 173);
    assert.equal(r.rounds[0].postMinusPreBytes, null); assert.equal(r.rounds[0].postMinusBaselineBytes, null);
  }
});

test("elapsed sampling gaps invalidate an apparently full window", () => {
  const s = createStudy({ ...options, graceMs: 0, windowMs: 100 }); s.startBaseline(0);
  for (const t of [0, 10, 20, 30, 40, 60, 70, 80, 90]) point(s, t, 123);
  s.advance(100);
  const w = s.report().baseline;
  assert.equal(w.sampleCount, 9); assert.equal(w.medianBytes, 123); assert.equal(w.maxGapMs, 20);
  assert.equal(w.valid, false); assert.equal(w.invalidReason, "sampling-gap");
  point(s, 120, 555);
  const r = s.end("target-exited");
  assert.equal(r.overall.coverage, "partial"); assert.equal(r.rounds[0].post, null);
});

test("missing or corrupt primary values cannot become zero-byte readings or inherit working set", () => {
  for (const bad of [0, -1, undefined, null, NaN, Infinity, "500", 1.5]) {
    const s = createStudy(options); s.startBaseline(0);
    point(s, 20, 100); point(s, 30, 110); point(s, 40, bad, 999999); point(s, 50, 120); point(s, 60, 130);
    s.advance(70); const w = s.report().baseline;
    assert.equal(w.sampleCount, 5); assert.equal(w.validSamples, 4);
    assert.equal(w.invalidReason, "missing-reading"); assert.equal(w.medianBytes, 115);
    assert.equal(w.workingSetMedianBytes, 999999); assert.equal(w.maxBytes, 130);
  }
});

test("identity / reader failures retain evidence; incomplete windows are never paired", () => {
  const s = createStudy(options); s.startBaseline(0); windowSamples(s, 0, [1, 2, 3, 4, 5]);
  s.startPre(70, 2); windowSamples(s, 70, [6, 7, 8, 9, 10]); s.startPost(140);
  point(s, 164, 11); point(s, 174, 12);
  const r = s.end("identity-changed", "different");
  assert.equal(r.rounds[0].post.complete, false); assert.equal(r.rounds[0].post.invalidReason, "unfinished-window");
  assert.equal(r.rounds[0].post.medianBytes, 11.5); assert.equal(r.rounds[0].postMinusPreBytes, null);
  assert.equal(r.allRoundsFinished, false); assert.equal(r.allWindowsValid, false);
});

test("two rounds count newly completed turns per batch, with no cross-round pairing", () => {
  const s = createStudy({ ...options, maxRounds: 2 }); s.startBaseline(0); windowSamples(s, 0, [100, 100, 100, 100, 100]);
  for (const [n, start, first, second] of [[2, 80, 100, 140], [3, 240, 300, 290]]) {
    s.startPre(start, n); windowSamples(s, start, Array(5).fill(first)); s.startPost(start + 80);
    windowSamples(s, start + 80, Array(5).fill(second));
  }
  const r = s.end("completed", "same");
  assert.deepEqual(r.rounds.map(x => x.cumulativeNewTurns), [2, 5]);
  assert.deepEqual(r.rounds.map(x => x.postMinusPreBytes), [40, -10]);
  assert.deepEqual(r.rounds.map(x => x.postMinusBaselineBytes), [40, 190]);
});

test("bad user marks, duplicate / backward samples, incomplete completion, and arbitrary labels fail closed", () => {
  assert.throws(() => createStudy({ metric: "PRIVATE_CHAT_TITLE" }), RangeError);
  const s = createStudy(options);
  assert.throws(() => s.startPre(0, 1), RangeError); s.startBaseline(1); point(s, 2, 10);
  assert.throws(() => point(s, 2, 20), RangeError); assert.throws(() => point(s, 1, 20), RangeError);
  assert.throws(() => s.startPost(2), RangeError); assert.throws(() => s.end("completed", "same"), RangeError);
  assert.throws(() => s.end("PRIVATE_CHAT_TITLE"), RangeError);
  s.advance(80); assert.throws(() => s.startPre(80, 0), RangeError);
  assert.throws(() => s.startPre(80, -2), RangeError); assert.equal(s.phase(), "append");
});

test("raw history and external metadata are not retained in summaries; end is idempotent", () => {
  const s = createStudy(options); s.startBaseline(1000000000);
  s.sample(1000000020, { primaryBytes: 100, title: "private-canary", pid: 1234567 });
  const first = s.end("user-stop"), clone = s.report();
  assert.doesNotMatch(JSON.stringify(first), /private-canary|10000000|1234567/);
  first.baseline.medianBytes = -42; clone.overall.sampledPeakBytes = 1234567;
  assert.equal(s.end("completed", "same").baseline.medianBytes, 100);
  s.sample(1000000050, { primaryBytes: 987654321 });
  assert.equal(s.report().overall.sampledPeakBytes, 100);
});

test("burst sampling hits a bounded buffer instead of presenting a truncated median", () => {
  const s = createStudy(options); s.startBaseline(0);
  for (let i = 0; i < 50; i++) point(s, 20 + i / 2, 110 + i);
  s.advance(70); const w = s.report().baseline;
  assert.equal(w.invalidReason, "sample-cap"); assert.equal(w.medianBytes, null);
  assert.equal(w.maxBytes, 159);
});
