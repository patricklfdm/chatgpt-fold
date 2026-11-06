"use strict";

// Bounded per-run statistics for an operator-matched, fixed-content study.
// No browser data, process identity or complete sample history is retained.
const METRICS = new Set(["windows-private-bytes", "linux-anon-rss-plus-swap"]);
const REASONS = new Set(["completed", "user-stop", "target-exited", "identity-changed", "not-chrome",
  "access-denied", "reader-unavailable", "reader-failed", "context-changed", "time-limit", "confirmation-timeout", "interrupted", "input-closed", "output-failed"]);
const PID_CHECKS = new Set(["same", "different", "unverified"]);
const ORDER = Object.freeze(["on", "off", "off", "on"]);
const TIMING_KEYS = ["intervalMs", "warmupMs", "graceMs", "windowMs"];
const requireValue = (ok, message) => { if (!ok) throw new RangeError(message); };
const positiveBytes = n => Number.isSafeInteger(n) && n > 0;
const finite = n => typeof n === "number" && Number.isFinite(n);
function median(values) {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y), i = Math.floor(a.length / 2);
  return a.length % 2 ? a[i] : a[i - 1] + (a[i] - a[i - 1]) / 2;
}

function createRun({ metric, run, condition, intervalMs = 1000, warmupMs = 30000,
  graceMs = 3000, windowMs = 20000 } = {}) {
  requireValue(METRICS.has(metric), "Unknown process metric");
  requireValue(Number.isInteger(run) && run >= 1 && run <= ORDER.length, "Invalid run number");
  requireValue(condition === ORDER[run - 1], "Unexpected run condition");
  requireValue(Number.isSafeInteger(intervalMs) && intervalMs > 0 && intervalMs <= 60000, "Invalid sampling interval");
  requireValue(Number.isSafeInteger(warmupMs) && warmupMs >= 0 && warmupMs <= 300000, "Invalid warmup interval");
  requireValue(Number.isSafeInteger(graceMs) && graceMs >= 0 && graceMs <= 120000, "Invalid grace interval");
  requireValue(Number.isSafeInteger(windowMs) && windowMs >= 3 * intervalMs && windowMs <= 300000 &&
    windowMs / intervalMs <= 600, "Invalid checkpoint window");
  const minWindowSamples = Math.max(3, Math.floor(windowMs / intervalMs) - 1), gapLimitMs = 1.75 * intervalMs;
  const bufferLimit = Math.ceil(2 * windowMs / intervalMs) + 2;
  let phase = "ready", now = null, lastSample = null, total = null, action = null, window = null;
  let warmupEnd = null, measuredUntil = null, final = null;
  let warmup = null, pre = null, scroll = null, post = null;

  function stats(start) {
    return { start, lastValid: null, maxGap: 0, count: 0, n: 0, peak: null, min: null,
      peakPhase: null, wsPeak: null, wsN: 0 };
  }
  function observe(s, t, value, ws) {
    s.count++;
    if (positiveBytes(value)) {
      s.n++; s.maxGap = Math.max(s.maxGap, t - (s.lastValid ?? s.start)); s.lastValid = t;
      s.min = s.min === null ? value : Math.min(s.min, value);
      if (s.peak === null || value > s.peak) { s.peak = value; s.peakPhase = phase; }
    }
    if (positiveBytes(ws)) { s.wsN++; s.wsPeak = s.wsPeak === null ? ws : Math.max(s.wsPeak, ws); }
  }
  function statView(s, end) {
    if (!s) return null;
    const duration = Math.max(0, end - s.start), gap = Math.max(s.maxGap, Math.max(0, end - (s.lastValid ?? s.start)));
    return { durationMs: Math.round(duration), sampleCount: s.count, validSamples: s.n, invalidSamples: s.count - s.n,
      maxGapMs: Math.round(gap), coverage: s.n === 0 ? "no-valid-samples" : gap > gapLimitMs || s.count !== s.n ? "partial" : "ok",
      sampledPeakBytes: s.peak, sampledPeakPhase: s.peakPhase, sampledPeakRun: s.peak === null ? null : run,
      workingSetSampledPeakBytes: s.wsPeak, workingSetValidSamples: s.wsN };
  }
  function openWindow(name, start) {
    phase = name;
    window = { name, start, end: start + windowMs, stats: stats(start), observations: [], overflow: false };
  }
  function windowView(w, end, complete) {
    const s = statView(w.stats, Math.min(w.end, Math.max(w.start, end)));
    const invalid = !complete ? "unfinished-window" : w.overflow ? "sample-cap" : s.invalidSamples ? "missing-reading"
      : s.validSamples < minWindowSamples ? "too-few-samples" : s.coverage !== "ok" ? "sampling-gap" : null;
    const values = w.overflow ? [] : w.observations.filter(p => p.primary !== null);
    const first = median(values.filter(p => p.offsetMs < windowMs / 2).map(p => p.primary));
    const last = median(values.filter(p => p.offsetMs >= windowMs / 2).map(p => p.primary));
    const middle = median(values.map(p => p.primary));
    const range = w.stats.min === null ? null : w.stats.peak - w.stats.min;
    return { ...s, complete, valid: invalid === null, invalidReason: invalid,
      minBytes: w.stats.min, maxBytes: w.stats.peak, medianBytes: middle, rangeBytes: range,
      relativeRangePercent: middle === null ? null : range / middle * 100,
      firstHalfMedianBytes: first, lastHalfMedianBytes: last,
      halfMedianDeltaBytes: first === null || last === null ? null : last - first,
      workingSetMedianBytes: w.overflow ? null : median(w.observations.filter(p => p.workingSet !== null).map(p => p.workingSet)) };
  }
  function closeWindow(end, complete) {
    const result = windowView(window, end, complete);
    if (window.name === "pre") pre = result; else post = result;
    window = null; // Release every per-sample value after its short window.
  }
  function closeAction(t, complete) {
    const result = { ...statView(action, t), complete };
    if (phase === "warmup") warmup = result; else scroll = result;
    action = null;
  }
  function advance(t) {
    if (final) return phase;
    requireValue(finite(t) && t >= 0 && (now === null || t >= now), "Non-monotonic run time");
    now = t;
    if (phase === "warmup" && t >= warmupEnd) {
      closeAction(warmupEnd, true); openWindow("pre", warmupEnd);
    }
    if (window && t >= window.end) {
      const name = window.name, end = window.end;
      closeWindow(end, true);
      if (name === "pre") { phase = "scroll"; action = stats(end); }
      else { phase = "await-confirm"; measuredUntil = end; }
    }
    return phase;
  }
  // Predict the membership of a read's timestamp without advancing the run.
  // The CLI compares these regions before/after each asynchronous OS read.
  function region(t) {
    requireValue(finite(t) && t >= 0, "Invalid region time");
    if (phase === "warmup") return t < warmupEnd ? "warmup" : t < warmupEnd + windowMs ? "pre-window" : "scroll";
    if (window) return t < window.start ? window.name + "-grace"
      : t < window.end ? window.name + "-window" : window.name === "pre" ? "scroll" : "await-confirm";
    return phase;
  }
  function start(t) {
    requireValue(phase === "ready", "Run already started");
    advance(t); total = stats(t); phase = "warmup"; action = stats(t); warmupEnd = t + warmupMs;
    return advance(t);
  }
  function startPost(t) {
    advance(t); requireValue(phase === "scroll", "Post-scroll mark out of order");
    closeAction(t, true); openWindow("post", t + graceMs); return phase;
  }
  function sample(t, reading = {}) {
    advance(t);
    if (!total || phase === "await-confirm" || phase === "ended") return phase;
    requireValue(lastSample === null || t !== lastSample, "Duplicate sample time");
    lastSample = t;
    const primary = reading?.primaryBytes, ws = reading?.workingSetBytes;
    observe(total, t, primary, ws);
    if (action) observe(action, t, primary, ws);
    if (window && t >= window.start) {
      observe(window.stats, t, primary, ws);
      if (window.stats.count > bufferLimit) window.overflow = true;
      else window.observations.push({ offsetMs: t - window.start,
        primary: positiveBytes(primary) ? primary : null, workingSet: positiveBytes(ws) ? ws : null });
    }
    return phase;
  }
  function build(reason = null, pidCheck = "unverified") {
    const first = window?.name === "pre" ? windowView(window, now, false) : pre;
    const last = window?.name === "post" ? windowView(window, now, false) : post;
    const complete = Boolean(first?.complete && last?.complete);
    const valid = Boolean(complete && first.valid && last.valid);
    const verified = reason === "completed" && pidCheck === "same" && valid;
    return { schemaVersion: 1, metric, unit: "bytes", run, condition, phase, reason, pidCheck,
      protocol: { intervalMs, warmupMs, graceMs, windowMs, minWindowSamples, maxGapRatio: 1.75,
        checkpointBasis: "operator-confirmed-fixed-conversation-route", pageState: "not-observed",
        peakBasis: "maximum-observed-sample", scope: "selected-process-only", gc: "not-forced",
        tabTotalMemory: "not-measured", jsHeap: "not-measured", stability: "not-established-by-valid-coverage" },
      overall: statView(total, measuredUntil ?? now),
      warmup: action && phase === "warmup" ? { ...statView(action, now), complete: false } : warmup,
      pre: first, scroll: action && phase === "scroll" ? { ...statView(action, now), complete: false } : scroll,
      post: last, complete, allWindowsValid: valid,
      postMinusPreBytes: verified ? last.medianBytes - first.medianBytes : null };
  }
  function end(reason, pidCheck = "unverified") {
    if (final) return structuredClone(final);
    requireValue(REASONS.has(reason) && PID_CHECKS.has(pidCheck), "Unknown termination or identity status");
    requireValue(reason !== "completed" || phase === "await-confirm", "Run unfinished");
    if (window) closeWindow(now, false);
    if (action) closeAction(now, false);
    phase = "ended"; final = build(reason, pidCheck);
    return structuredClone(final);
  }
  return { start, advance, sample, startPost, phase: () => phase, region, end,
    report: () => structuredClone(final ?? build()) };
}

