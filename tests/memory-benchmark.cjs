#!/usr/bin/env node
"use strict";

// Synthetic offline measurements, not a real ChatGPT/MV3 or total-tab-memory test.
// There is deliberately no absolute memory or timing pass/fail threshold.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const TEST_URL = "https://chatgpt.com/c/fold-synthetic-memory-benchmark";
const ADAPTER_METHODS = ["collect", "isAssistant", "identity", "identityHint", "preview",
  "hasDirectText", "hasVisibleStop", "streamingElements"];
const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>ChatGPT Fold synthetic memory benchmark</title><style>
body { margin:20px; font:16px/1.5 system-ui; } main { max-width:760px; margin:auto; }
.turn { margin:24px 0; } .question { background:#eee; padding:10px; }
p { margin:8px 0; } pre { padding:12px; background:#f5f5f5; overflow:auto; }
code { font:13px/1.4 monospace; } .code-line { display:block; }
.kw { color:#8250df; } .num { color:#0550ae; } .comment { color:#57606a; }
</style></head><body><main id="thread"></main>
<textarea aria-label="Synthetic input"></textarea></body></html>`;

function help() {
  console.log(`ChatGPT Fold reproducible synthetic memory / update benchmark

  node tests/memory-benchmark.cjs --output artifacts/memory/current.json
  node tests/memory-benchmark.cjs --output artifacts/memory/compare.json --compare ../fold-v015
  node tests/memory-benchmark.cjs --quick --output artifacts/memory/smoke.json

Options:
  --output <file.json>  Required, must not already exist. Partial results survive a failure.
  --compare <repo>      Also load the content scripts from another local checkout.
  --counts 100,300,600  Mounted answer counts; largest is also the update fixture size.
  --window 20          Answers retained in the fixed-window scenario (minimum 2).
  --turns 1200         Cumulative answers created in the fixed-window scenario.
  --updates 24         Paced mutations per text / neutral-markup phase.
  --repeats 3          Fresh browser repetitions, with rotated mode order.
  --quick              Defaults: counts 20,60; turns 100; updates 4; repeats 1.
  --headed             Show the synthetic browser (default: headless).

Uses explicitly mocked Chrome APIs; every network request is intercepted.
Optional: CGF_PLAYWRIGHT_MODULE, CODEX_PRIMARY_RUNTIME_NODE_MODULES, CHROME_PATH.
Missing Playwright/Chromium exits 2 (NOT RUN), never a pass.
See docs/MEMORY.md for measurement scope and interpretation.`);
}

function options() {
  const values = {};
  const flags = new Set(["--quick", "--headed"]);
  const named = new Set(["--output", "--compare", "--counts", "--window", "--turns", "--updates", "--repeats"]);
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (flags.has(args[i])) values[args[i]] = true;
    else if (named.has(args[i]) && args[i + 1] && !args[i + 1].startsWith("--")) values[args[i]] = args[++i];
    else throw new Error(`Unknown or incomplete option: ${args[i]}`);
  }
  const integer = (name, fallback, min = 1, max = 100000) => {
    const value = Number(values[name] ?? fallback);
    assert.ok(Number.isSafeInteger(value) && value >= min && value <= max, `${name} must be ${min}–${max}`);
    return value;
  };
  assert.ok(values["--output"]?.endsWith(".json"), "Supply --output <file.json>; see --help.");
  const quick = values["--quick"];
  const counts = [...new Set((values["--counts"] || (quick ? "20,60" : "100,300,600"))
    .split(",").map(Number))].sort((a, b) => a - b);
  assert.ok(counts.length > 0 && counts.every(n => Number.isSafeInteger(n) && n >= 1 && n <= 10000),
    "--counts must contain positive integers no larger than 10000");
  const windowSize = integer("--window", 20, 2, 10000);
  return { output: path.resolve(values["--output"]), compare: values["--compare"] ? path.resolve(values["--compare"]) : null,
    counts, windowSize, turns: integer("--turns", quick ? 100 : 1200, windowSize),
    updates: integer("--updates", quick ? 4 : 24, 1, 1000), repeats: integer("--repeats", quick ? 1 : 3, 1, 20),
    headed: Boolean(values["--headed"]) };
}

function findPlaywright() {
  const choices = [process.env.CGF_PLAYWRIGHT_MODULE, "playwright", "playwright-core"];
  if (process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES) {
    for (const name of ["playwright", "playwright-core"]) choices.push(path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, name));
  }
  for (const candidate of choices.filter(Boolean)) {
    try {
      const loaded = require(candidate);
      if (loaded.chromium) return loaded;
    } catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }
  }
  return null;
}

function sourceAt(root, name) {
  const contents = { "manifest.json": fs.readFileSync(path.join(root, "manifest.json"), "utf8") };
  const manifest = JSON.parse(contents["manifest.json"]);
  const files = ["manifest.json", ...manifest.content_scripts.flatMap(entry => [...(entry.css || []), ...(entry.js || [])])];
  const sha256 = {};
  for (const file of files) {
    contents[file] ??= fs.readFileSync(path.join(root, file), "utf8");
    sha256[file] = crypto.createHash("sha256").update(contents[file]).digest("hex");
  }
  let revision = null;
  try { revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { /* A source ZIP is also a valid input; content digests remain available. */ }
  // Freeze each source snapshot for the entire run, even if its checkout is
  // edited afterwards. The per-file digests identify these exact inputs.
  return { name, manifest, contents, metadata: { version: manifest.version, revision, sha256 } };
}

function chromeMock(version) {
  const storageListeners = new Set();
  const messageListeners = new Set();
  const values = { "cgf.settings.v1": { enabled: true, keepRecent: 1, maxExpanded: 1 } };
  globalThis.chrome = {
    storage: { local: { get: async () => structuredClone(values) },
      onChanged: { addListener: f => storageListeners.add(f), removeListener: f => storageListeners.delete(f) } },
    runtime: { id: "abcdefghijklmnopabcdefghijklmnop", getManifest: () => ({ version }),
      onMessage: { addListener: f => messageListeners.add(f), removeListener: f => messageListeners.delete(f) } }
  };
}

function installFixture() {
  let created = 0;
  function makeTurn(id) {
    const turn = document.createElement("section");
    turn.className = "turn";
    turn.dataset.turnKey = `turn-${id}`;
    const question = document.createElement("div");
    question.className = "question";
    question.setAttribute("data-user-message-bubble", "true");
    question.textContent = `Synthetic question ${id}: explain this example and show a small implementation.`;
    const answer = document.createElement("div");
    answer.className = "answer";
    answer.setAttribute("data-chatgpt-search-unit-key", `unit-${id}:assistant`);
    answer.setAttribute("data-chatgpt-search-message-ids", `message-${id}`);
    const body = document.createElement("div");
    body.className = "answer-body";
    body.setAttribute("data-markdown-text-style", "assistant-message");
    for (let index = 0; index < 4; index += 1) {
      const paragraph = document.createElement("p");
      paragraph.textContent = `Answer ${id}, paragraph ${index}: ` +
        "This controlled transcript contains ordinary prose and highlighted source code. ".repeat(5);
      body.append(paragraph);
    }
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    for (let index = 0; index < 18; index += 1) {
      const line = document.createElement("span");
      line.className = "code-line";
      const parts = ["const ", `value_${id}_${index}`, ` = ${id * 19 + index}; `, `// synthetic line ${index}`];
      parts.forEach((text, part) => {
        const span = document.createElement("span");
        span.className = ["kw", "name", "num", "comment"][part];
        span.textContent = text;
        line.append(span);
      });
      code.append(line);
    }
    pre.append(code);
    body.append(pre);
    answer.append(body);
    turn.append(question, answer);
    return turn;
  }
  globalThis.memoryFixture = {
    append(count, windowSize = null) {
      const thread = document.getElementById("thread");
      const fragment = document.createDocumentFragment();
      for (let i = 0; i < count; i += 1) fragment.append(makeTurn(++created));
      thread.append(fragment);
      if (windowSize !== null) while (thread.children.length > windowSize) thread.firstElementChild.remove();
      return created;
    },
    created: () => created,
    mutate(kind, index) {
      const paragraph = document.querySelector(".turn:last-child .answer-body p");
      if (kind === "character-data") paragraph.firstChild.data = `Synthetic streamed text ${index}.`;
      else {
        const span = document.createElement("span");
        span.textContent = `Synthetic highlighted text ${index}.`;
        const code = document.createElement("code");
        code.textContent = `value_${index}`;
        paragraph.replaceChildren(span, code);
      }
    }
  };
}

