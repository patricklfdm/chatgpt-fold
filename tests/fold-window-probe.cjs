#!/usr/bin/env node
"use strict";

/*
 * Synthetic Chromium regression and measurement driver, NOT a live ChatGPT
 * experiment. Real extension source runs in a CDP isolated world with mocked
 * Chrome APIs. The probe runs in the main world and cannot read that controller.
 * The fixture uses actual row heights; it never reads probe phase labels or
 * data-cgf-active to choose its mounted set.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..");
const PROBE = path.join(ROOT, "experiments", "fold-window-probe.js");
const FIXTURE = path.join(ROOT, "tests", "fixtures", "fold-window.js");
const TEST_URL = "https://chatgpt.com/c/SYNTHETIC_PRIVATE_ROUTE_w83c?private=SYNTHETIC_PRIVATE_QUERY_w83c";
const API = "__CGF_FOLD_WINDOW_PROBE_V1__";
const REPORT = "__CGF_FOLD_WINDOW_REPORT_V1__";
let sources = null;
const HTML = `<!doctype html><html><head><meta charset="utf-8">
<title>SYNTHETIC_PRIVATE_TITLE_w83c</title><link rel="icon" href="data:,">
<style>
* { box-sizing: border-box; }
body { margin: 20px; font: 16px/1.45 system-ui; }
#synthetic-viewport { width: 800px; height: 720px; overflow-y: auto; overflow-anchor: none; }
#synthetic-thread { position: relative; width: 100%; }
.synthetic-turn { position: absolute; left: 0; right: 0; padding: 0 8px; }
.synthetic-question { height: 34px; line-height: 24px; padding: 4px; background: #eee; }
.synthetic-answer { padding-top: 6px; }
.synthetic-answer-body { display: flow-root; }
.synthetic-answer-body p { margin: 8px 0; }
.synthetic-answer-body pre { padding: 8px; margin: 8px 0; background: #f7f7f7; }
.synthetic-code-line { display: block; height: 20px; line-height: 20px; }
form { margin-top: 8px; }
</style></head><body><main><div id="synthetic-viewport" data-app-action-timeline-scroll>
<div id="synthetic-thread"></div></div></main><form data-chatgpt-composer><textarea></textarea></form></body></html>`;

function parseOptions() {
  const values = { headed: false, fixtureOnly: false, output: null };
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--headed") values.headed = true;
    else if (args[index] === "--fixture-only") values.fixtureOnly = true;
    else if (args[index] === "--output" && args[index + 1] && !args[index + 1].startsWith("--")) {
      values.output = path.resolve(args[++index]);
    } else throw new Error(`Unknown or incomplete option: ${args[index]}`);
  }
  if (values.output) {
    assert.ok(values.output.endsWith(".json"), "--output must name a .json file");
    assert.ok(!fs.existsSync(values.output), "Output already exists; choose another path");
  }
  return values;
}

function findPlaywright() {
  const choices = [process.env.CGF_PLAYWRIGHT_MODULE, "playwright", "playwright-core"];
  if (process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES) {
    for (const name of ["playwright", "playwright-core"]) choices.push(path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, name));
  }
  for (const candidate of choices.filter(Boolean)) {
    try { const value = require(candidate); if (value.chromium) return value; }
    catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }
  }
  return null;
}

function chromeMock() {
  const storageListeners = new Set(), messageListeners = new Set();
  const settings = { enabled: true, keepRecent: 0, maxExpanded: 3 };
  globalThis.chrome = {
    storage: { local: { get: async () => ({ "cgf.settings.v1": { ...settings } }) },
      onChanged: { addListener: listener => storageListeners.add(listener),
        removeListener: listener => storageListeners.delete(listener) } },
    runtime: { id: "abcdefghijklmnopabcdefghijklmnop", getManifest: () => ({ version: "0.1.7" }),
      onMessage: { addListener: listener => messageListeners.add(listener),
        removeListener: listener => messageListeners.delete(listener) } }
  };
}

async function isolated(run, expression) {
  const result = await run.cdp.send("Runtime.evaluate", {
    expression, contextId: run.extensionContext, returnByValue: true, awaitPromise: true
  });
  assert.equal(result.exceptionDetails, undefined, "Synthetic isolated-world evaluation failed");
  return result.result.value;
}

function snapshotSources() {
  const files = ["manifest.json", "src/shared.js", "src/adapter.js", "src/content.js", "src/content.css",
    "tests/fixtures/fold-window.js", "tests/fold-window-probe.cjs"];
  if (fs.existsSync(PROBE)) files.push("experiments/fold-window-probe.js");
  return Object.fromEntries(files.map(name => [name, fs.readFileSync(path.join(ROOT, name), "utf8")]));
}

function sourceMetadata() {
  return Object.fromEntries(Object.entries(sources).map(([name, text]) => [name,
    crypto.createHash("sha256").update(text).digest("hex")]));
}

async function setup(browser, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  let requests = 0;
  await context.route("**/*", route => {
    requests += 1;
    return route.request().isNavigationRequest()
      ? route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: HTML })
      : route.abort();
  });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(options.url || TEST_URL, { waitUntil: "domcontentloaded" });
  await page.addStyleTag({ content: sources["src/content.css"] });
  await page.evaluate(sources["tests/fixtures/fold-window.js"]);
  if (options.fixture) await page.evaluate(config => syntheticWindowFixture.configure(config), options.fixture);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Page.enable");
  await cdp.send("Performance.enable");
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id, worldName: "cgf.synthetic.extension"
  });
  const run = { context, page, cdp, errors, extensionContext: executionContextId, requests: () => requests };
  await isolated(run, `(${chromeMock.toString()})()`);
  for (const name of ["shared.js", "adapter.js", "content.js"]) {
    await isolated(run, sources[`src/${name}`]);
  }
  assert.equal(await page.evaluate(() => typeof globalThis.__chatGPTFoldControllerV1), "undefined",
    "The controller accidentally leaked into the page's main world");
  await settle(run);
  return run;
}

