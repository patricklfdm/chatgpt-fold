#!/usr/bin/env node
"use strict";

// A terminal-only, operator-marked comparison. It never opens the page or
// changes extension settings. Each reload may select a different OS process.
const path = require("node:path");
const readline = require("node:readline");
const { performance } = require("node:perf_hooks");
const { createRun, compareRuns } = require("./process-memory/comparison-study.cjs");
const { openWindowsReader } = require("./process-memory/windows-reader.cjs");
const { openLinuxReader } = require("./process-memory/linux-reader.cjs");
const { openOutput, pidNumber } = require("./long-session-memory.cjs");

const VERSION = "0.2.0-fixed-conversation.1";
const ORDER = Object.freeze(["on", "off", "off", "on"]);
const DEFAULT = Object.freeze({ intervalMs: 1000, warmupMs: 30000, graceMs: 3000, windowMs: 20000 });
const MAX_MS = 60 * 60 * 1000, CONFIRM_MS = 2 * 60 * 1000;
const nap = ms => new Promise(resolve => setTimeout(resolve, ms));
const codes = new Set(["not-chrome", "target-exited", "identity-changed", "reader-unavailable", "reader-failed", "access-denied"]);
const safeError = error => codes.has(error?.code) ? error.code : "reader-failed";
const positive = n => Number.isSafeInteger(n) && n > 0 ? n : null;

function parseSetup(value) {
  if (typeof value !== "string" || value.length > 32) return null;
  const match = /^(on|off)\s+([1-9]\d{0,9})$/i.exec(value.trim());
  const pid = match && pidNumber(match[2]);
  return pid ? { condition: match[1].toLowerCase(), pid } : null;
}

