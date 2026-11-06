"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { runComparison } = require("../experiments/fixed-conversation-memory.cjs");

// These tests drive the real terminal controller, using a monotonic fake clock
// and synthetic readers. They do not measure Chrome or verify a live page.
const CONFIG = { intervalMs: 10, warmupMs: 20, graceMs: 20, windowMs: 60 };
const PIDS = [9876501, 9876502, 9876503, 9876504];
const clone = value => JSON.parse(JSON.stringify(value));

async function drive({ hook, confirm, confirmDelayMs = 0, confirmMs, metric, maxMs = 20000, readMs = 1,
  failOutput, expectFinished = true, initiallyClosed = false } = {}) {
  let time = 0, active = null, activeSince = 0, ticks = 0;
  const input = new EventEmitter(), summaries = [], trace = [], messages = [];
  const opened = [], closed = [], reads = [], sent = new Set();
  const oldSigint = process.listenerCount("SIGINT"), oldSigterm = process.listenerCount("SIGTERM");
  if (initiallyClosed) input.closed = true;
  const state = kind => ({ kind, t: time, active: active && { ...active }, activeSince,
    input, summaries, trace, opened, closed, reads, messages,
    advance(ms) { time += ms; }, emit(value) { input.emit("line", value); } });
  const out = {
    append(event) {
      if (failOutput?.("append", event, state("append"))) throw new Error("PRIVATE_EXCEPTION");
      trace.push(clone(event));
    },
    save(report) {
      if (failOutput?.("save", report, state("save"))) throw new Error("PRIVATE_EXCEPTION");
      const next = report.active;
      if (`${next?.run}:${next?.phase}` !== `${active?.run}:${active?.phase}`) activeSince = time;
      active = next && { ...next };
      summaries.push(clone(report));
    }
  };
  const openReader = async pid => {
    const run = active?.run, condition = active?.condition;
    opened.push({ run, condition, pid });
    await hook?.(state("open"));
    return {
      metric: typeof metric === "function" ? metric(run) : metric || "windows-private-bytes",
      async read() {
        const phase = active?.phase;
        reads.push({ run, phase, at: time });
        time += readMs;
        await hook?.(state("read"));
        // A late identity verification is intentionally huge: it must not
        // inflate either the observed peak or a measurement window.
        const base = condition === "on" ? 1000 : 2000;
        const primaryBytes = phase === "confirm" ? 999999999 : base +
          (phase === "warmup" ? 9000 : phase === "scroll" ? 5000 : phase === "post" ? 200 : 0);
        return { primaryBytes, workingSetBytes: primaryBytes + 100 };
      },
      async close() {
        closed.push({ run, at: time });
        await hook?.(state("close-reader"));
      }
    };
  };
  async function sleep(ms) {
    time += ms;
    if (++ticks > 5000) throw new Error("test controller failed to finish");
    if (await hook?.(state("sleep"))) return;
    if (!active) return;
    const key = `${active.run}:${active.phase}`;
    if (sent.has(key)) return;
    if (active.phase === "setup") {
      sent.add(key); input.emit("line", `${active.condition} ${PIDS[active.run - 1]}`);
    } else if (active.phase === "scroll" && time - activeSince >= 30) {
      sent.add(key); input.emit("line", "");
    } else if (active.phase === "confirm" && time - activeSince >= confirmDelayMs) {
      sent.add(key);
      const value = typeof confirm === "function" ? confirm(active.run) : confirm;
      input.emit("line", value ?? String(PIDS[active.run - 1]));
    }
  }
  let report;
  try {
    report = await runComparison({ input, out, openReader, say: text => messages.push(String(text)),
      clock: () => time, sleep, config: CONFIG, maxMs, confirmMs: confirmMs ?? Math.max(200, confirmDelayMs + 100) });
  } finally {
    assert.equal(input.listenerCount("line"), 0, "input line handler is released");
    assert.equal(input.listenerCount("SIGINT"), 0, "input interrupt handler is released");
    assert.equal(input.listenerCount("close"), 0, "input EOF handler is released");
    assert.equal(process.listenerCount("SIGINT"), oldSigint, "process SIGINT handler is released");
    assert.equal(process.listenerCount("SIGTERM"), oldSigterm, "process SIGTERM handler is released");
  }
  if (expectFinished) assert.equal(summaries.at(-1)?.status, "finished");
  const persisted = JSON.stringify({ report, summaries, trace });
  for (const pid of PIDS) assert.ok(!persisted.includes(String(pid)), "PID is never written to results");
  assert.ok(!persisted.includes("PRIVATE_INPUT"));
  assert.ok(!persisted.includes("PRIVATE_EXCEPTION"));
  assert.ok(!messages.join("\n").includes("PRIVATE_EXCEPTION"));
  return { report, summaries, trace, messages, opened, closed, reads };
}

