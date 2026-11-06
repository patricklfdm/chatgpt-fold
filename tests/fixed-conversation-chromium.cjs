#!/usr/bin/env node
"use strict";
// Live Linux OS counters and the actual terminal controller, in an offline
// synthetic browser only. This does not establish savings on ChatGPT. CDP and
// the nested-namespace PID translation below are test-only conveniences.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { execFileSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { runComparison, ORDER } = require("../experiments/fixed-conversation-memory.cjs");
const { openLinuxReader, openProcfsChromeReader } = require("../experiments/process-memory/linux-reader.cjs");
const ROOT = path.resolve(__dirname, ".."), URL = "https://chatgpt.com/c/offline-fixed-conversation-fixture";

function findChromium() {
  const names = ["playwright", "playwright-core"];
  const modules = [process.env.CGF_PLAYWRIGHT_MODULE, ...names];
  if (process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES) {
    modules.push(...names.map(n => path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, n)));
  }
  for (const name of modules.filter(Boolean)) {
    try { const { chromium } = require(name); if (chromium) return chromium; }
    catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }
  }
}

// Resolve only THIS controlled browser's renderer, never enumerate /proc.
function procfsPid(pid) {
  if (fs.readlinkSync("/proc/self") === String(process.pid)) return pid;
  return Number(execFileSync("python3", ["-c", [
    "import os, re, sys",
    "fd = os.pidfd_open(int(sys.argv[1]))",
    "try:",
    "    with open('/proc/self/fdinfo/' + str(fd)) as info:",
    "        print(int(re.search(r'^Pid:\\s+([0-9]+)$', info.read(), re.M)[1]))",
    "finally:",
    "    os.close(fd)"
  ].join("\n"), String(pid)], { encoding: "utf8", timeout: 3000 }).trim());
}