async function runComparison({ input, out, openReader, say = console.log, config = DEFAULT,
  clock = () => performance.now(), sleep = nap, maxMs = MAX_MS, confirmMs = CONFIRM_MS }) {
  const options = { ...DEFAULT, ...config };
  // Validate timing before opening a process. This object is never sampled.
  createRun({ ...options, metric: "windows-private-bytes", run: 1, condition: "on" });
  if (typeof openReader !== "function" || !Number.isFinite(maxMs) || maxMs <= 0 ||
    !Number.isFinite(confirmMs) || confirmMs <= 0) throw new RangeError("Invalid capture configuration");
  const zero = clock(), now = () => Math.max(0, Math.round(clock() - zero));
  const runs = [];
  let current = null, openingReader = null, phase = null, epoch = 0, pending = null;
  let stop = null, reason = null, failedAt = null, confirmAt = null, lastSaved = 0, ioFailed = false;

  function requestStop(code, t = now()) {
    // Context changes must never be lost behind an Enter, a queued quit, EOF,
    // or a reader open/close that is still pending.
    if (!stop || code === "context-changed") stop = { reason: code, t };
    pending = null;
  }
  const active = () => ({ run: current?.number ?? (phase === "closing" ? runs.at(-1)?.run : runs.length + 1),
    condition: current?.condition ?? (phase === "closing" ? runs.at(-1)?.condition : ORDER[runs.length]) ?? null, phase });
  const allRuns = () => current ? [...runs, { ...current.study.report(), discardedBoundaryReads: current.discarded }] : [...runs];
  function envelope(final = false) {
    const list = allRuns(), metrics = [...new Set(list.map(r => r.metric))];
    const outcome = final ? reason : null;
    return { schemaVersion: 1, toolVersion: VERSION, status: final ? "finished" : "recording", reason: outcome,
      scope: "one-user-selected-chrome-process-per-run", source: metrics.length === 1 ? metrics[0] : metrics.length ? "mixed" : "not-measured",
      units: "bytes", tabTotalMemory: "not-measured", jsHeap: "not-measured", gc: "not-forced",
      discardedBoundaryReads: list.reduce((n, r) => n + r.discardedBoundaryReads, 0),
      checkpointBasis: "operator declares extension state, unchanged conversation, matched route and tail; not observed by the page",
      protocol: { order: [...ORDER], ...options, maxDurationMs: maxMs, confirmationTimeoutMs: confirmMs,
        conditionOn: "extension fully enabled, automatic folding active, same settings",
        conditionOff: "extension fully disabled, then page reloaded",
        reload: "required before every run; not proof of a new process or cold caches",
        route: "same historical answers and tail, matched pace; not equal screen count",
        windows: "sampling coverage is not a stability test", peakBasis: "maximum-observed-sample",
        attribution: "descriptive-only", extensionNetMemoryBenefit: "not-established" },
      active: final ? null : active(), failure: failedAt, runs: list,
      comparison: compareRuns(list, { reason: outcome ?? "recording" }) };
  }
  function storage(fn) {
    try { fn(); } catch { ioFailed = true; requestStop("output-failed"); throw new Error("output-failed"); }
  }
  const log = event => storage(() => out.append(event));
  const save = () => { storage(() => out.save(envelope())); lastSaved = now(); };
  function setPhase(next) {
    if (phase === next) return;
    phase = next; epoch += 1;
    const a = active();
    log({ event: "phase", tMs: now(), ...a });
    if (next === "setup") {
      const condition = a.condition;
      say("\n第 " + a.run + "/4 轮：" + (condition === "on" ? "开启扩展（on）" : "完全关闭扩展（off）") + "。");
      say(condition === "on"
        ? "在 chrome://extensions 开启 ChatGPT Fold；确认扩展内自动折叠开启、没有临时恢复，设置保持不变。"
        : "在 chrome://extensions 完全停用 ChatGPT Fold，不是只关闭弹窗中的自动折叠。");
      say("重新加载同一段已完成的对话，回到同一条最新回答末尾，不发送消息。即使本轮开关没变也要重载。");
      say("在 Chrome 任务管理器查看该标签行现在的 PID，输入「" + condition + " 数字PID」并回车，然后切回 Chrome。");
    } else if (next === "warmup") {
      say("现在切回 Chrome，保持在同一末尾，不操作约 " + Math.ceil((options.warmupMs + options.windowMs) / 1000) + " 秒。");
      say("先等待 " + Math.ceil(options.warmupMs / 1000) + " 秒，再自动采翻阅前窗口；等“翻阅”提示再继续。");
    } else if (next === "pre") {
      say("正在采翻阅前窗口，请继续在末尾静置，不要提前滚动。");
    } else if (next === "scroll") {
      say("翻阅：沿同一路线浏览到约定的历史回答，再回到同一条最新回答末尾。四轮经过同一批回答，尽量同样快慢。");
      say("不新增消息、不额外展开组件。返回末尾后在这里直接回车；路线或内容变了请输入 x。");
    } else if (next === "post") {
      say("切回 Chrome，在同一末尾静置约 " + Math.ceil((options.graceMs + options.windowMs) / 1000) + " 秒，等待复核提示。");
    } else if (next === "confirm") {
      confirmAt = now();
      say("本轮采样已停。请复核 Chrome 任务管理器中同一个标签行现在的 PID。");
      say("确认本轮开关状态正确、没有新增消息/重载，经过约定历史回答并返回同一末尾后，输入现在的数字 PID。");
      say("输入数字也表示确认上述操作。不能确认则直接回车停止；发生偏离输入 x，不把它当成有效对照。");
    }
    save();
  }
  function advance(t = now()) {
    if (!current || phase === "confirm") return;
    current.modelTime = Math.max(current.modelTime, t - current.startedAt);
    current.study.advance(current.modelTime);
    const inner = current.study.phase();
    setPhase(inner === "await-confirm" ? "confirm" : inner);
  }
  function line(raw) {
    if (typeof raw !== "string") return;
    const value = raw.length <= 32 ? raw.trim() : "?";
    if (value === "x") { requestStop("context-changed"); return; }
    if (value === "q") { requestStop("user-stop"); return; }
    if (stop || pending) return;
    // Retain at most one bounded, parsed command, never arbitrary input text.
    let command = { kind: "invalid" };
    const setup = parseSetup(value), pid = pidNumber(value);
    if (setup) command = { kind: "setup", ...setup };
    else if (value === "") command = { kind: "enter" };
    else if (pid) command = { kind: "pid", pid };
    pending = { epoch, phase, command };
  }
  const interrupt = () => requestStop("interrupted");
  const eof = () => requestStop("input-closed");
  input.on("line", line); input.on("SIGINT", interrupt); input.on("close", eof);
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  if (input.closed) requestStop("input-closed");

  async function finishCurrent(endReason, pidCheck, t = now()) {
    if (!current) return;
    const c = current;
    c.modelTime = Math.max(c.modelTime, t - c.startedAt);
    c.study.advance(c.modelTime);
    const report = { ...c.study.end(endReason, pidCheck), discardedBoundaryReads: c.discarded };
    phase = "closing"; epoch += 1;
    // Remove the reference before await so exceptional cleanup cannot close it
    // twice. Commands remain tagged with the old epoch during this await.
    const reader = c.reader; c.reader = null;
    try { await reader?.close(); }
    finally { runs.push(report); current = null; }
    if (!ioFailed) {
      log({ event: "run-end", tMs: t, run: c.number, condition: c.condition, reason: endReason, pidCheck });
      save();
    }
  }

  try {
    setPhase("setup");
    while (!stop && !reason) {
      const t = now();
      if (t >= maxMs) { requestStop("time-limit", maxMs); break; }
      advance(t);
      if (stop) break;
      if (phase === "confirm" && t - confirmAt >= confirmMs) { requestStop("confirmation-timeout"); break; }
      if (pending) {
        const item = pending; pending = null;
        const cmd = item.command;
        if (item.epoch !== epoch || item.phase !== phase) {
          say("这次输入早于当前阶段，已忽略。请按最新提示操作。");
        } else if (phase === "setup") {
          if (cmd.kind !== "setup" || cmd.condition !== ORDER[runs.length]) {
            say("请先完成本轮开关和重载，再输入「" + ORDER[runs.length] + " 数字PID」。");
          } else {
            setPhase("opening");
            if (stop) break;
            openingReader = await openReader(cmd.pid);
            if (now() >= maxMs) requestStop("time-limit", maxMs);
            if (stop) break;
            const number = runs.length + 1;
            const study = createRun({ ...options, metric: openingReader.metric, run: number, condition: cmd.condition });
            current = { study, reader: openingReader, pid: cmd.pid, number, condition: cmd.condition,
              startedAt: now(), modelTime: 0, discarded: 0, pidCheck: "unverified" };
            openingReader = null;
            study.start(0); advance(current.startedAt);
          }
        } else if (phase === "scroll" && cmd.kind === "enter") {
          current.modelTime = Math.max(current.modelTime, now() - current.startedAt);
          current.study.startPost(current.modelTime); advance();
        } else if (phase === "confirm" && ["pid", "enter"].includes(cmd.kind)) {
          if (cmd.kind === "enter") { requestStop("user-stop"); break; }
          if (cmd.pid !== current.pid) {
            current.pidCheck = "different"; requestStop("context-changed"); break;
          }
          // Identity/aliveness only. It is never a measured sample or peak.
          await current.reader.read();
          if (stop) break;
          if (now() >= maxMs) { requestStop("time-limit", maxMs); break; }
          if (now() - confirmAt >= confirmMs) { requestStop("confirmation-timeout"); break; }
          current.pidCheck = "same";
          await finishCurrent("completed", "same");
          if (stop) break;
          if (runs.length === ORDER.length) { reason = "completed"; break; }
          setPhase("setup");
        } else {
          say(phase === "confirm" ? "请输入复核后的数字 PID；无法确认时回车停止。" :
            phase === "scroll" ? "返回约定的同一末尾后直接回车。" : "当前正在等待或采样，这次输入不会留作下一阶段标记。");
        }
      }
      if (stop || reason) break;
      if (phase === "confirm") {
        if (now() - confirmAt >= confirmMs) { requestStop("confirmation-timeout"); break; }
        await sleep(Math.min(250, options.intervalMs)); continue;
      }
      if (!current) { await sleep(Math.min(250, options.intervalMs)); continue; }
      const from = now(); advance(from);
      if (stop) break;
      if (phase === "confirm") continue;
      const fromRegion = current.study.region(from - current.startedAt), beforeEpoch = epoch;
      const value = await current.reader.read(), at = now();
      if (stop) break;
      if (at >= maxMs) { requestStop("time-limit", maxMs); break; }
      advance(at);
      if (beforeEpoch === epoch && phase !== "confirm" && fromRegion === current.study.region(at - current.startedAt)) {
        current.study.sample(at - current.startedAt, value);
        log({ event: "sample", tMs: at, run: current.number, condition: current.condition, phase,
          primaryBytes: positive(value?.primaryBytes), workingSetBytes: positive(value?.workingSetBytes) });
      } else current.discarded += 1;
      if (at - lastSaved >= 10000) save();
      await sleep(Math.max(1, options.intervalMs - (now() - from)));
    }
  } catch (error) {
    failedAt = { ...active(), code: ioFailed ? "output-failed" : safeError(error) };
    requestStop(failedAt.code);
  } finally {
    try {
      if (openingReader) { const reader = openingReader; openingReader = null; await reader.close(); }
      if (current) {
        const code = ioFailed ? "output-failed" : stop?.reason ?? reason ?? "user-stop";
        await finishCurrent(code, current.pidCheck, Math.min(stop?.t ?? now(), maxMs));
      }
    } catch (error) {
      failedAt ??= { ...active(), code: ioFailed ? "output-failed" : safeError(error) };
      requestStop(failedAt.code);
    } finally {
      input.off("line", line); input.off("SIGINT", interrupt); input.off("close", eof);
      process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
    }
  }
  reason = ioFailed ? "output-failed" : stop?.reason ?? reason ?? "user-stop";
  const report = envelope(true);
  if (!ioFailed) {
    log({ event: "end", tMs: Math.min(stop?.t ?? now(), maxMs), reason });
    storage(() => out.save(report));
  }
  return report;
}