async function settle(run) {
  // Poll from Node, not page.waitForFunction: browser-side polling would add
  // tasks to the resource audit used to verify probe cleanup.
  let previous = null, stable = 0;
  for (let attempt = 0; attempt < 70; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const state = await run.page.evaluate(() => {
      const f = syntheticWindowFixture.state();
      return [f.mounted, f.scrollTop, f.scrollHeight,
        document.querySelectorAll("[data-cgf-control]").length,
        document.querySelectorAll('[data-cgf-collapsed="true"]').length].join("|");
    });
    const queued = await isolated(run, `(() => {
      const c = globalThis.__chatGPTFoldControllerV1;
      return !c.timer && !c.scanRoots.size && !c.dirtyRecords.size && !c.fullScan && !c.policyNeeded;
    })()`);
    stable = queued && state === previous ? stable + 1 : 0;
    previous = state;
    if (stable >= 3) return;
  }
  throw new Error("Synthetic native window did not settle");
}

async function memoryMetrics(run) {
  const metrics = Object.fromEntries((await run.cdp.send("Performance.getMetrics")).metrics.map(item => [item.name, item.value]));
  const dom = await run.cdp.send("Memory.getDOMCounters");
  let heap = null;
  try { heap = await run.cdp.send("Runtime.getHeapUsage"); }
  catch (error) { if (!/not found|wasn't found|not supported|unsupported/i.test(error.message)) throw error; }
  const finite = value => Number.isFinite(value) ? value : null;
  return {
    performance: Object.fromEntries(["JSHeapUsedSize", "JSHeapTotalSize", "LayoutObjects", "Documents", "Nodes", "JSEventListeners"]
      .map(key => [key, finite(metrics[key])])),
    dom,
    runtimeHeap: { available: heap !== null, usedSize: finite(heap?.usedSize), totalSize: finite(heap?.totalSize),
      embedderHeapUsedSize: finite(heap?.embedderHeapUsedSize), backingStorageSize: finite(heap?.backingStorageSize) }
  };
}

async function sampleFixture(run, phase) {
  await settle(run);
  const counts = await run.page.evaluate(() => {
    const extensionElements = document.querySelectorAll("[data-cgf-control], [data-cgf-control] *").length;
    const connectedElements = document.getElementsByTagName("*").length;
    return { mountedAnswers: document.querySelectorAll(".synthetic-answer").length,
      connectedElements, extensionElements, nonControlElements: connectedElements - extensionElements,
      intendedCollapsed: document.querySelectorAll('[data-cgf-collapsed="true"]').length,
      intendedExpanded: document.querySelectorAll('[data-cgf-collapsed="false"]').length,
      fixture: syntheticWindowFixture.state() };
  });
  const controller = await isolated(run, `(() => {
    const c = globalThis.__chatGPTFoldControllerV1;
    return { records: c.records.size, disconnectedRecords: [...c.records.keys()].filter(n => !n.isConnected).length,
      openIntents: c.openIntents.size, active: c.active, paused: c.paused };
  })()`);
  const beforeGC = await memoryMetrics(run);
  await run.cdp.send("HeapProfiler.collectGarbage");
  await run.cdp.send("HeapProfiler.collectGarbage");
  await new Promise(resolve => setTimeout(resolve, 120));
  const afterGC = await memoryMetrics(run);
  assert.equal(controller.records, counts.mountedAnswers);
  assert.equal(controller.disconnectedRecords, 0);
  assert.equal(controller.active, true);
  assert.equal(controller.paused, false);
  assert.deepEqual(run.errors, []);
  return { phase, counts, controller, beforeGC, afterGC };
}

async function fixtureComparison(browser, mode) {
  const fixture = { windowed: mode !== "all-rows-mounted", hysteresis: mode === "window-with-hysteresis" };
  const run = await setup(browser, { fixture });
  try {
    const samples = [await sampleFixture(run, "A_folded")];
    await run.page.evaluate(() => document.documentElement.setAttribute("data-cgf-active", "synthetic-fixture-bypass"));
    samples.push(await sampleFixture(run, "B_css_bypassed"));
    await run.page.evaluate(() => document.documentElement.setAttribute("data-cgf-active", "true"));
    samples.push(await sampleFixture(run, "A_restored"));
    const [a, b, restored] = samples.map(item => item.counts.mountedAnswers);
    if (mode === "measured-height-window") {
      assert.ok(a > b, "Height-driven fixture did not mount more rows while folded");
      assert.equal(restored, a, "The measured-height fixture did not recover its folded mounted count");
    } else if (mode === "all-rows-mounted") {
      assert.equal(a, b); assert.equal(restored, a);
    } else {
      assert.equal(a, b, "Contained window was incorrectly pruned despite fixture hysteresis");
    }
    return { mode, samples, fixtureOnly: true, liveChatGPT: false,
      inference: mode === "measured-height-window" ? "height-driven overmounting is reproducible in this synthetic model"
        : mode === "window-with-hysteresis" ? "a previous rendered superset can mask the mounted-count change"
          : "CSS hiding alone leaves the fully mounted fixture DOM connected" };
  } finally { await run.context.close(); }
}

function installProbeAudit() {
  const timers = new Set(), intervals = new Set(), frames = new Set(), observers = new Set(), listeners = [];
  const captured = options => typeof options === "boolean" ? options : Boolean(options?.capture);
  const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
  const timeout = globalThis.setTimeout.bind(globalThis), cancelTimeout = globalThis.clearTimeout.bind(globalThis);
  const interval = globalThis.setInterval.bind(globalThis), cancelInterval = globalThis.clearInterval.bind(globalThis);
  const raf = globalThis.requestAnimationFrame.bind(globalThis), cancelRaf = globalThis.cancelAnimationFrame.bind(globalThis);
  globalThis.setTimeout = (callback, delay, ...args) => {
    const id = timeout(() => { timers.delete(id); callback(...args); }, delay); timers.add(id); return id;
  };
  globalThis.clearTimeout = id => { timers.delete(id); cancelTimeout(id); };
  globalThis.setInterval = (callback, delay, ...args) => { const id = interval(callback, delay, ...args); intervals.add(id); return id; };
  globalThis.clearInterval = id => { intervals.delete(id); cancelInterval(id); };
  globalThis.requestAnimationFrame = callback => {
    const id = raf(time => { frames.delete(id); callback(time); }); frames.add(id); return id;
  };
  globalThis.cancelAnimationFrame = id => { frames.delete(id); cancelRaf(id); };
  for (const name of ["MutationObserver", "ResizeObserver", "IntersectionObserver"]) {
    const NativeObserver = globalThis[name];
    globalThis[name] = class extends NativeObserver {
      observe(...args) { super.observe(...args); observers.add(this); }
      disconnect() { super.disconnect(); observers.delete(this); }
    };
  }
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    add.call(this, type, listener, options);
    if (listener && !listeners.some(item => item.target === this && item.type === type && item.listener === listener && item.capture === captured(options))) {
      listeners.push({ target: this, type, listener, capture: captured(options) });
    }
  };
  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    remove.call(this, type, listener, options);
    const index = listeners.findIndex(item => item.target === this && item.type === type && item.listener === listener && item.capture === captured(options));
    if (index !== -1) listeners.splice(index, 1);
  };
  let contentReads = 0;
  const descriptor = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
  Object.defineProperty(Node.prototype, "textContent", { ...descriptor, get() {
    contentReads += 1; throw new Error("The probe tried to read chat text");
  } });
  Object.defineProperty(document, "title", { configurable: true, get() {
    contentReads += 1; throw new Error("The probe tried to read the page title");
  } });
  globalThis.foldWindowAudit = Object.freeze({ counts: () => ({ timers: timers.size, intervals: intervals.size,
    frames: frames.size, observers: observers.size, listeners: listeners.length, contentReads }) });
}

