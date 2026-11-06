#!/usr/bin/env node
"use strict";

// Run in a terminal, not the page Console. Only one user-selected OS process
// is sampled. No browser bridge, network, window enumeration or remote debug.
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { performance } = require("node:perf_hooks");
const { createStudy } = require("./process-memory/study.cjs");
const { openWindowsReader } = require("./process-memory/windows-reader.cjs");
const { openLinuxReader } = require("./process-memory/linux-reader.cjs");

const VERSION = "0.2.0-long-session.1";
const DEFAULT = { intervalMs: 1000, graceMs: 3000, windowMs: 12000, maxRounds: 3 };
const MAX_MS = 60 * 60 * 1000, CONFIRM_MS = 2 * 60 * 1000;
const nap = ms => new Promise(resolve => setTimeout(resolve, ms));
const codes = new Set(["not-chrome","target-exited","identity-changed","reader-unavailable","reader-failed","access-denied"]);
const safeError = e => codes.has(e?.code) ? e.code : "reader-failed";
const pidNumber = s => typeof s === "string" && /^[1-9]\d{0,9}$/.test(s) && Number(s) <= 0x7fffffff ? Number(s) : null;
const quiet = p => ["baseline", "pre", "post"].includes(p);

function openOutput(base) {
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(base, "run-"));
  const trace = fs.openSync(path.join(dir, "trace.jsonl"), "wx", 0o600);
  const temp = path.join(dir, "summary.tmp"), summary = path.join(dir, "summary.json");
  return { dir, append(obj) { fs.writeFileSync(trace, JSON.stringify(obj) + "\n"); },
    save(obj) { fs.writeFileSync(temp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 }); fs.renameSync(temp, summary); },
    close() { fs.closeSync(trace); } };
}