function installFixture() {
  const scroller = document.querySelector("main"), count = 48;
  for (let n = 1; n <= count; n++) {
    const turn = document.createElement("section"), question = document.createElement("p");
    const answer = document.createElement("div"), body = document.createElement("div");
    turn.dataset.turnKey = String(n); turn.dataset.talvtTurnState = "complete";
    question.dataset.userMessageBubble = "true"; question.textContent = "Synthetic question " + n;
    answer.dataset.chatgptSearchUnitKey = n + ":assistant";
    answer.dataset.chatgptSearchMessageIds = "fixed-answer-" + n;
    body.dataset.markdownTextStyle = "assistant-message";
    for (let p = 0; p < 2; p++) {
      const paragraph = document.createElement("p");
      paragraph.textContent = "Fixed answer " + n + ": " + "Offline fixture paragraph. ".repeat(40);
      body.append(paragraph);
    }
    answer.append(body); turn.append(question, answer); scroller.append(turn);
  }
  function signature() {
    const text = [...scroller.querySelectorAll("[data-markdown-text-style]")].map(n => n.textContent).join("\n");
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return { length: text.length, hash: hash >>> 0 };
  }
  function state() {
    const bodies = [...scroller.querySelectorAll("[data-markdown-text-style]")];
    return { completed: scroller.querySelectorAll('[data-talvt-turn-state="complete"]').length,
      answers: bodies.length, registered: scroller.querySelectorAll("[data-cgf-message]").length,
      collapsed: scroller.querySelectorAll('[data-cgf-collapsed="true"]').length,
      expanded: scroller.querySelectorAll('[data-cgf-collapsed="false"]').length,
      layoutVisibleBodies: bodies.filter(body => body.getClientRects().length > 0).length,
      tailKey: scroller.lastElementChild.dataset.turnKey, top: scroller.scrollTop,
      atTail: Math.abs(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) < 2,
      nativeSignature: signature() };
  }
  window.workload = {
    state, tail() { scroller.scrollTop = scroller.scrollHeight; return state(); },
    visit(key) {
      const turn = scroller.querySelector('[data-turn-key="' + key + '"]');
      if (!turn) throw new Error("Missing fixture turn");
      scroller.scrollTop += turn.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      const box = turn.getBoundingClientRect(), viewport = scroller.getBoundingClientRect();
      return { key: turn.dataset.turnKey, visible: box.bottom > viewport.top && box.top < viewport.bottom,
        top: scroller.scrollTop, offsetPx: Math.round((box.top - viewport.top) * 10) / 10 };
    }
  };
  workload.tail();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("node tests/fixed-conversation-chromium.cjs [--output <new-file.json>]. Requires Linux, Playwright and Chromium; nested PID test containers also need Python 3 os.pidfd_open.");
    return;
  }
  assert.ok(!args.length || args.length === 2 && args[0] === "--output" && args[1].endsWith(".json"), "Invalid arguments");
  if (args.length) assert.ok(!fs.existsSync(args[1]), "Choose a new output path");
  const chromium = findChromium(), executablePath = [process.env.CHROME_PATH, process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    chromium?.executablePath(), "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(p => p && fs.existsSync(p));
  if (process.platform !== "linux" || !chromium || !executablePath) {
    console.error("NOT RUN: Linux, Playwright and Chromium are required for the fixed-conversation OS-counter smoke.");
    process.exitCode = 2; return;
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const scripts = manifest.content_scripts[0], load = p => fs.readFileSync(path.join(ROOT, p), "utf8");
  const source = { css: scripts.css.map(load).join("\n"), js: scripts.js.map(load) };
  const browser = await chromium.launch({ executablePath,
    args: [...(process.getuid() === 0 ? ["--no-sandbox"] : []), "--renderer-process-limit=1", "--disable-features=SpareRendererForSitePerProcess"] });
  const input = new EventEmitter(), readers = [], geometry = [], selectedPids = [], seen = new Set();
  let capture = null, actions = Promise.resolve(), actionFailure = null, latest = null, signature = null;
  let sampleCount = 0, documentLoads = 0, currentRun = null;
  try {
    const context = await browser.newContext({ viewport: { width: 1000, height: 800 }, serviceWorkers: "block" });
    await context.route("**/*", route => route.request().url() === URL ? route.fulfill({ contentType: "text/html", body:
      '<!doctype html><link rel="icon" href="data:,"><style>main{height:640px;width:790px;overflow:auto}section{padding-bottom:16px}p{margin:4px}</style><main></main>' }) : route.abort());
    const page = await context.newPage(); page.setDefaultTimeout(6000); page.setDefaultNavigationTimeout(10000);
    const browserCdp = await browser.newBrowserCDPSession();
    async function renderer() {
      const { processInfo } = await browserCdp.send("SystemInfo.getProcessInfo");
      const ids = processInfo.filter(p => p.type === "renderer");
      assert.equal(ids.length, 1, "This fresh test browser must have exactly one renderer");
      return ids[0].id;
    }
    function assertState(state, condition) {
      assert.equal(state.completed, 48); assert.equal(state.answers, 48); assert.equal(state.tailKey, "48");
      assert.equal(state.registered, condition === "on" ? 48 : 0);
      assert.equal(state.collapsed, condition === "on" ? 47 : 0);
      assert.equal(state.expanded, condition === "on" ? 1 : 0);
      assert.equal(state.layoutVisibleBodies, condition === "on" ? 1 : 48);
      if (signature) assert.deepEqual(state.nativeSignature, signature, "The fixed answer text changed");
      else signature = state.nativeSignature;
    }
    async function prepare(run, condition) {
      assert.equal(readers.filter(r => !r.closed).length, 0, "Previous pass reader must close before reload");
      if (documentLoads) await page.reload({ waitUntil: "load" }); else await page.goto(URL, { waitUntil: "load" });
      documentLoads++;
      await page.evaluate(installFixture);
      if (condition === "on") {
        await page.addStyleTag({ content: source.css });
        const cdp = await context.newCDPSession(page);
        try {
          const { frameTree } = await cdp.send("Page.getFrameTree");
          const { executionContextId } = await cdp.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "cgf.fixed.synthetic" });
          const mock = 'globalThis.chrome={storage:{local:{get:async()=>({"cgf.settings.v1":{enabled:true,keepRecent:1,maxExpanded:1}})},onChanged:{addListener(){},removeListener(){}}},runtime:{id:"synthetic",getManifest:()=>(' + JSON.stringify({ version: manifest.version }) + '),onMessage:{addListener(){},removeListener(){}}}};';
          for (const expression of [mock, ...source.js]) {
            const evaluation = await cdp.send("Runtime.evaluate", { contextId: executionContextId, expression, awaitPromise: true });
            assert.ok(!evaluation.exceptionDetails, "Could not install the real extension scripts in an isolated world");
          }
          await page.waitForFunction(() => workload.state().registered === 48 && workload.state().collapsed === 47);
        } finally { await cdp.detach(); }
      }
      assert.equal(await page.evaluate(() => typeof window.__chatGPTFoldControllerV1), "undefined");
      const before = await page.evaluate(() => workload.tail()); assertState(before, condition); assert.ok(before.atTail);
      const pid = await renderer(); selectedPids.push(pid);
      currentRun = { run, condition, before, visited: [] };
      input.emit("line", condition + " " + pid);
    }
    async function traverse() {
      const { run, condition, before } = currentRun;
      const route = [...Array.from({ length: 12 }, (_, i) => 47 - i), ...Array.from({ length: 12 }, (_, i) => 37 + i)];
      let far = null;
      for (const key of route) {
        const at = await page.evaluate(n => workload.visit(n), key);
        assert.equal(at.key, String(key)); assert.ok(at.visible, "Every selected answer anchor should enter the viewport");
        currentRun.visited.push(key); if (key === 36) far = at;
        await delay(120);
      }
      assert.ok(far && far.top < before.top, "Historical answer must be above the initial tail");
      const back = await page.evaluate(() => workload.tail());
      assertState(back, condition); assert.ok(back.atTail); assert.equal(back.tailKey, before.tailKey);
      assert.ok(Math.abs(back.top - before.top) < 2, "Return to exactly the same tail geometry");
      geometry.push({ run, condition, fixedAnswers: 48, extensionInstalled: condition === "on",
        layoutVisibleBodies: back.layoutVisibleBodies, historicalAnswer: 36, tailAnswer: 48,
        sameAnswerRoute: currentRun.visited, historicalAnchorVisible: far.visible,
        returnedToSameTail: true, nativeContentUnchanged: true, distancePx: Math.round(before.top - far.top) });
      input.emit("line", "");
    }
    function enqueue(action) {
      actions = actions.then(action).catch(error => { actionFailure ??= error; input.emit("line", "x"); });
    }
    const out = {
      append(event) {
        if (event.event === "sample") {
          assert.ok(event.primaryBytes > 0 && event.workingSetBytes > 0); sampleCount++;
        }
      },
      save(report) {
        latest = structuredClone(report);
        const active = report.active;
        if (!active || !["setup", "scroll", "confirm"].includes(active.phase)) return;
        const key = active.run + ":" + active.phase;
        if (seen.has(key)) return; seen.add(key);
        if (active.phase === "setup") enqueue(() => prepare(active.run, active.condition));
        if (active.phase === "scroll") enqueue(async () => {
          assert.ok(report.runs.at(-1).pre.valid, "Pre-scroll window must have real, complete samples");
          await traverse();
        });
        if (active.phase === "confirm") enqueue(async () => {
          const state = await page.evaluate(() => workload.state()); assertState(state, active.condition); assert.ok(state.atTail);
          const pid = await renderer(); assert.equal(pid, selectedPids[active.run - 1]);
          input.emit("line", String(pid));
        });
      }
    };
    const nested = fs.readlinkSync("/proc/self") !== String(process.pid);
    const config = { intervalMs: 250, warmupMs: 500, graceMs: 250, windowMs: 1750 };
    capture = runComparison({ input, out, config, maxMs: 120000, confirmMs: 5000,
      say: () => {},
      openReader: async pid => {
        assert.equal(pid, selectedPids.at(-1)); assert.equal(readers.filter(r => !r.closed).length, 0);
        const native = await (nested ? openProcfsChromeReader : openLinuxReader)(procfsPid(pid));
        const tracked = { native, closed: false, closeCalls: 0, reads: 0 }; readers.push(tracked);
        return { metric: native.metric,
          async read() { assert.ok(!tracked.closed); tracked.reads++; return native.read(); },
          async close() { tracked.closeCalls++; assert.equal(tracked.closeCalls, 1); await native.close(); tracked.closed = true; } };
      }
    });
    const report = await capture; await actions;
    if (actionFailure) throw actionFailure;
    assert.equal(report.reason, "completed"); assert.deepEqual(report.runs.map(r => r.condition), ORDER);
    assert.equal(documentLoads, 4); assert.equal(report.runs.length, 4); assert.equal(geometry.length, 4);
    assert.ok(report.runs.every(r => r.complete && r.allWindowsValid && r.pidCheck === "same"));
    assert.equal(report.runs.flatMap(r => [r.pre, r.post]).filter(w => w.valid).length, 8);
    assert.equal(report.comparison.pairedDifferencesAvailable, true);
    assert.equal(report.comparison.scrollPeakDifferencesAvailable, true);
    assert.equal(report.comparison.extensionNetMemoryBenefit, "not-established");
    assert.equal(readers.length, 4); assert.ok(readers.every(r => r.closed && r.closeCalls === 1));
    assert.ok(geometry.every(g => JSON.stringify(g.sameAnswerRoute) === JSON.stringify(geometry[0].sameAnswerRoute)));
    assert.equal(sampleCount, report.runs.reduce((n, r) => n + r.overall.validSamples, 0));
    assert.equal(latest.status, "finished"); assert.equal(latest.reason, "completed");
    const details = { scope: "offline synthetic Linux Chromium renderer; not a signed-in ChatGPT page or a Windows benchmark",
      chromeApi: "mocked in isolated world only when condition is on", node: process.version,
      browser: browser.version(), extension: manifest.version, shortenedProtocol: true,
      freshDocumentLoads: documentLoads, pageReloadCalls: documentLoads - 1,
      readersOpened: readers.length, readersClosed: readers.filter(r => r.closed).length,
      independentReaderPerRun: true, uniqueRendererCount: new Set(selectedPids).size,
      nativeContentSignature: signature, geometry, report };
    if (args.length) fs.writeFileSync(args[1], JSON.stringify(details, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ scope: details.scope, browser: details.browser, shortenedProtocol: true,
      freshDocumentLoads: documentLoads, pageReloadCalls: documentLoads - 1,
      readersOpened: readers.length, readersClosed: 4, realProcessSamples: sampleCount,
      validTailWindows: 8, sameContentAndAnswerRoute: true, onOffOrder: report.runs.map(r => r.condition),
      pairedDifferencesAvailable: true, memoryBenefit: "not-established" }));
  } finally {
    input.emit("line", "x");
    try { await capture; await actions; }
    finally {
      for (const reader of readers) if (!reader.closed) await reader.native.close();
      await browser.close();
    }
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