function checkReport(raw) {
  assert.equal(typeof raw, "string", "A completed probe must expose a copyable JSON string");
  assert.ok(raw.length < 160000, "The probe report is unexpectedly large");
  assert.ok(!raw.includes("SYNTHETIC_PRIVATE_"), "The probe report exported synthetic chat, identity, title, or route data");
  const report = JSON.parse(raw);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.probeVersion, "0.2.0-fold-window.1");
  assert.ok(["completed", "aborted", "rejected", "stopped"].includes(report.outcome));
  assert.ok(Array.isArray(report.phases));
  assert.ok(report.phases.length <= 3);
  return report;
}

async function startProbe(run, source) {
  if (!run.auditInstalled) {
    await run.page.evaluate(installProbeAudit);
    run.auditInstalled = true;
  }
  const requests = run.requests();
  await run.page.evaluate(source);
  run.probeRequestBaseline = requests;
}

async function finished(run, timeout = 95000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await run.page.evaluate(({ api, out }) => ({ raw: globalThis[out], active: Boolean(globalThis[api]) }),
      { api: API, out: REPORT });
    if (typeof state.raw === "string" && !state.active) {
      const report = checkReport(state.raw);
      // Allow the cancelled async continuation to unwind. This Node timer is
      // outside the page and cannot hide a leftover probe timer or listener.
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.equal(await run.page.evaluate(name => Boolean(globalThis[name]), API), false);
      assert.deepEqual(await run.page.evaluate(() => foldWindowAudit.counts()),
        { timers: 0, intervals: 0, frames: 0, observers: 0, listeners: 0, contentReads: 0 },
        "The probe left resources active or read private page content");
      assert.equal(run.requests(), run.probeRequestBaseline, "The probe made a network request");
      assert.deepEqual(run.errors, []);
      return report;
    }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error("Probe did not finish before the test deadline");
}