// A single async loop serializes reads, operator marks and checkpoint writes.
// Only the CLI supplies live PID selection; tests can inject a synthetic reader.
async function runCapture({ pid, reader, input, out, say = console.log, config = DEFAULT,
  clock = () => performance.now(), sleep = nap, maxMs = MAX_MS, confirmMs = CONFIRM_MS }) {
  const study = createStudy({ ...config, metric: reader.metric });
  const zero = clock(), now = () => Math.max(0, Math.round(clock() - zero));
  let phase, markAt = 0, stopAt = null, stopReason = null, finalReason = null, pidCheck = "unverified";
  let pending = null, quitAt = null, lastSaved = 0, ioFailed = false, discardedBoundaryReads = 0;
  function storage(fn) {
    try { fn(); } catch { ioFailed = true; finalReason = "output-failed"; throw new Error("output-failed"); }
  }
  function envelope(summary, final) {
    return { toolVersion: VERSION, status: final ? "finished" : "recording", scope: "one-user-selected-chrome-process",
      source: reader.metric, units: "bytes", tabTotalMemory: "not-measured", jsHeap: "not-measured",
      gc: "not-forced", checkpointBasis: "operator confirms completed output and tail; not observed by the page",
      discardedBoundaryReads, ...summary };
  }
  const save = () => { storage(() => out.save(envelope(study.report(), false))); lastSaved = now(); };
  const log = event => storage(() => out.append(event));
  function freeze(reason, t) {
    if (stopAt !== null) return;
    stopAt = t; stopReason = reason; phase = "confirm"; pending = null;
    say("采样已停。请在 Chrome 任务管理器复核同一个标签行的 PID，输入现在看到的数字；不确定则回车。");
    save();
  }
  function announce(t) {
    const next = study.phase();
    if (next === phase || stopAt !== null) return;
    phase = next; markAt = t; log({ event: "phase", tMs: t, phase: next });
    if (next === "await-finish") { freeze("completed", t); return; }
    if (quiet(next)) say("现在切回 Chrome，停在最新回答末尾。保持不操作约 " +
      Math.ceil((config.windowMs + config.graceMs) / 1000) + " 秒，到下一个提示再继续。");
    if (next === "append") say("新增回答：照常聊，建议 2 条。最后一条生成完、回到末尾后，输入本组实际新增回答数再回车。");
    if (next === "scroll") say("翻阅：从刚才的末尾向上翻约 3 屏，再回到同一条回答末尾；中间不发消息。回到末尾后按回车。");
    save();
  }
  function advance(t) { if (stopAt === null) { study.advance(t); announce(t); } }
  // Do not buffer a pasted transcript, or apply an early Enter to a later stage.
  function line(s) {
    if (typeof s !== "string") return;
    const value = s.length <= 12 ? s.trim() : "?";
    if (value === "x") { finalReason = "context-changed"; pidCheck = "unverified"; pending = null; return; }
    if (value === "q") {
      if (stopAt !== null) finalReason = stopReason;
      else quitAt ??= now();
      pending = null; return;
    }
    if (pending || quitAt !== null && stopAt === null) return;
    pending = { phase, value: /^(?:[0-9]{1,10}|[qx]?)$/.test(value) ? value : "?" };
  }
  const interrupt = () => { finalReason = "interrupted"; };
  const eof = () => { finalReason ??= "input-closed"; };
  function region(t) {
    if (!quiet(phase)) return phase;
    const age = t - markAt;
    return phase + (age < config.graceMs ? "-grace" : age < config.graceMs + config.windowMs ? "-window" : "-done");
  }
  input.on("line", line); input.on("SIGINT", interrupt); input.on("close", eof);
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  try {
    study.startBaseline(0); announce(0);
    while (!finalReason) {
      if (quitAt !== null && quitAt < maxMs && stopAt === null) {
        advance(quitAt); if (stopAt === null) freeze("user-stop", quitAt);
      }
      const t = now();
      if (t >= maxMs && stopAt === null) { advance(maxMs); if (stopAt === null) { finalReason = "time-limit"; break; } }
      advance(t);
      if (pending) {
        const cmd = pending; pending = null;
        if (cmd.phase !== phase) say("这次按键早于当前阶段，已忽略。请按最新提示操作。");
        else if (phase === "confirm") {
          const other = pidNumber(cmd.value);
          if (other !== null || cmd.value === "") {
            if (other === pid) {
              // The original OS process must also still be alive. Don't add
              // this late identity check to the measured interval or its peak.
              await reader.read(); if (finalReason) break; pidCheck = "same";
            } else pidCheck = other === null ? "unverified" : "different";
            finalReason = stopReason; break;
          } else say("请输入当前标签行的数字 PID；无法复核时直接回车。");
        } else if (phase === "append" && /^[1-9]\d?$/.test(cmd.value)) {
          const turns = Number(cmd.value);
          study.startPre(t, turns); log({ event: "new-turns", tMs: t, count: turns }); announce(t);
        } else if (phase === "scroll" && cmd.value === "") { study.startPost(t); announce(t); }
        else if (quiet(phase)) say("正在采尾部窗口，这次按键不会作为下一阶段的标记。");
        else say(phase === "append" ? "请输入本组实际新增的回答数（1–99），例如 2。" : "回到本轮同一末尾后，直接按回车。");
      }
      if (finalReason) break;
      if (stopAt !== null) {
        if (now() - stopAt >= confirmMs) { finalReason = stopReason; break; }
        await sleep(Math.min(250, config.intervalMs)); continue;
      }
      const from = now(), fromRegion = region(from), before = phase;
      const value = await reader.read(), at = now();
      if (finalReason) break;
      if (quitAt !== null && stopAt === null) continue;
      if (at >= maxMs) { advance(maxMs); if (stopAt === null) finalReason = "time-limit"; continue; }
      advance(at);
      if (stopAt === null && before === phase && fromRegion === region(at)) {
        study.sample(at, value);
        log({ event: "sample", tMs: at, phase, primaryBytes: value.primaryBytes, workingSetBytes: value.workingSetBytes });
      } else discardedBoundaryReads += 1;
      if (at - lastSaved >= 10000 && stopAt === null) save();
      await sleep(Math.max(1, config.intervalMs - (now() - from)));
    }
  } catch (error) { finalReason ??= ioFailed ? "output-failed" : safeError(error); }
  finally {
    input.off("line", line); input.off("SIGINT", interrupt); input.off("close", eof);
    process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
  }
  // No pending reader call or periodic task remains beyond this point.
  if (stopAt === null) study.advance(Math.min(now(), maxMs));
  const report = envelope(study.end(finalReason || "user-stop", pidCheck), true);
  if (!ioFailed) { log({ event: "end", tMs: stopAt ?? Math.min(now(), maxMs), reason: report.reason, pidCheck }); storage(() => out.save(report)); }
  return report;
}