test("four matched passes use the declared order, close each reader and exclude delayed confirmation readings", async () => {
  const { report, opened, closed, reads, trace, summaries } = await drive({ confirmDelayMs: 400 });
  assert.equal(report.reason, "completed");
  assert.deepEqual(report.runs.map(r => r.condition), ["on", "off", "off", "on"]);
  assert.deepEqual(opened.map(r => r.pid), PIDS);
  assert.deepEqual(closed.map(r => r.run), [1, 2, 3, 4]);
  assert.ok(report.runs.every(r => r.complete && r.allWindowsValid && r.pidCheck === "same"));
  assert.equal(report.comparison.pairedDifferencesAvailable, true);
  assert.ok(report.comparison.pairs.every(p => p.postMedianOnMinusOffBytes === -1000));
  assert.ok(report.runs.every(r => r.overall.sampledPeakBytes < 999999999));
  assert.ok(report.runs.every(r => r.overall.durationMs < 400), "final confirmation wait is excluded");
  assert.equal(reads.filter(r => r.phase === "confirm").length, 4);
  assert.ok(!trace.some(e => e.event === "sample" && ["setup", "opening", "confirm"].includes(e.phase)));
  assert.ok(summaries.some(r => r.status === "recording" && r.runs.length > 0));
  assert.ok(summaries.every(r => !r.active || r.active.run <= 4), "cleanup never invents a fifth run");
});

test("wrong condition and pasted text cannot select a process; next run starts after prior reader closes", async () => {
  let invalid = false, pasted = false;
  const { report, opened, closed, messages } = await drive({ hook(s) {
    if (s.kind === "sleep" && s.active?.phase === "setup" && s.active.run === 1 && !invalid) {
      invalid = true; s.emit(`off ${PIDS[0]}`); return true;
    }
    if (s.kind === "sleep" && s.active?.phase === "setup" && s.active.run === 1 && !pasted) {
      pasted = true; s.emit("PRIVATE_INPUT".repeat(1000)); return true;
    }
    if (s.kind === "open") assert.equal(s.closed.length, s.active.run - 1);
  } });
  assert.equal(report.reason, "completed");
  assert.equal(opened.length, 4); assert.equal(closed.length, 4);
  assert.ok(!messages.join("\n").includes("PRIVATE_INPUT"));
});

test("a different or unverified final PID preserves readings but prevents paired differences", async () => {
  for (const value of ["3456789", ""]) {
    const { report } = await drive({ confirm: run => run === 2 ? value : String(PIDS[run - 1]) });
    assert.equal(report.runs[1].pidCheck, value ? "different" : "unverified");
    assert.equal(report.runs[1].post.valid, true);
    assert.equal(report.comparison.pairedDifferencesAvailable, false);
    assert.equal(report.comparison.pairs, null);
  }
});

test("an early Enter at a sampling boundary is not reused as the next scroll mark", async () => {
  let sent = false;
  const { report } = await drive({ hook(s) {
    if (!sent && s.kind === "read" && s.active?.phase === "pre" && s.active.run === 1) {
      sent = true; s.advance(CONFIG.windowMs); s.emit("");
    }
  } });
  assert.ok(sent);
  assert.ok(report.runs[0].scroll.durationMs >= 30, "an actual route mark is still required");
  assert.ok(report.discardedBoundaryReads >= 1);
  assert.ok(report.runs[0].discardedBoundaryReads >= 1);
  assert.equal(report.comparison.pairedDifferencesAvailable, false, "skipped first window is not silently repaired");
});

test("q during a pending read wins over an ordinary mark and does not start another run", async () => {
  let stopped = false;
  const { report, opened, closed } = await drive({ hook(s) {
    if (!stopped && s.kind === "read" && s.active?.phase === "pre") {
      stopped = true; s.advance(CONFIG.windowMs); s.emit(""); s.emit("q");
    }
  } });
  assert.equal(report.reason, "user-stop");
  assert.equal(opened.length, 1); assert.equal(closed.length, 1);
  assert.equal(report.comparison.pairedDifferencesAvailable, false);
});

test("x is sticky and overrides q or a pending mark while a read is in flight", async () => {
  let changed = false;
  const { report, closed } = await drive({ hook(s) {
    if (!changed && s.kind === "read" && s.active?.phase === "pre") {
      changed = true; s.advance(CONFIG.windowMs); s.emit(""); s.emit("q"); s.emit("x"); s.emit("q");
    }
  } });
  assert.equal(report.reason, "context-changed");
  assert.equal(report.runs[0].pidCheck, "unverified");
  assert.equal(report.comparison.pairedDifferencesAvailable, false);
  assert.equal(closed.length, 1);
});

test("a second-run reader failure preserves the complete first run and sanitizes the error", async () => {
  let failed = false;
  const { report, closed } = await drive({ hook(s) {
    if (!failed && s.kind === "read" && s.active?.run === 2 && s.active.phase === "pre") {
      failed = true; throw Object.assign(new Error("PRIVATE_EXCEPTION"), { code: "target-exited" });
    }
  } });
  assert.equal(report.reason, "target-exited");
  assert.equal(report.runs[0].complete, true); assert.equal(report.runs[0].pidCheck, "same");
  assert.equal(report.runs[1].pidCheck, "unverified");
  assert.equal(report.comparison.pairedDifferencesAvailable, false);
  assert.deepEqual(closed.map(r => r.run), [1, 2]);
});

