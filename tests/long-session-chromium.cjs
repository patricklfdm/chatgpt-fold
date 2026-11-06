#!/usr/bin/env node
"use strict";
// Offline, real Linux Chromium process + study state machine. The page and
// turn workload are synthetic. CDP is used ONLY inside this fresh test browser;
// no debugging connections, browser automation, or Python in the user recorder.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { createStudy } = require("../experiments/process-memory/study.cjs");
const { openLinuxReader, openProcfsChromeReader } = require("../experiments/process-memory/linux-reader.cjs");
const ROOT = path.resolve(__dirname, "..");
const url = "https://chatgpt.com/c/offline-process-memory-fixture";

function findChromium() {
  const names = ["playwright", "playwright-core"];
  const paths = [process.env.CGF_PLAYWRIGHT_MODULE, ...names];
  if (process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES) {
    paths.push(...names.map(n => path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, n)));
  }
  for (const p of paths.filter(Boolean)) {
    try { const { chromium } = require(p); if (chromium) return chromium; }
    catch (e) { if (e.code !== "MODULE_NOT_FOUND") throw e; }
  }
}

// Some test containers inherit an outer procfs mount. Only translate the one
// renderer reported by THIS browser, using a real Linux pidfd. No /proc scan.
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
  const scroller = document.querySelector("main");
  let count = 0;
  function append() {
    const key = String(++count), turn = document.createElement("section"), answer = document.createElement("div");
    const question = document.createElement("p"), body = document.createElement("div");
    turn.dataset.turnKey = key; turn.dataset.talvtTurnState = "in_progress";
    question.dataset.userMessageBubble = "true"; question.textContent = "Synthetic question " + key;
    answer.dataset.chatgptSearchUnitKey = key + ":assistant";
    answer.dataset.chatgptSearchMessageIds = "synthetic-" + key;
    body.dataset.markdownTextStyle = "assistant-message";
    answer.append(body); turn.append(question, answer); scroller.append(turn);
    scroller.scrollTop = scroller.scrollHeight;
  }
  function chunk(finish) {
    const turn = scroller.lastElementChild, body = turn.querySelector("[data-markdown-text-style]");
    const paragraph = document.createElement("p");
    paragraph.textContent = "Local fixture paragraph. ".repeat(40); body.append(paragraph);
    if (finish) turn.dataset.talvtTurnState = "complete";
    scroller.scrollTop = scroller.scrollHeight;
  }
  for (let i = 0; i < 48; i++) { append(); chunk(false); chunk(true); }
  window.workload = {
    append, chunk, tail: () => { scroller.scrollTop = scroller.scrollHeight; },
    up: () => { scroller.scrollTop -= scroller.clientHeight; },
    state: () => ({ completed: scroller.querySelectorAll('[data-talvt-turn-state="complete"]').length,
      total: scroller.querySelectorAll("[data-cgf-message]").length, expanded: scroller.querySelectorAll('[data-cgf-collapsed="false"]').length,
      tailKey: scroller.lastElementChild.dataset.turnKey, top: scroller.scrollTop, viewport: scroller.clientHeight,
      atTail: Math.abs(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) < 2 })
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("node tests/long-session-chromium.cjs [--output <new-file.json>]. Requires Linux, Playwright, Chromium. Nested PID test container: Python 3 with os.pidfd_open.");
    return;
  }
  assert.ok(!args.length || (args.length === 2 && args[0] === "--output" && args[1].endsWith(".json")), "Invalid arguments");
  if (args.length) assert.ok(!fs.existsSync(args[1]), "Choose a new output path");
  const chromium = findChromium();
  const executablePath = [process.env.CHROME_PATH, process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    chromium?.executablePath(), "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(p => p && fs.existsSync(p));
  if (process.platform !== "linux" || !chromium || !executablePath) {
    console.error("NOT RUN: Linux, Playwright and Chromium are required for the live OS-counter smoke."); process.exitCode = 2; return;
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const content = manifest.content_scripts[0], load = p => fs.readFileSync(path.join(ROOT, p), "utf8");
  const source = { css: content.css.map(load).join("\n"), js: content.js.map(load) };
  const browser = await chromium.launch({ executablePath,
    args: [...(process.getuid() === 0 ? ["--no-sandbox"] : []), "--renderer-process-limit=1", "--disable-features=SpareRendererForSitePerProcess"] });
  let reader, stop = false, poll = null, samplingFailure = null;
  try {
    const context = await browser.newContext({ viewport: { width: 1000, height: 800 }, serviceWorkers: "block" });
    await context.route("**/*", route => route.request().url() === url ? route.fulfill({ contentType: "text/html", body:
      '<!doctype html><link rel="icon" href="data:,"><style>main{height:640px;width:790px;overflow:auto}section{padding-bottom:16px}p{margin:4px}</style><main></main>' }) : route.abort());
    const page = await context.newPage(); await page.goto(url); await page.evaluate(installFixture);
    await page.addStyleTag({ content: source.css });
    const cdp = await context.newCDPSession(page), { frameTree } = await cdp.send("Page.getFrameTree");
    const { executionContextId } = await cdp.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "cgf.synthetic.memory" });
    // Simulate only the Chrome extension APIs; use the project's real Fold code.
    const mock = 'globalThis.chrome={storage:{local:{get:async()=>({"cgf.settings.v1":{enabled:true,keepRecent:1,maxExpanded:1}})},onChanged:{addListener(){},removeListener(){}}},runtime:{id:"synthetic",getManifest:()=>({version:"0.1.7"}),onMessage:{addListener(){},removeListener(){}}}};';
    for (const expression of [mock, ...source.js]) {
      const result = await cdp.send("Runtime.evaluate", { contextId: executionContextId, expression, awaitPromise: true });
      assert.ok(!result.exceptionDetails, "Failed to install the isolated extension fixture");
    }
    await page.waitForFunction(() => workload.state().total === 48 && workload.state().expanded === 1);
    assert.equal(await page.evaluate(() => typeof window.__chatGPTFoldControllerV1), "undefined");
    await page.evaluate(() => workload.tail());
    const browserCdp = await browser.newBrowserCDPSession();
    async function renderer() {
      const { processInfo } = await browserCdp.send("SystemInfo.getProcessInfo");
      const ids = processInfo.filter(p => p.type === "renderer");
      assert.equal(ids.length, 1, "The test browser must have exactly one renderer"); return ids[0].id;
    }
    const initial = await renderer(), nested = fs.readlinkSync("/proc/self") !== String(process.pid);
    if (nested) await assert.rejects(openLinuxReader(initial), { code: "reader-unavailable" });
    const open = nested ? openProcfsChromeReader : openLinuxReader;
    await assert.rejects(open(procfsPid(process.pid)), { code: "not-chrome" });
    reader = await open(procfsPid(initial));
    const intervalMs = 250, opts = { metric: reader.metric, intervalMs, graceMs: 250, windowMs: 1750, maxRounds: 2 };
    const study = createStudy(opts), start = performance.now(), clock = () => performance.now() - start;
    const geometry = []; study.startBaseline(clock());
    poll = (async () => {
      try {
        while (!stop) {
          const time = performance.now(), sample = await reader.read();
          assert.ok(sample.primaryBytes > 0 && sample.workingSetBytes > 0);
          study.sample(clock(), sample);
          await delay(Math.max(10, intervalMs - (performance.now() - time)));
        }
      } catch (e) { samplingFailure = e; }
    })();
    async function phase(name) {
      const end = performance.now() + 8000;
      while (study.phase() !== name && performance.now() < end) {
        if (samplingFailure) throw samplingFailure; await delay(30);
      }
      assert.equal(study.phase(), name);
    }
    for (let round = 1; round <= opts.maxRounds; round++) {
      await phase("append");
      for (let i = 0; i < 2; i++) {
        await page.evaluate(() => workload.append());
        for (let n = 0; n < 5; n++) { await page.evaluate(last => workload.chunk(last), n === 4); await delay(95); }
      }
      await page.evaluate(() => workload.tail()); const before = await page.evaluate(() => workload.state());
      assert.ok(before.atTail && before.completed === 48 + round * 2 && before.total === before.completed && before.expanded === 1);
      study.startPre(clock(), 2); await phase("scroll");
      for (let i = 0; i < 4; i++) { await page.evaluate(() => workload.up()); await delay(120); }
      const away = await page.evaluate(() => workload.state());
      assert.ok(before.top - away.top >= 3 * before.viewport);
      await page.evaluate(() => workload.tail()); const back = await page.evaluate(() => workload.state());
      assert.ok(back.atTail && back.tailKey === before.tailKey && back.total === before.total);
      geometry.push({ newTurns: 2, returnedToSameTail: true, scrolledScreens: Math.round((before.top - away.top) / before.viewport) });
      study.startPost(clock());
    }
    await phase("await-finish"); stop = true; await poll;
    if (samplingFailure) throw samplingFailure;
    // This verifies the test browser's identity. User runs require their own
    // check in Chrome Task Manager; process liveness is not that check.
    assert.equal(await renderer(), initial);
    const report = study.end("completed", "same");
    assert.ok(report.allRoundsFinished && report.allWindowsValid, "Timing gaps invalidated a checkpoint in this run");
    const details = { scope: "offline synthetic Linux Chromium renderer; not Windows or a signed-in user tab",
      chromeApi: "mocked in isolated world", node: process.version, browser: browser.version(), extension: manifest.version,
      shortenedProtocol: true, geometry, report };
    await browser.close();
    await assert.rejects(reader.read(), e => ["target-exited", "identity-changed"].includes(e.code));
    if (args.length) fs.writeFileSync(args[1], JSON.stringify(details, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ scope: details.scope, shortenedProtocol: true, metric: reader.metric, geometry,
      samples: report.overall.validSamples, peakBytes: report.overall.sampledPeakBytes, baselineBytes: report.baseline.medianBytes,
      prePostBytes: report.rounds.map(r => [r.pre.medianBytes, r.post.medianBytes]), allWindowsValid: report.allWindowsValid,
      processExitDetected: true }));
  } finally {
    stop = true;
    try { await poll; } finally { try { await reader?.close(); } finally { await browser.close(); } }
  }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