const help = `固定会话开关对照（Node.js 20+，本机终端运行，无需 npm install）
  node experiments/fixed-conversation-memory.cjs

四轮顺序：开启 -> 完全关闭 -> 完全关闭 -> 开启。每轮都重载同一段已完成的对话。
先选定同一条历史回答作为上翻端点；四轮浏览同一批回答并返回同一末尾，不新增消息。
每轮按提示输入 on 数字PID 或 off 数字PID，切回 Chrome 静置约50秒；按提示翻阅，
返回后回车，再静置约23秒。最后复核该标签行 PID，也确认同一路线和内容没有变化。
Chrome 三点菜单 -> 更多工具 -> 任务管理器（或 Shift+Esc），右键表头显示进程 ID。
on 要求扩展和自动折叠都开启、设置不变；off 要在 chrome://extensions 完全停用后重载。
不需要 DevTools、不修改 PowerShell 执行策略、不读取网页/标题/对话，不自动切换扩展。
输入 q 提前停止；已知路线、内容或页面上下文偏离时用 x。提前停止后请恢复需要的开关状态。
只读取所选 OS 进程计数；输出 artifacts/fixed-conversation/run-*/summary.json 和 trace.jsonl。
不上传数据，分享 summary.json 即可。详见 docs/FIXED_CONVERSATION_MEMORY.md。`;