test("a later setup failure retains prior results without rebinding another process", async () => {
  const { report, opened, closed } = await drive({ hook(s) {
    if (s.kind === "open" && s.active?.run === 2) {
      throw Object.assign(new Error("PRIVATE_EXCEPTION"), { code: "access-denied" });
    }
  } });
  assert.equal(report.reason, "access-denied");
  assert.equal(report.runs[0].complete, true);
  assert.equal(opened.length, 2); assert.deepEqual(closed.map(r => r.run), [1]);
  assert.equal(report.comparison.pairedDifferencesAvailable, false);
});

test("EOF or interruption preserves an incomplete run and releases its reader and listeners", async () => {
  for (const event of ["close", "SIGINT"]) {
    let interrupted = false;
    const { report, closed } = await drive({ hook(s) {
      if (!interrupted && s.kind === "read" && s.active?.phase === "pre") {
        interrupted = true;
        if (event === "close") s.input.closed = true;
        s.input.emit(event);
      }
    } });
    assert.equal(report.reason, event === "close" ? "input-closed" : "interrupted");
    assert.equal(report.runs[0].complete, false);
    assert.equal(report.comparison.pairedDifferencesAvailable, false);
    assert.equal(closed.length, 1);
  }
});

test("a PID arriving at the confirmation deadline cannot complete a run", async () => {
  const { report, reads, closed } = await drive({ confirmDelayMs: 30, confirmMs: 30 });
  assert.equal(report.reason, "confirmation-timeout");
  assert.equal(report.runs[0].pidCheck, "unverified");
  assert.equal(report.comparison.pairedDifferencesAvailable, false);
  assert.equal(reads.filter(r => r.phase === "confirm").length, 0);
  assert.equal(closed.length, 1);
});

test("a slow final identity read cannot bypass the confirmation or overall deadline", async () => {
  for (const limit of ["confirmation", "overall"]) {
    let delayed = false;
    const { report, closed } = await drive({
      confirmMs: limit === "confirmation" ? 100 : 10000,
      maxMs: limit === "overall" ? 500 : 20000,
      hook(s) {
        if (!delayed && s.kind === "read" && s.active?.phase === "confirm") {
          delayed = true; s.advance(600);
        }
      }
    });
    assert.ok(delayed);
    assert.equal(report.reason, limit === "confirmation" ? "confirmation-timeout" : "time-limit");
    assert.equal(report.runs[0].pidCheck, "unverified");
    assert.ok(report.runs[0].overall.sampledPeakBytes < 999999999);
    assert.ok(report.runs[0].overall.durationMs < 400);
    assert.equal(report.comparison.pairedDifferencesAvailable, false);
    assert.equal(closed.length, 1);
  }
});

test("x during an asynchronous reader open or close prevents the next setup and releases resources", async () => {
  for (const point of ["open", "close-reader"]) {
    let changed = false;
    const { report, opened, closed, reads } = await drive({ hook(s) {
      if (!changed && s.kind === point) { changed = true; s.emit("x"); s.emit("q"); }
    } });
    assert.ok(changed);
    assert.equal(report.reason, "context-changed");
    assert.equal(opened.length, 1); assert.equal(closed.length, 1);
    assert.equal(report.comparison.pairedDifferencesAvailable, false);
    if (point === "open") assert.equal(reads.length, 0);
  }
});

test("a reader close failure is associated with the closing run and suppresses comparison", async () => {
  const { report, opened, closed } = await drive({ hook(s) {
    if (s.kind === "close-reader") throw new Error("PRIVATE_EXCEPTION");
  } });
  assert.equal(report.reason, "reader-failed");
  assert.equal(report.failure.run, 1); assert.equal(report.failure.condition, "on");
  assert.equal(report.failure.phase, "closing");
  assert.equal(report.runs[0].complete, true);
  assert.equal(report.comparison.pairedDifferencesAvailable, false);
  assert.equal(opened.length, 1); assert.equal(closed.length, 1);
});

test("an output failure preserves earlier checkpoints and still closes the active reader", async () => {
  let failed = false;
  const { report, summaries, opened, closed } = await drive({ expectFinished: false,
    failOutput(operation, value) {
      if (!failed && operation === "save" && value.active?.phase === "pre") { failed = true; return true; }
      return false;
    }
  });
  assert.ok(failed);
  assert.equal(report.reason, "output-failed");
  assert.ok(summaries.length > 0);
  assert.equal(summaries.at(-1).status, "recording");
  assert.equal(report.comparison.pairedDifferencesAvailable, false);
  assert.equal(opened.length, 1); assert.equal(closed.length, 1);
});

test("an input stream already closed at entry finishes without opening a process", async () => {
  const { report, opened } = await drive({ initiallyClosed: true });
  assert.equal(report.reason, "input-closed");
  assert.equal(opened.length, 0); assert.equal(report.runs.length, 0);
  assert.equal(report.comparison.pairedDifferencesAvailable, false);
});