function acceleratedSource(source) {
  // Only this in-memory test copy is shortened. The full-cycle regression uses
  // the exact source bytes and original 6 s / 1.5 s timings from the repository.
  const marker = /const TIMING = \{ settleMs: \d+, sampleMs: \d+, pollMs: \d+, anchorWaitMs: \d+ \};/g;
  assert.equal([...source.matchAll(marker)].length, 1, "Probe timing declaration changed; review accelerated test setup");
  return source.replace(marker, "const TIMING = { settleMs: 600, sampleMs: 120, pollMs: 40, anchorWaitMs: 1800 };");
}

function completedComparison(report, expectedGrowth) {
  assert.equal(report.outcome, "completed", `Unexpected probe outcome: ${report.reason}`);
  assert.equal(report.reason, null);
  assert.deepEqual(report.phases.map(phase => phase.phase), ["A_folded", "B_css_bypassed", "A_restored"]);
  for (const phase of report.phases) {
    assert.equal(phase.snapshots.length, 3);
    for (const sample of phase.snapshots) {
      assert.equal(sample.anchor.matched, true);
      assert.ok(Math.abs(sample.anchor.errorPx) <= 2);
      assert.ok(sample.counts.extensionElements > 0, "Controls should remain mounted during CSS bypass");
      assert.ok(sample.counts.nativeTurnElements < sample.counts.scopeElements,
        "Native element counts accidentally included the extension controls");
    }
  }
  assert.equal(report.measurement.extensionController, "running-in-both-conditions");
  assert.equal(report.measurement.tabTotalMemory, "not-measured");
  assert.equal(report.measurement.netMemoryBenefit, "not-established");
  assert.equal(report.measurement.nativeController, "not-called");
  assert.equal(report.measurement.gc, "not-forced");
  assert.equal(report.summary.allPhasesComplete, true);
  assert.equal(report.summary.countsStableAll, true);
  assert.equal(report.summary.comparisonValid, true);
  assert.equal(report.summary.netMemoryBenefit, "not-established");
  assert.equal(report.summary.foldedCountsRecovered, true);
  const delta = report.summary.restoredFoldedMinusBypassed.registeredAnswers;
  if (expectedGrowth) assert.ok(delta > 0, "Expected the synthetic measured-height window to contain more folded rows");
  else assert.equal(delta, 0, "A fixed or containing-range fixture should not remove rows for this switch");
  assert.equal(report.cleanup.resourcesReleased, true);
}