function instrumentAdapter(names) {
  const original = globalThis.CGFAdapter;
  if (!original || globalThis.__chatGPTFoldControllerV1) throw new Error("Instrument after adapter.js and before content.js");
  const calls = Object.fromEntries(names.map(name => [name, 0]));
  const elapsedMs = { ...calls };
  const wrapped = { ...original };
  for (const name of names) {
    if (typeof original[name] !== "function") throw new Error(`Missing adapter method: ${name}`);
    wrapped[name] = (...args) => {
      calls[name] += 1;
      const started = performance.now();
      try { return original[name](...args); }
      finally { elapsedMs[name] += performance.now() - started; }
    };
  }
  globalThis.CGFAdapter = Object.freeze(wrapped);
  globalThis.benchmarkAdapter = {
    reset() { for (const name of names) { calls[name] = 0; elapsedMs[name] = 0; } },
    snapshot: () => ({ calls: { ...calls }, elapsedMs: { ...elapsedMs } })
  };
}

async function launch(chromium, executablePath, config, source, count, instrument = false) {
  const browser = await chromium.launch({ executablePath, headless: !config.headed,
    args: process.getuid?.() === 0 ? ["--no-sandbox"] : [] });
  try {
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    await context.route("**/*", route => route.request().url() === TEST_URL
      ? route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: HTML }) : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(chromeMock, source?.manifest.version || "synthetic-baseline");
    await page.goto(TEST_URL, { waitUntil: "domcontentloaded" });
    await page.evaluate(installFixture);
    await page.evaluate(n => memoryFixture.append(n), count);
    if (source) {
      for (const entry of source.manifest.content_scripts) {
        for (const css of entry.css || []) await page.addStyleTag({ content: source.contents[css] });
        for (const js of entry.js || []) {
          await page.addScriptTag({ content: source.contents[js] });
          if (instrument && js === "src/adapter.js") await page.evaluate(instrumentAdapter, ADAPTER_METHODS);
        }
      }
      await page.waitForFunction(n => document.querySelectorAll("[data-cgf-message]").length === n &&
        document.querySelectorAll('[data-cgf-collapsed="false"]').length === 1, count);
      if (instrument) assert.ok(await page.evaluate(() => Boolean(globalThis.benchmarkAdapter)), "Adapter instrumentation not installed");
    }
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    return { browser, page, cdp, errors, mode: source?.name || "baseline", version: browser.version() };
  } catch (error) { await browser.close(); throw error; }
}

