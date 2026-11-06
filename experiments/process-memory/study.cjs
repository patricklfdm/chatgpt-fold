"use strict";

// A marked run, not an on/off experiment. Only aggregate counters and the
// current short checkpoint's numbers survive calls. No process identifiers,
// wall-clock timestamps, page state, user strings or full sample history.
const METRICS = new Set(["windows-private-bytes", "linux-anon-rss-plus-swap"]);
const REASONS = new Set(["completed", "user-stop", "target-exited", "identity-changed", "not-chrome",
  "access-denied", "reader-unavailable", "reader-failed", "context-changed", "time-limit", "interrupted", "input-closed", "output-failed"]);
const PID_CHECKS = new Set(["same", "different", "unverified"]);

function requireValue(ok, msg) { if (!ok) throw new RangeError(msg); }
function positiveBytes(n) { return Number.isSafeInteger(n) && n > 0; }
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[i] : sorted[i - 1] + (sorted[i] - sorted[i - 1]) / 2;
}

function createStudy({ metric, intervalMs = 1000, graceMs = 3000, windowMs = 12000, maxRounds = 3 } = {}) {
  requireValue(METRICS.has(metric), "Unknown process metric");
  requireValue(Number.isSafeInteger(intervalMs) && intervalMs > 0 && intervalMs <= 60000, "Invalid sampling interval");
  requireValue(Number.isSafeInteger(graceMs) && graceMs >= 0 && graceMs <= 120000, "Invalid grace interval");
  requireValue(Number.isSafeInteger(windowMs) && windowMs >= 3 * intervalMs && windowMs <= 300000 &&
    windowMs / intervalMs <= 600, "Invalid checkpoint window");
  requireValue(Number.isSafeInteger(maxRounds) && maxRounds >= 1 && maxRounds <= 50, "Invalid number of rounds");
  const gapLimitMs = 1.75 * intervalMs;
  // One edge sample may fall just outside a window because mark and poll
  // boundaries need not align. Independently reject holes at either edge or
  // between valid readings. A reader failure is missing, never zero bytes.
  const minWindowSamples = Math.max(3, Math.floor(windowMs / intervalMs) - 1);
  const bufferLimit = Math.ceil(2 * windowMs / intervalMs) + 2;
  let phase = "ready", now = null, lastSample = null, total = null, action = null, window = null;
  let baseline = null, measuredUntil = null, final = null, cumulative = 0;
  const rounds = [];
  const current = () => rounds.at(-1);
  function stats(start) {
    return { start, lastValid: null, maxGap: 0, count: 0, n: 0, peak: null, min: null,
      peakPhase: null, peakRound: null, wsPeak: null, wsN: 0 };
  }
  function observe(s, t, value, ws) {
    s.count++;
    if (positiveBytes(value)) {
      s.n++; s.maxGap = Math.max(s.maxGap, t - (s.lastValid ?? s.start)); s.lastValid = t;
      s.min = s.min === null ? value : Math.min(value, s.min);
      if (s.peak === null || value > s.peak) {
        s.peak = value; s.peakPhase = phase; s.peakRound = phase === "baseline" ? null : current().round;
      }
    }
    if (positiveBytes(ws)) { s.wsN++; s.wsPeak = s.wsPeak === null ? ws : Math.max(ws, s.wsPeak); }
  }
  function statView(s, end) {
    if (!s) return null;
    const duration = Math.max(0, end - s.start), gap = Math.max(s.maxGap, Math.max(0, end - (s.lastValid ?? s.start)));
    return { durationMs: Math.round(duration), sampleCount: s.count, validSamples: s.n, invalidSamples: s.count - s.n,
      maxGapMs: Math.round(gap), coverage: s.n === 0 ? "no-valid-samples" : gap > gapLimitMs || s.count !== s.n ? "partial" : "ok",
      sampledPeakBytes: s.peak, sampledPeakPhase: s.peakPhase, sampledPeakRound: s.peakRound,
      workingSetSampledPeakBytes: s.wsPeak, workingSetValidSamples: s.wsN };
  }
  function openWindow(name, time) {
    phase = name;
    const start = time + graceMs;
    window = { name, start, end: start + windowMs, stats: stats(start), observations: [], ws: [], overflow: false };
  }
  function windowView(w, end, complete) {
    const s = statView(w.stats, Math.min(w.end, Math.max(w.start, end)));
    const invalid = !complete ? "unfinished-window" : w.overflow ? "sample-cap" : s.invalidSamples ? "missing-reading"
      : s.validSamples < minWindowSamples ? "too-few-samples" : s.coverage !== "ok" ? "sampling-gap" : null;
    return { ...s, complete, valid: invalid === null, invalidReason: invalid, minBytes: w.stats.min, maxBytes: w.stats.peak,
      medianBytes: w.overflow ? null : median(w.observations), workingSetMedianBytes: w.overflow ? null : median(w.ws) };
  }
  function saveWindow(end, complete) {
    const value = windowView(window, end, complete);
    if (window.name === "baseline") baseline = value; else current()[window.name] = value;
    window = null; // Never retain the observations of a previous checkpoint.
  }
  function openAppend(t) {
    rounds.push({ round: rounds.length + 1, newTurns: null, cumulativeNewTurns: null,
      append: null, pre: null, scroll: null, post: null });
    phase = "append"; action = stats(t);
  }
  function closeAction(t) { current()[phase] = statView(action, t); action = null; }
  function advance(t) {
    if (final) return phase;
    requireValue(Number.isFinite(t) && t >= 0 && (now === null || t >= now), "Non-monotonic study time");
    now = t;
    if (window && t >= window.end) {
      const name = phase, end = window.end;
      saveWindow(end, true);
      if (name === "pre") { phase = "scroll"; action = stats(end); }
      else if (name === "post" && rounds.length === maxRounds) { phase = "await-finish"; measuredUntil = end; }
      else openAppend(end);
    }
    return phase;
  }
  function startBaseline(t) {
    advance(t); requireValue(phase === "ready", "Baseline already started");
    total = stats(t); openWindow("baseline", t); return phase;
  }
  function startPre(t, turns) {
    requireValue(Number.isSafeInteger(turns) && turns > 0 && turns <= 10000, "Expected this round's positive new-turn count");
    advance(t); requireValue(phase === "append", "Pre-scroll mark out of order");
    closeAction(t); current().newTurns = turns; cumulative += turns; current().cumulativeNewTurns = cumulative;
    openWindow("pre", t); return phase;
  }
  function startPost(t) {
    advance(t); requireValue(phase === "scroll", "Post-scroll mark out of order");
    closeAction(t); openWindow("post", t); return phase;
  }
  function sample(t, reading = {}) {
    advance(t);
    if (!total || phase === "await-finish" || phase === "ended") return phase;
    requireValue(lastSample === null || t !== lastSample, "Duplicate sample time");
    lastSample = t;
    const primary = reading?.primaryBytes, ws = reading?.workingSetBytes;
    observe(total, t, primary, ws);
    if (action) observe(action, t, primary, ws);
    if (window && t >= window.start) {
      observe(window.stats, t, primary, ws);
      if (window.stats.count > bufferLimit) window.overflow = true;
      else {
        if (positiveBytes(primary)) window.observations.push(primary);
        if (positiveBytes(ws)) window.ws.push(ws);
      }
    }
    return phase;
  }
  function build(reason = null, pidCheck = "unverified") {
    const allRoundsFinished = rounds.length === maxRounds && current()?.post?.complete === true;
    // An identity or I/O failure cannot publish a formal delta, even if an
    // external caller passes "same". Incomplete pairs also stay descriptive.
    const verified = pidCheck === "same" && (reason === "user-stop" || (reason === "completed" && allRoundsFinished));
    const base = baseline ?? (window?.name === "baseline" ? windowView(window, now, false) : null);
    const list = rounds.map(r => {
      const row = { ...r };
      if (r === current() && action) row[phase] = statView(action, now);
      if (r === current() && window && window.name !== "baseline") row[window.name] = windowView(window, now, false);
      const pair = verified && row.pre?.valid && row.post?.valid;
      // Require a complete, valid pair even for the content-growth comparison.
      row.postMinusPreBytes = pair ? row.post.medianBytes - row.pre.medianBytes : null;
      row.postMinusBaselineBytes = pair && base?.valid ? row.post.medianBytes - base.medianBytes : null;
      return row;
    });
    return { schemaVersion: 1, metric, unit: "bytes", phase, reason, pidCheck,
      protocol: { intervalMs, graceMs, windowMs, maxRounds, minWindowSamples, maxGapRatio: 1.75,
        checkpointBasis: "user-marked-forward-window", peakBasis: "maximum-observed-sample",
        scope: "selected-process-only", gc: "not-forced", tabTotalMemory: "not-measured",
        jsHeap: "not-measured", extensionNetMemoryBenefit: "not-established", attribution: "descriptive-only" },
      overall: statView(total, measuredUntil ?? now), baseline: base, rounds: list, allRoundsFinished,
      allWindowsValid: Boolean(allRoundsFinished && base?.valid && list.every(r => r.pre?.valid && r.post?.valid)) };
  }
  function end(reason, pidCheck = "unverified") {
    if (final) return structuredClone(final);
    requireValue(REASONS.has(reason) && PID_CHECKS.has(pidCheck), "Unknown termination or identity status");
    requireValue(reason !== "completed" || phase === "await-finish", "Protocol rounds unfinished");
    if (window) saveWindow(now, false);
    if (action) closeAction(now);
    phase = "ended"; final = build(reason, pidCheck);
    return structuredClone(final);
  }
  return { advance, startBaseline, startPre, startPost, sample, phase: () => phase, end,
    report: () => structuredClone(final ?? build()) };
}

module.exports = { createStudy };