async function probeRegressions(browser, source, result, persist) {
  const fast = acceleratedSource(source);
  result.testTiming = { originalTiming: "Repository source, including the full 6 s settle / 1.5 s sample delays",
    acceleratedTiming: "In-memory test copy only: 600 ms settle, 120 ms sample, 40 ms poll, 1800 ms anchor wait",
    acceleratedSourceSha256: crypto.createHash("sha256").update(fast).digest("hex") };
  let failed = 0;
  async function test(name, action, config = {}) {
    const run = await setup(browser, config);
    try {
      const extra = await action(run);
      result.tests.push({ name, passed: true, ...extra });
      console.log(`PASS ${name}`);
    } catch (error) {
      failed += 1;
      result.tests.push({ name, passed: false, error: error.message });
      console.error(`FAIL ${name}: ${error.message}`);
    } finally { persist(); await run.context.close(); }
  }

  await test("full original-timing A/B/A keeps the same semantic anchor and restores the CSS gate", async run => {
    await startProbe(run, source);
    const report = await finished(run);
    completedComparison(report, true);
    assert.equal(report.timing.settleMs, 6000);
    assert.equal(report.timing.sampleMs, 1500);
    assert.ok(report.phases.at(-1).snapshots.at(-1).elapsedMs >= 26000,
      "The original-timing regression did not actually wait through all three phases");
    assert.equal(await run.page.evaluate(() => document.documentElement.getAttribute("data-cgf-active")), "true");
    return { timing: "original", report };
  });

  await test("strong manual-open intent survives native unmounts during the CSS-only comparison", async run => {
    await isolated(run, `(() => {
      const c = globalThis.__chatGPTFoldControllerV1;
      c.rememberOpen(c.order.at(-1)); c.applyPolicy();
    })()`);
    await settle(run);
    const before = await isolated(run, "[...globalThis.__chatGPTFoldControllerV1.openIntents]");
    assert.equal(before.length, 1);
    await startProbe(run, fast);
    const report = await finished(run, 20000);
    completedComparison(report, true);
    assert.deepEqual(await isolated(run, "[...globalThis.__chatGPTFoldControllerV1.openIntents]"), before,
      "The CSS comparison reset the synthetic user's stable manual-open intent");
    return { timing: "accelerated" };
  });

  await test("native containing-range hysteresis is observed without claiming a memory verdict", async run => {
    await startProbe(run, fast);
    const report = await finished(run, 20000);
    completedComparison(report, false);
    return { timing: "accelerated", report };
  }, { fixture: { hysteresis: true } });

  await test("fixed DOM and unavailable heap estimates stay distinct from an unmount result", async run => {
    await run.page.evaluate(() => {
      syntheticWindowFixture.pause();
      const style = document.createElement("style");
      style.textContent = ".synthetic-turn{position:relative!important;top:auto!important}#synthetic-thread{height:auto!important}";
      document.head.append(style);
      document.getElementById("synthetic-viewport").scrollTop = 90;
      Object.defineProperty(performance, "memory", { configurable: true, value: undefined });
    });
    await settle(run);
    await startProbe(run, fast);
    const report = await finished(run, 20000);
    completedComparison(report, false);
    assert.ok(report.phases.every(phase => phase.snapshots.every(sample => sample.jsHeapEstimate === null)));
    return { timing: "accelerated" };
  });

  await test("external extension pause during bypass is respected and never re-enabled by cleanup", async run => {
    await startProbe(run, fast); await waitBypassed(run);
    await isolated(run, 'globalThis.__chatGPTFoldControllerV1.command("restore")');
    const report = await finished(run, 15000);
    assert.equal(report.outcome, "aborted"); assert.equal(report.reason, "external_gate_change");
    assert.equal(report.cleanup.gate, "external-change-respected");
    assert.equal(await run.page.evaluate(() => document.documentElement.getAttribute("data-cgf-active")), null);
    assert.deepEqual(await isolated(run, "({active:__chatGPTFoldControllerV1.active,paused:__chatGPTFoldControllerV1.paused})"),
      { active: false, paused: true });
    return { timing: "accelerated" };
  });

  await test("new generation during bypass aborts and restores the owned CSS gate", async run => {
    await startProbe(run, fast); await waitBypassed(run);
    await run.page.evaluate(() => {
      const stop = document.createElement("button"); stop.dataset.testid = "stop-button";
      stop.textContent = "Synthetic Stop"; document.body.append(stop);
    });
    const report = await finished(run, 15000);
    assert.equal(report.outcome, "aborted"); assert.equal(report.reason, "generation_active");
    assert.equal(await run.page.evaluate(() => document.documentElement.getAttribute("data-cgf-active")), "true");
    return { timing: "accelerated" };
  });

  await test("trusted wheel input aborts without fighting the user's new scroll position", async run => {
    await run.page.mouse.move(400, 300);
    await startProbe(run, fast); await waitBypassed(run);
    await run.page.mouse.wheel(0, 140);
    const report = await finished(run, 15000);
    assert.equal(report.outcome, "aborted"); assert.equal(report.reason, "user_interaction");
    assert.equal(report.cleanup.scroll, "skipped-user-interaction");
    assert.equal(await run.page.evaluate(() => document.documentElement.getAttribute("data-cgf-active")), "true");
    return { timing: "accelerated" };
  });

  await test("route changes abort rather than aligning a different conversation", async run => {
    await startProbe(run, fast); await waitBypassed(run);
    await run.page.evaluate(() => history.pushState({}, "", "/c/SYNTHETIC_PRIVATE_OTHER_ROUTE_w83c"));
    const report = await finished(run, 15000);
    assert.equal(report.outcome, "aborted"); assert.equal(report.reason, "route_changed");
    assert.equal(report.cleanup.scroll, "skipped-context-change");
    return { timing: "accelerated" };
  });

  await test("body replacement aborts and releases references to the old measurement context", async run => {
    await startProbe(run, fast); await waitBypassed(run);
    await run.page.evaluate(() => document.body.replaceWith(document.body.cloneNode(true)));
    const report = await finished(run, 15000);
    assert.equal(report.outcome, "aborted"); assert.equal(report.reason, "body_changed");
    assert.equal(report.cleanup.scroll, "skipped-context-change");
    return { timing: "accelerated" };
  });

  await test("hidden-page transition aborts (explicitly mocked visibility state)", async run => {
    await startProbe(run, fast); await waitBypassed(run);
    await run.page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const report = await finished(run, 15000);
    assert.equal(report.outcome, "aborted"); assert.equal(report.reason, "page_hidden");
    assert.equal(await run.page.evaluate(() => document.documentElement.getAttribute("data-cgf-active")), "true");
    return { timing: "accelerated", visibilityState: "explicit test override; not an OS backgrounding test" };
  });

  await test("viewport resizing invalidates cross-phase geometry", async run => {
    await startProbe(run, fast); await waitBypassed(run);
    await run.page.setViewportSize({ width: 1120, height: 920 });
    const report = await finished(run, 15000);
    assert.equal(report.outcome, "aborted"); assert.equal(report.reason, "viewport_changed");
    return { timing: "accelerated" };
  });

  await test("answer edits are not accepted as geometry-only samples", async run => {
    await startProbe(run, fast); await waitBypassed(run);
    await run.page.evaluate(() => document.querySelector('[data-markdown-text-style="assistant-message"] p')
      .append(document.createElement("em")));
    const report = await finished(run, 15000);
    assert.equal(report.outcome, "aborted"); assert.equal(report.reason, "answer_content_changed");
    return { timing: "accelerated" };
  });

  await test("external fold-policy changes invalidate the comparison without resetting private intentions", async run => {
    await startProbe(run, fast); await waitBypassed(run);
    await isolated(run, `(() => {
      const c = globalThis.__chatGPTFoldControllerV1;
      c.rememberOpen(c.order.at(-1)); c.applyPolicy();
    })()`);
    const report = await finished(run, 15000);
    assert.equal(report.outcome, "aborted"); assert.equal(report.reason, "fold_policy_changed");
    assert.equal(await isolated(run, "__chatGPTFoldControllerV1.openIntents.size"), 1,
      "Probe cleanup overwrote a newly made manual-open choice");
    assert.equal(await run.page.evaluate(() => document.documentElement.getAttribute("data-cgf-active")), "true");
    return { timing: "accelerated" };
  });

  for (const kind of ["class", "aria-busy"]) {
    await test(`transient ${kind} generation signal between polling ticks aborts`, async run => {
      await startProbe(run, fast); await waitBypassed(run);
      await run.page.evaluate(kind => {
        const turn = document.querySelector("[data-turn-key]");
        if (kind === "class") {
          turn.classList.add("result-streaming");
          turn.classList.remove("result-streaming");
        } else {
          turn.setAttribute("aria-busy", "true");
          turn.removeAttribute("aria-busy");
        }
      }, kind);
      const report = await finished(run, 15000);
      assert.equal(report.outcome, "aborted"); assert.equal(report.reason, "generation_active");
      assert.equal(await run.page.evaluate(() => document.documentElement.getAttribute("data-cgf-active")), "true");
      return { timing: "accelerated", signal: "set and cleared synchronously before MutationObserver delivery" };
    });
  }

  await test("a gate marker without effective fold CSS is rejected before sampling", async run => {
    await run.page.addStyleTag({ content:
      'html[data-cgf-active="true"] [data-cgf-message][data-cgf-collapsed="true"] > :not([data-cgf-control]) { display: block !important; }' });
    await settle(run);
    await startProbe(run, fast);
    const report = await finished(run, 15000);
    assert.equal(report.outcome, "rejected"); assert.equal(report.reason, "css_exposure_unconfirmed");
    assert.equal(report.cleanup.gate, "not-modified");
    return { timing: "accelerated" };
  });

  await test("deadline during bypass releases all resources and restores the owned gate", async run => {
    assert.equal((fast.match(/durationMs: 90000/g) || []).length, 1);
    const shortDeadline = fast.replace("durationMs: 90000", "durationMs: 1300");
    await startProbe(run, shortDeadline); await waitBypassed(run);
    const report = await finished(run, 15000);
    assert.equal(report.outcome, "aborted"); assert.equal(report.reason, "deadline");
    assert.equal(report.cleanup.gate, "restored");
    assert.equal(await run.page.evaluate(() => document.documentElement.getAttribute("data-cgf-active")), "true");
    return { timing: "accelerated plus a 1300 ms test-only deadline" };
  });

  await test("manual stop, duplicate start, and repeated run clean up without a stale prior report", async run => {
    await startProbe(run, fast); await waitBypassed(run);
    await run.page.evaluate(fast); // Duplicate installation must be a no-op.
    await run.page.evaluate(name => globalThis[name].stop(), API);
    let report = await finished(run, 15000);
    assert.equal(report.outcome, "stopped"); assert.equal(report.reason, "manual_stop");
    await settle(run);
    await startProbe(run, fast);
    assert.equal(await run.page.evaluate(name => typeof globalThis[name], REPORT), "undefined",
      "A newly running probe still exposes a stale completed report");
    report = await finished(run, 20000);
    completedComparison(report, true);
    return { timing: "accelerated" };
  });

  await test("ambiguous duplicate native turn keys are rejected before changing display", async run => {
    await run.page.evaluate(() => {
      syntheticWindowFixture.pause();
      const viewport = document.getElementById("synthetic-viewport").getBoundingClientRect();
      const row = [...document.querySelectorAll("[data-turn-key]")].find(node => {
        const r = node.querySelector("[data-cgf-control]").getBoundingClientRect();
        return r.top >= viewport.top && r.bottom <= viewport.bottom;
      });
      row.parentElement.append(row.cloneNode(true));
    });
    await settle(run);
    await startProbe(run, fast);
    const report = await finished(run, 15000);
    assert.equal(report.outcome, "rejected"); assert.equal(report.reason, "ambiguous_anchor");
    assert.equal(report.cleanup.gate, "not-modified");
    return { timing: "accelerated" };
  });

  await test("too many registered answers reject before any CSS bypass", async run => {
    await startProbe(run, fast);
    const report = await finished(run, 15000);
    assert.equal(report.outcome, "rejected"); assert.equal(report.reason, "answer_limit");
    assert.equal(report.cleanup.gate, "not-modified");
    return { timing: "accelerated" };
  }, { fixture: { windowed: false } });

  await test("excessive connected DOM rejects before any CSS bypass", async run => {
    await run.page.evaluate(() => {
      syntheticWindowFixture.pause();
      const fragment = document.createDocumentFragment();
      for (let i = 0; i < 50010; i += 1) fragment.append(document.createElement("i"));
      document.body.append(fragment);
    });
    await settle(run);
    await startProbe(run, fast);
    const report = await finished(run, 15000);
    assert.equal(report.outcome, "rejected"); assert.equal(report.reason, "element_limit");
    assert.equal(report.cleanup.gate, "not-modified");
    return { timing: "accelerated" };
  });

  await test("missing active extension rejects without touching the gate", async run => {
    await isolated(run, 'globalThis.__chatGPTFoldControllerV1.command("restore")');
    await startProbe(run, fast);
    const report = await finished(run, 15000);
    assert.equal(report.outcome, "rejected"); assert.equal(report.reason, "extension_not_active");
    assert.equal(await run.page.evaluate(() => document.documentElement.getAttribute("data-cgf-active")), null);
    return { timing: "accelerated" };
  });

  await test("wrong origin is rejected even with extension-like synthetic markup", async run => {
    await startProbe(run, fast);
    const report = await finished(run, 15000);
    assert.equal(report.outcome, "rejected"); assert.equal(report.reason, "wrong_page");
    return { timing: "accelerated" };
  }, { url: "https://example.invalid/c/SYNTHETIC_PRIVATE_ROUTE_w83c" });

  if (failed) throw new Error(`${failed} fold-window probe regression(s) failed`);
}