async function main() {
  const args = process.argv.slice(2);
  if (args.length) {
    if (args.length === 1 && ["--help", "-h"].includes(args[0])) return console.log(help);
    throw new Error("unknown-option");
  }
  if (!["win32", "linux"].includes(process.platform)) {
    console.error("此平台暂不自动采集，请用 Chrome 任务管理器手记；见 docs/FIXED_CONVERSATION_MEMORY.md。");
    process.exitCode = 2; return;
  }
  if (process.platform === "linux" && /microsoft|wsl/i.test(require("node:os").release())) {
    console.error("Windows 桌面 Chrome 请在原生 Windows 终端运行，不使用 WSL 中的 PID。");
    process.exitCode = 2; return;
  }
  console.log(help);
  const input = readline.createInterface({ input: process.stdin, output: process.stdout, historySize: 0 });
  let out;
  try {
    try { out = openOutput(path.join(__dirname, "..", "artifacts", "fixed-conversation")); }
    catch { throw new Error("output-failed"); }
    console.log("本地输出目录：" + out.dir);
    const report = await runComparison({ input, out,
      openReader: process.platform === "win32" ? openWindowsReader : openLinuxReader });
    if (report.reason === "output-failed") throw new Error("output-failed");
    console.log("结束：" + report.reason + "。已记录 " + report.runs.length + "/4 轮。");
    console.log(report.comparison.pairedDifferencesAvailable
      ? "配对差值已写入摘要：on 减 off，负数表示本次开启条件读数更低；不自动认定省内存。"
      : "条件或采样未全部核验，不给正式开关差值；已有读数保留。");
    console.log("可提供本次摘要：" + path.join(out.dir, "summary.json"));
    console.log("请确认扩展开关已恢复到你需要的状态。");
    if (!["completed", "user-stop"].includes(report.reason)) process.exitCode = 1;
  } finally { input.close(); out?.close(); }
}

module.exports = { runComparison, parseSetup, DEFAULT, ORDER };
if (require.main === module) main().catch(error => {
  console.error("对照记录器未能完成：" + (error?.message === "output-failed" ? "output-failed" :
    error?.message === "unknown-option" ? "参数不支持；用 --help 查看说明" : safeError(error)) + "。已有文件可保留。");
  process.exitCode = 1;
});
