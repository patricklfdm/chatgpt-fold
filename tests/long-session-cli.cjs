"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { runCapture, openOutput } = require("../experiments/long-session-memory.cjs");

// Drive the actual interactive orchestration with a monotonic fake clock;
// this test contains no browser or Windows memory measurement.
async function drive({ confirm = "9876543", during, readError, rounds = 1 } = {}) {
  let t = 0, phase, launched = false, marked = false, disclosed = false, checked = false;
  const input = new EventEmitter(), summaries = [], trace = [];
  const out = { append: e => trace.push(e), save(r) { phase = r.phase; summaries.push(r); } };
  const reader = { metric: "windows-private-bytes", async read() {
    if (readError && phase === "append") throw Object.assign(new Error("PRIVATE_ERROR"), { code: "target-exited" });
    t += 1; return { primaryBytes: phase === "scroll" ? 800 : 200, workingSetBytes: 100 };
  } };
  const r = await runCapture({ pid: 9876543, input, out, reader, clock: () => t, config: {
    intervalMs: 10, graceMs: 20, windowMs: 60, maxRounds: rounds
  }, maxMs: 1800, confirmMs: 100, say() {}, sleep: async ms => {
    t += ms;
    if (during?.({ phase, t, input, summaries })) return;
    if (phase === "baseline" && t >= 80 && !disclosed) { disclosed = true; input.emit("line", "99"); }
    else if (phase === "append" && !launched) { launched = true; input.emit("line", "2"); }
    else if (phase === "scroll" && !marked) { marked = true; input.emit("line", ""); }
    else if (phase === "await-finish" && !checked) { checked = true; input.emit("line", confirm); }
  } });
  assert.equal(input.listenerCount("line"), 0);
  assert.equal(summaries.at(-1).status, "finished");
  assert.ok(!JSON.stringify([trace,summaries]).includes("9876543"));
  return { r, trace, summaries };
}
test("interactive run ignores early marks, freezes its peak before final PID verification and writes partial checkpoints", async () => {
  const {r, trace, summaries} = await drive();
  assert.equal(r.reason, "completed"); assert.equal(r.pidCheck, "same"); assert.equal(r.allWindowsValid, true);
  assert.equal(r.rounds[0].newTurns, 2); assert.equal(r.rounds[0].postMinusPreBytes, 0);
  assert.ok(summaries.some(s => s.status === "recording")); assert.equal(trace.at(-1).event, "end");
  assert.ok(!trace.some(s => s.event === "sample" && s.phase === "await-finish"));
});
test("verifying a different tab PID retains readings but suppresses paired changes", async () => {
  const { r } = await drive({ confirm: "456" });
  assert.equal(r.pidCheck, "different"); assert.equal(r.rounds[0].postMinusPreBytes, null);
});
test("change-of-context takes priority over a pending mark at the phase boundary", async () => {
  const {r} = await drive({ during({phase, t, input}) {
    if (phase === "baseline" && t >= 80) { input.emit("line","2"); input.emit("line","x"); return true; }
  } });
  assert.equal(r.reason, "context-changed"); assert.equal(r.pidCheck, "unverified");
});
test("early q is not dropped at a boundary; confirmation waiting time is excluded", async () => {
  let stopped = false;
  const {r} = await drive({ during({phase, t, input}) {
    if (!stopped && phase === "baseline" && t >= 80) { stopped = true; input.emit("line","q"); return true; }
    if (stopped) { input.emit("line","9876543"); return true; }
  } });
  assert.equal(r.reason,"user-stop"); assert.equal(r.pidCheck,"same"); assert.ok(r.overall.durationMs < 100);
});
test("an OS reader failure saves an interrupted summary without the exception text or PID", async () => {
  const {r, trace} = await drive({readError:true});
  assert.equal(r.reason,"target-exited"); assert.equal(r.pidCheck,"unverified");
  assert.ok(r.baseline.valid); assert.equal(r.rounds[0].postMinusPreBytes,null);
  assert.ok(!JSON.stringify([r,trace]).includes("PRIVATE_ERROR"));
});
test("separate sessions never overwrite each other; a later summary replaces only its own checkpoint", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cgf-files-"));
  try {
    const a = openOutput(tmp), b = openOutput(tmp);
    try {
      assert.notEqual(a.dir,b.dir); a.append({tMs:1}); a.save({status:"recording"}); a.save({status:"finished"});
      assert.equal(JSON.parse(fs.readFileSync(path.join(a.dir,"summary.json"), "utf8")).status,"finished");
      assert.equal(JSON.parse(fs.readFileSync(path.join(a.dir,"trace.jsonl"),"utf8")).tMs,1);
      assert.deepEqual(fs.readdirSync(b.dir), ["trace.jsonl"]);
    } finally { a.close(); b.close(); }
  } finally { fs.rmSync(tmp,{recursive:true,force:true}); }
});