async function settle(run) {
  await run.page.waitForTimeout(180);
  await run.page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
    return document.body.offsetHeight;
  });
  await run.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function performanceMetrics(run) {
  return Object.fromEntries((await run.cdp.send("Performance.getMetrics")).metrics.map(item => [item.name, item.value]));
}

async function memoryMetrics(run) {
  const perf = await performanceMetrics(run);
  const dom = await run.cdp.send("Memory.getDOMCounters");
  let heap = null;
  try { heap = await run.cdp.send("Runtime.getHeapUsage"); }
  catch (error) { if (!/wasn't found|not found|not supported|unsupported/i.test(error.message)) throw error; }
  const finite = value => Number.isFinite(value) ? value : null;
  return {
    performance: Object.fromEntries(["JSHeapUsedSize", "JSHeapTotalSize", "LayoutObjects", "Documents", "Nodes", "JSEventListeners"]
      .map(name => [name, finite(perf[name])])),
    dom,
    runtimeHeap: { available: heap !== null, usedSize: finite(heap?.usedSize), totalSize: finite(heap?.totalSize),
      embedderHeapUsedSize: finite(heap?.embedderHeapUsedSize), backingStorageSize: finite(heap?.backingStorageSize) }
  };
}

async function sample(run) {
  await settle(run);
  // Only scalar observations; never call status/rescan/flush, hold ElementHandles,
  // or log DOM objects in the page's console.
  const documentCounts = await run.page.evaluate(() => {
    const controller = globalThis.__chatGPTFoldControllerV1;
    let disconnectedRecords = controller ? 0 : null;
    if (controller) for (const element of controller.records.keys()) if (!element.isConnected) disconnectedRecords += 1;
    return { created: memoryFixture.created(), mountedAnswers: document.querySelectorAll(".answer").length,
      originalAnswerElements: document.querySelectorAll(".answer-body, .answer-body *").length,
      connectedElements: document.getElementsByTagName("*").length,
      controls: document.querySelectorAll("[data-cgf-control]").length,
      expanded: document.querySelectorAll('[data-cgf-collapsed="false"]').length,
      records: controller?.records.size ?? null, openIntents: controller?.openIntents.size ?? null,
      queuedScanRoots: controller?.scanRoots.size ?? null, queuedRecordUpdates: controller?.dirtyRecords?.size ?? null,
      workCounts: controller?.workCounts ? { ...controller.workCounts } : null, disconnectedRecords,
      observingCurrentBody: controller ? controller.observedBody === document.body : null };
  });
  const beforeGC = await memoryMetrics(run);
  await run.cdp.send("HeapProfiler.collectGarbage");
  await run.cdp.send("HeapProfiler.collectGarbage");
  await run.page.waitForTimeout(120);
  const afterGC = await memoryMetrics(run);
  assert.deepEqual(run.errors, [], "Unexpected synthetic page error");
  if (run.mode !== "baseline") {
    assert.equal(documentCounts.records, documentCounts.mountedAnswers, "Mounted answers must be registered");
    assert.equal(documentCounts.disconnectedRecords, 0, "Extension must not retain disconnected answer records");
    assert.equal(documentCounts.controls, documentCounts.mountedAnswers, "One control per mounted answer");
    assert.ok(documentCounts.openIntents <= 1, "Open intentions exceed the fixture's configured cap");
    assert.equal(documentCounts.queuedScanRoots, 0, "Discovery queue must settle");
    if (documentCounts.queuedRecordUpdates !== null) assert.equal(documentCounts.queuedRecordUpdates, 0, "Record-update queue must settle");
  }
  return { documentCounts, beforeGC, afterGC };
}

async function updatePhase(run, kind, updates) {
  await run.page.evaluate(() => globalThis.benchmarkAdapter?.reset());
  const before = await performanceMetrics(run);
  const started = performance.now();
  for (let index = 0; index < updates; index += 1) {
    await run.page.evaluate(({ kind, index }) => memoryFixture.mutate(kind, index), { kind, index });
    // Longer than the extension's 120 ms batch interval, so each mutation
    // produces an independent opportunity for its regular update path.
    await run.page.waitForTimeout(180);
  }
  const elapsedMs = performance.now() - started;
  const after = await performanceMetrics(run);
  const durationDeltaMs = Object.fromEntries(["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration"]
    .map(name => [name, Number.isFinite(before[name]) && Number.isFinite(after[name]) ? (after[name] - before[name]) * 1000 : null]));
  const adapter = await run.page.evaluate(() => globalThis.benchmarkAdapter?.snapshot() || null);
  assert.deepEqual(run.errors, [], "Unexpected synthetic page error");
  return { kind, updates, elapsedMs, requestedWaitMs: updates * 180, durationDeltaMs, adapter };
}

async function main() {
  if (process.argv.includes("--help")) { help(); return; }
  const config = options();
  assert.ok(!fs.existsSync(config.output), "Output already exists; choose another filename to preserve the earlier run.");
  const playwright = findPlaywright();
  if (!playwright) { console.error("NOT RUN: Playwright is unavailable; see --help."); process.exitCode = 2; return; }
  const executablePath = [process.env.CHROME_PATH, process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    playwright.chromium.executablePath(), "/usr/bin/chromium", "/usr/bin/chromium-browser"]
    .find(candidate => candidate && fs.existsSync(candidate));
  if (!executablePath) { console.error("NOT RUN: Chromium is unavailable; set CHROME_PATH."); process.exitCode = 2; return; }
  const sources = [sourceAt(ROOT, "fold")];
  if (config.compare) sources.push(sourceAt(config.compare, "compare"));
  const modes = [null, ...sources];
  const report = {
    schemaVersion: 1, complete: false, startedAt: new Date().toISOString(), finishedAt: null,
    environment: { node: process.version, platform: process.platform, architecture: process.arch, chromium: null, headless: !config.headed },
    configuration: { counts: config.counts, windowSize: config.windowSize, turns: config.turns,
      updates: config.updates, repeats: config.repeats, viewport: { width: 1100, height: 900 } },
    sources: Object.fromEntries(sources.map(source => [source.name, source.metadata])),
    methodology: { chromeAPIs: "mocked", network: "intercepted; synthetic fixture only", siteDataCache: "none",
      gc: "beforeGC followed by two HeapProfiler.collectGarbage calls and 120 ms; then afterGC",
      memoryScope: "CDP heap/DOM/layout metrics only; no RSS, GPU or total-tab-memory measurement",
      instrumentation: "fixed scalar adapter counters only in update scenarios; no per-call history",
      thresholds: "structural invariants only; no absolute byte/timing pass threshold" },
    results: [], error: null
  };
  fs.mkdirSync(path.dirname(config.output), { recursive: true });
  fs.writeFileSync(config.output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  const save = result => {
    if (result) {
      report.results.push(result);
      console.log(`${result.scenario} ${result.mode} repeat=${result.repetition} count=${result.count}`);
    }
    fs.writeFileSync(config.output, JSON.stringify(report, null, 2) + "\n");
  };
  async function withRun(source, count, instrument, action) {
    const run = await launch(playwright.chromium, executablePath, config, source, count, instrument);
    report.environment.chromium = run.version;
    try { await action(run); }
    finally { await run.browser.close(); }
  }
  try {
    for (let repetition = 1; repetition <= config.repeats; repetition += 1) {
      const offset = (repetition - 1) % modes.length;
      const orderedModes = [...modes.slice(offset), ...modes.slice(0, offset)];
      for (const count of config.counts) for (const source of orderedModes) {
        await withRun(source, count, false, async run => save({ scenario: "all-mounted", mode: run.mode,
          repetition, count, ...await sample(run) }));
      }
      for (const source of orderedModes) {
        await withRun(source, config.windowSize, false, async run => {
          let created = config.windowSize;
          const checkpoints = [...new Set([config.windowSize, ...config.counts.filter(n => n > config.windowSize && n < config.turns), config.turns])];
          for (const target of checkpoints) {
            while (created < target) {
              created = await run.page.evaluate(({ batch, windowSize }) => memoryFixture.append(batch, windowSize),
                { batch: Math.min(10, config.windowSize - 1, target - created), windowSize: config.windowSize });
              await run.page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
            }
            const point = await sample(run);
            assert.equal(point.documentCounts.mountedAnswers, config.windowSize);
            if (source) assert.equal(point.documentCounts.expanded, 1);
            save({ scenario: "fixed-window-no-data-cache", mode: run.mode, repetition, count: target, ...point });
          }
        });
        const count = config.counts[config.counts.length - 1];
        await withRun(source, count, true, async run => {
          await run.page.evaluate(() => document.querySelector(".turn:last-child .answer").setAttribute("data-is-streaming", "true"));
          const beforeUpdates = await sample(run);
          const phases = [];
          for (const kind of ["character-data", "neutral-markup"]) phases.push(await updatePhase(run, kind, config.updates));
          await run.page.evaluate(() => document.querySelector(".turn:last-child .answer").removeAttribute("data-is-streaming"));
          save({ scenario: "paced-updates", mode: run.mode, repetition, count, phases,
            beforeUpdates, afterUpdates: await sample(run) });
        });
      }
    }
    report.complete = true;
    report.finishedAt = new Date().toISOString();
    save();
    console.log(`Complete: ${report.results.length} samples written to ${config.output}`);
  } catch (error) {
    report.error = error.message;
    report.finishedAt = new Date().toISOString();
    save();
    throw error;
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