async function waitBypassed(run, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await run.page.evaluate(({ api, report }) => ({ gate: document.documentElement.getAttribute("data-cgf-active"),
      active: Boolean(globalThis[api]), report: typeof globalThis[report] === "string" }), { api: API, report: REPORT });
    if (state.gate && state.gate !== "true" && state.active) return;
    assert.equal(state.report, false, "Probe ended before entering its CSS-bypassed phase");
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error("Probe did not enter its CSS-bypassed phase");
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log(`ChatGPT Fold window experiment regressions and synthetic comparison

  node tests/fold-window-probe.cjs
  node tests/fold-window-probe.cjs --fixture-only --output artifacts/fold-window/model.json
  node tests/fold-window-probe.cjs --output artifacts/fold-window/verified.json
  node tests/fold-window-probe.cjs --headed

Uses intercepted synthetic Chromium pages. No live ChatGPT or tab-total-memory claim.
Content scripts run in a real CDP isolated world, with explicitly mocked Chrome APIs.
--fixture-only runs the height-driven synthetic A/B/A comparisons without the probe.
--output requires a new JSON path. Source digests and measurement boundaries are recorded.
Optional: CGF_PLAYWRIGHT_MODULE, CODEX_PRIMARY_RUNTIME_NODE_MODULES, CHROME_PATH.
Missing Playwright/Chromium exits 2 (NOT RUN), never a pass.`);
    return;
  }
  const options = parseOptions(), playwright = findPlaywright();
  if (!playwright) { console.error("NOT RUN: Playwright is not installed"); process.exitCode = 2; return; }
  const executablePath = [process.env.CHROME_PATH, process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    playwright.chromium.executablePath(), "/usr/bin/chromium", "/usr/bin/chromium-browser"]
    .find(candidate => candidate && fs.existsSync(candidate));
  if (!executablePath) { console.error("NOT RUN: Chromium is not installed; set CHROME_PATH"); process.exitCode = 2; return; }
  if (!options.fixtureOnly && !fs.existsSync(PROBE)) { console.error("NOT RUN: fold-window probe source is unavailable"); process.exitCode = 2; return; }
  sources = snapshotSources();
  const browser = await playwright.chromium.launch({ executablePath, headless: !options.headed,
    args: process.getuid?.() === 0 ? ["--no-sandbox"] : [] });
  const result = { schemaVersion: 1, complete: false, browser: browser.version(), node: process.version,
    sourceSha256: sourceMetadata(),
    scope: "Synthetic Chromium pages only; no account or live ChatGPT access; no private renderer or retention invocation.",
    measurement: { extensionExecution: "real CDP isolated world with mocked chrome APIs; main-world probe has no controller access",
      tabTotalMemory: "not-measured", gc: "fixture comparisons record metrics before and after two explicit CDP collections; probe itself never forces GC",
      nativeModel: "independent measured-height virtual list with optional containing-range hysteresis; not ChatGPT's production renderer",
      memoryMeaning: "CDP JS/embedder metrics and DOM counters are partial measurements, cannot be summed into RSS or total tab memory" },
    fixtures: [], tests: [] };
  const persist = () => {
    if (!options.output) return;
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, JSON.stringify(result, null, 2) + "\n");
  };
  try {
    console.log("MODE: synthetic height-driven window; isolated extension scripts with mock chrome; not live ChatGPT");
    for (const mode of ["measured-height-window", "window-with-hysteresis", "all-rows-mounted"]) {
      const record = await fixtureComparison(browser, mode);
      result.fixtures.push(record); persist();
      console.log(`PASS fixture ${mode}: ${record.samples.map(sample => sample.counts.mountedAnswers).join(" → ")} mounted answers`);
    }
    if (!options.fixtureOnly) {
      const source = sources["experiments/fold-window-probe.js"];
      assert.ok(source.includes(API), "Unexpected probe API");
      await probeRegressions(browser, source, result, persist);
    }
    result.complete = true; persist();
  } catch (error) {
    result.error = error.message; persist(); throw error;
  } finally { await browser.close(); }
}

if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