function askPid(input) {
  return new Promise(resolve => {
    const finish = n => { input.off("line", line); input.off("SIGINT", cancel); input.off("close", cancel); resolve(n); };
    const cancel = () => finish(null);
    const line = s => { const n = pidNumber(s.trim()); if (n) finish(n); else console.log("请输入数字 PID，不要输入标签标题。"); };
    input.on("line", line); input.on("SIGINT", cancel); input.on("close", cancel);
  });
}
const help = `长会话内存记录（Node.js 20+，本机运行）
  npm run study:memory

Windows / Linux 原生 Chrome：在同一会话用相同折叠设置，等生成结束并回到最新回答底部。
在 Chrome 自己的任务管理器中显示「进程 ID」，认准这个标签页的行。输入 PID 后切回 Chrome。
每组先新增回答，生成结束、滚到尾部后在终端输入本组实际新增条数；再向上翻约 3 屏，
返回同一末尾后按回车。每次标记后保持约15秒不操作。默认 3 组，可输入 q 提前结束；
若已知页面重新加载或换了进程，用 x 终止本轮。结束时再核对一次 PID。
程序只读该 OS 进程计数，不发消息、不读页面、不需要打开 DevTools。原始采样和摘要写到本地
artifacts/long-session/run-*/，不会上传。请只提供 summary.json。详见 docs/LONG_SESSION_MEMORY.md。`;

async function main() {
  if (process.argv.slice(2).length) {
    if (process.argv.length === 3 && ["--help","-h"].includes(process.argv[2])) return console.log(help);
    throw new Error("unknown-option");
  }
  if (!["win32","linux"].includes(process.platform)) {
    console.error("此平台暂不自动采集。请用 Chrome 任务管理器的 Memory footprint；见 docs/LONG_SESSION_MEMORY.md。");
    process.exitCode = 2; return;
  }
  if (process.platform === "linux" && /microsoft|wsl/i.test(require("node:os").release())) {
    console.error("Windows 桌面 Chrome 请从原生 Windows 终端运行，不能使用 WSL 中的 PID。");
    process.exitCode = 2; return;
  }
  console.log(help);
  const input = readline.createInterface({ input: process.stdin, output: process.stdout, historySize: 0 });
  let reader, out;
  try {
    console.log("确认已经在最新回答末尾，输入这行的进程 ID 并回车：");
    const pid = await askPid(input); if (pid === null) return;
    reader = process.platform === "win32" ? await openWindowsReader(pid) : await openLinuxReader(pid);
    if (input.closed) return;
    try { out = openOutput(path.join(__dirname, "..", "artifacts", "long-session")); }
    catch { throw new Error("output-failed"); }
    console.log("本地输出目录：" + out.dir);
    const r = await runCapture({ pid, reader, input, out });
    if (r.reason === "output-failed") throw new Error("output-failed");
    console.log("结束：" + r.reason + "，末次 PID 核对：" + r.pidCheck);
    if (r.pidCheck !== "same") console.log("标签行归属未复核为相同；只保留进程读数，不给正式差值。");
    if (Number.isFinite(r.overall?.sampledPeakBytes)) console.log("该进程主指标已采到的峰值：" + (r.overall.sampledPeakBytes / 1048576).toFixed(1) + " MiB");
    console.log("可提供本次摘要：" + path.join(out.dir, "summary.json"));
    if (!["completed","user-stop"].includes(r.reason)) process.exitCode = 1;
  } finally { input.close(); try { out?.close(); } finally { await reader?.close(); } }
}
module.exports = { runCapture, openOutput, pidNumber };
if (require.main === module) main().catch(error => {
  console.error("记录器未能完成：" + (error?.message === "output-failed" ? "output-failed" :
    error?.message === "unknown-option" ? "参数不支持；用 --help 查看说明" : safeError(error)) + "。已有 trace.jsonl 可保留。");
  process.exitCode = 1;
});