function compareRuns(runs, { reason = "completed" } = {}) {
  requireValue(Array.isArray(runs) && runs.length <= ORDER.length, "Invalid run list");
  const unavailableReasons = [], scrollPeakUnavailableReasons = [];
  if (reason !== "completed") unavailableReasons.push("study-not-completed");
  if (runs.length !== ORDER.length) unavailableReasons.push("requires-four-runs");
  const metric = runs.length && METRICS.has(runs[0]?.metric) ? runs[0].metric : null;
  if (!metric || runs.some(r => r?.metric !== metric)) unavailableReasons.push("metric-mismatch");
  const sameTimings = runs.length > 0 && TIMING_KEYS.every(k =>
    finite(runs[0]?.protocol?.[k]) && runs.every(r => r?.protocol?.[k] === runs[0].protocol[k]));
  if (!sameTimings) unavailableReasons.push("timing-mismatch");
  runs.forEach((r, i) => {
    if (r?.run !== i + 1 || r?.condition !== ORDER[i]) unavailableReasons.push(`run-${i + 1}-order-mismatch`);
    if (r?.phase !== "ended" || r?.reason !== "completed" || !r?.complete) unavailableReasons.push(`run-${i + 1}-unfinished`);
    if (r?.pidCheck !== "same") unavailableReasons.push(`run-${i + 1}-identity-unverified`);
    if (![r?.pre, r?.post].every(w => w?.complete === true && w.valid === true && finite(w.medianBytes) && w.medianBytes > 0))
      unavailableReasons.push(`run-${i + 1}-invalid-window`);
    if (r?.scroll?.complete !== true || r.scroll.coverage !== "ok" || !positiveBytes(r.scroll.sampledPeakBytes))
      scrollPeakUnavailableReasons.push(`run-${i + 1}-scroll-coverage`);
  });
  const available = unavailableReasons.length === 0;
  const scrollAvailable = available && scrollPeakUnavailableReasons.length === 0;
  const result = { schemaVersion: 1, order: [...ORDER], metric,
    differenceDirection: "on-minus-off", reloadBasis: "ordinary-reload; process-and-caches-may-be-reused",
    checkpointBasis: "operator-declared; page-state-not-observed", attribution: "descriptive-only",
    extensionNetMemoryBenefit: "not-established", pairedDifferencesAvailable: available, unavailableReasons,
    scrollPeakDifferencesAvailable: scrollAvailable, scrollPeakUnavailableReasons,
    pairs: null, conditions: null, onMinusOff: null };
  if (!available) return result;
  const delta = r => r.post.medianBytes - r.pre.medianBytes;
  result.pairs = [[0, 1], [3, 2]].map(([on, off], i) => ({ pair: i + 1,
    onRun: runs[on].run, offRun: runs[off].run,
    preMedianOnMinusOffBytes: runs[on].pre.medianBytes - runs[off].pre.medianBytes,
    postMedianOnMinusOffBytes: runs[on].post.medianBytes - runs[off].post.medianBytes,
    postMinusPreOnMinusOffBytes: delta(runs[on]) - delta(runs[off]),
    scrollPeakOnMinusOffBytes: scrollAvailable ? runs[on].scroll.sampledPeakBytes - runs[off].scroll.sampledPeakBytes : null,
    scrollDurationOnMinusOffMs: finite(runs[on].scroll?.durationMs) && finite(runs[off].scroll?.durationMs)
      ? runs[on].scroll.durationMs - runs[off].scroll.durationMs : null }));
  const spread = values => Math.max(...values) - Math.min(...values);
  const summarize = condition => {
    const selected = runs.filter(r => r.condition === condition), first = selected.map(r => r.pre.medianBytes), last = selected.map(r => r.post.medianBytes);
    return { runNumbers: selected.map(r => r.run), preMedianOfRunMediansBytes: median(first), postMedianOfRunMediansBytes: median(last),
      postMinusPreMedianOfRunDeltasBytes: median(selected.map(delta)), preRepeatSpreadBytes: spread(first), postRepeatSpreadBytes: spread(last),
      scrollMedianOfRunPeaksBytes: scrollAvailable ? median(selected.map(r => r.scroll.sampledPeakBytes)) : null };
  };
  result.conditions = { on: summarize("on"), off: summarize("off") };
  const difference = key => result.conditions.on[key] - result.conditions.off[key];
  result.onMinusOff = { preMedianOfRunMediansBytes: difference("preMedianOfRunMediansBytes"),
    postMedianOfRunMediansBytes: difference("postMedianOfRunMediansBytes"),
    postMinusPreMedianOfRunDeltasBytes: difference("postMinusPreMedianOfRunDeltasBytes"),
    scrollMedianOfRunPeaksBytes: scrollAvailable ? difference("scrollMedianOfRunPeaksBytes") : null };
  return result;
}

module.exports = { createRun, compareRuns, ORDER };
