#!/usr/bin/env node
"use strict";

/*
 * Lifecycle and incremental-maintenance regressions against synthetic markup.
 * Uses actual Chromium DOM/CSS/MutationObserver and mocked Chrome APIs.
 * Assertions never request status/rescan or call controller.flush(): those
 * operations could hide a stale observer or turn a missed update into a pass.
 * Plain state snapshots check extension-owned references, not heap collection.
 * Counting adapter calls checks work avoided, not wall time or total tab RAM.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const TEST_URL = "https://chatgpt.com/c/fold-maintenance-test";
const SETTINGS_KEY = "cgf.settings.v1";
const DEFAULTS = { enabled: true, keepRecent: 1, maxExpanded: 3 };
const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <title>ChatGPT Fold synthetic maintenance fixture</title>
  <style>
    body { margin: 20px; font: 16px/1.5 system-ui; }
    main { max-width: 700px; }
    [data-turn-key] { margin: 12px 0; }
    [data-user-message-bubble] { margin: 6px 0; }
    [data-markdown-text-style] { display: block; }
  </style></head><body></body></html>`;

if (process.argv.includes("--help")) {
  console.log(`ChatGPT Fold lifecycle and incremental-maintenance regressions

  node tests/browser-maintenance.cjs
  node tests/browser-maintenance.cjs --headed

Uses injected content scripts with explicit Chrome API mocks, never a live chat.
Optional: CGF_PLAYWRIGHT_MODULE, CODEX_PRIMARY_RUNTIME_NODE_MODULES, CHROME_PATH.
Missing Playwright/Chromium exits 2 (NOT RUN), never a pass.
Does not measure OS memory, force garbage collection, or test real MV3 injection.`);
  process.exit(0);
}

function findPlaywright() {
  const choices = [process.env.CGF_PLAYWRIGHT_MODULE, "playwright", "playwright-core"];
  if (process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES) {
    for (const name of ["playwright", "playwright-core"]) {
      choices.push(path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, name));
    }
  }
  for (const candidate of choices.filter(Boolean)) {
    try {
      const loaded = require(candidate);
      if (loaded.chromium) return loaded;
    } catch (error) {
      if (error.code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  return null;
}

function chromeMock({ key, settings, version }) {
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  const storageListeners = new Set();
  const messageListeners = new Set();
  let values = { [key]: settings };
  const local = {
    get: async () => structuredClone(values),
    async set(items) {
      const changes = {};
      for (const [name, value] of Object.entries(items)) {
        changes[name] = { oldValue: values[name], newValue: structuredClone(value) };
      }
      values = { ...values, ...structuredClone(items) };
      queueMicrotask(() => {
        for (const listener of storageListeners) listener(changes, "local");
      });
    }
  };
  globalThis.chrome = {
    storage: {
      local,
      onChanged: {
        addListener: listener => storageListeners.add(listener),
        removeListener: listener => storageListeners.delete(listener)
      }
    },
    runtime: {
      id: extensionId,
      getManifest: () => ({ version }),
      onMessage: {
        addListener: listener => messageListeners.add(listener),
        removeListener: listener => messageListeners.delete(listener)
      }
    }
  };
  globalThis.maintenanceMock = {
    setSettings: value => local.set({ [key]: value }),
    listenerCounts: () => ({ storage: storageListeners.size, messages: messageListeners.size })
  };
}

function fixtureRuntime({ count, kind }) {
  function makeTurn(key, identityKind = "message") {
    const turn = document.createElement("div");
    turn.id = `turn-${key}`;
    turn.setAttribute("data-turn-key", key);
    const question = document.createElement("div");
    question.setAttribute("data-user-message-bubble", "true");
    question.textContent = `Synthetic question ${key}`;
    const answer = document.createElement("div");
    answer.id = `answer-${key}`;
    if (identityKind === "fallback") {
      answer.setAttribute("data-turn", "assistant");
      answer.setAttribute("data-turn-id", `legacy-${key}`);
    } else {
      answer.setAttribute("data-chatgpt-search-unit-key", `${key}:assistant`);
      answer.setAttribute("data-chatgpt-search-message-ids", `message-${key}`);
      answer.setAttribute("data-chatgpt-selection-message-id", `message-${key}`);
    }
    const body = document.createElement("div");
    body.setAttribute("data-markdown-text-style", "assistant-message");
    const paragraph = document.createElement("p");
    paragraph.textContent = `Synthetic answer ${key}. Updates must not scan unrelated history.`;
    body.append(paragraph);
    answer.append(body);
    turn.append(question, answer);
    return turn;
  }

  function makeBody(keys = ["old", "middle", "latest"]) {
    const body = document.createElement("body");
    const thread = document.createElement("main");
    thread.id = "thread";
    for (const key of keys) thread.append(makeTurn(key));
    const form = document.createElement("form");
    form.id = "composer";
    form.setAttribute("data-chatgpt-composer", "");
    const input = document.createElement("textarea");
    input.setAttribute("aria-label", "Synthetic input");
    form.append(input);
    body.append(thread, form);
    return body;
  }

  function answerState(key) {
    const answer = document.getElementById(`answer-${key}`);
    const body = answer?.querySelector('[data-markdown-text-style="assistant-message"]');
    const control = answer?.querySelector("[data-cgf-control]");
    return {
      connected: Boolean(answer?.isConnected),
      registered: Boolean(answer?.hasAttribute("data-cgf-message")),
      collapsed: answer?.getAttribute("data-cgf-collapsed") || null,
      bodyDisplay: body ? getComputedStyle(body).display : null,
      bodyHasLayout: Boolean(body?.getClientRects().length),
      controlCount: answer?.querySelectorAll("[data-cgf-control]").length || 0,
      controlHasLayout: Boolean(control?.getClientRects().length),
      disabled: control?.disabled ?? null,
      badge: control?.querySelector(".cgf-badge")?.textContent || null,
      label: control?.querySelector(".cgf-label")?.textContent || null
    };
  }

  function retainedState() {
    const controller = globalThis.__chatGPTFoldControllerV1;
    if (!controller) return { exists: false };
    return {
      exists: true,
      active: controller.active,
      bodyPresent: Boolean(document.body),
      observedBodyPresent: Boolean(controller.observedBody),
      observingCurrentBody: Boolean(document.body && controller.observedBody === document.body),
      observedBodyConnected: Boolean(controller.observedBody?.isConnected),
      recordCount: controller.records.size,
      disconnectedRecords: [...controller.records.keys()].filter(element => !element.isConnected).length,
      recordsOutsideCurrentBody: [...controller.records.keys()].filter(element => !document.body?.contains(element)).length,
      orderCount: controller.order.length,
      disconnectedOrder: controller.order.filter(record => !record.element.isConnected).length,
      queuedRoots: controller.scanRoots.size,
      disconnectedQueuedRoots: [...controller.scanRoots].filter(element => !element.isConnected).length,
      dirtyRecordCount: controller.dirtyRecords?.size || 0,
      disconnectedDirtyRecords: [...(controller.dirtyRecords || [])].filter(record => !record.element.isConnected).length,
      openIntentCount: controller.openIntents.size,
      ownControlCount: document.querySelectorAll("[data-cgf-control]").length,
      activeAttribute: document.documentElement.getAttribute("data-cgf-active")
    };
  }

  async function frames(keys = ["old"], duration = 260) {
    const started = performance.now();
    const samples = [];
    await new Promise(resolve => {
      function sample() {
        samples.push({ state: retainedState(), answers: Object.fromEntries(keys.map(key => [key, answerState(key)])) });
        if (performance.now() - started >= duration) resolve();
        else requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    });
    return samples;
  }

  const keys = count === 3 ? ["old", "middle", "latest"] :
    ["old", ...Array.from({ length: count - 2 }, (_, index) => `history-${index}`), "latest"];
  document.documentElement.replaceChild(makeBody([]), document.body);
  for (const key of keys) document.getElementById("thread").append(makeTurn(key, kind));
  globalThis.maintenanceFixture = { makeTurn, makeBody, answerState, retainedState, frames };
}

function installCountingAdapter() {
  // CGFAdapter is frozen and the controller captures its reference. Install the
  // facade before content.js, and enable counting only after initial setup.
  const adapter = globalThis.CGFAdapter;
  const methods = ["identity", "identityHint", "isAssistant", "collect", "hasVisibleStop",
    "streamingElements", "preview", "hasDirectText"];
  let enabled = false;
  let targetId = "";
  let counts;
  function reset(id) {
    targetId = id;
    counts = Object.fromEntries(methods.map(name => [name, 0]));
    counts.untouchedAnswerCalls = 0;
    enabled = true;
  }
  const facade = { ...adapter };
  for (const name of methods) {
    facade[name] = function (...args) {
      if (enabled) {
        counts[name] += 1;
        const element = args[0];
        if (element?.nodeType === 1 && element.hasAttribute("data-cgf-message") && element.id !== targetId) {
          counts.untouchedAnswerCalls += 1;
        }
      }
      return adapter[name](...args);
    };
  }
  globalThis.CGFAdapter = Object.freeze(facade);
  globalThis.maintenanceWork = {
    reset,
    read: () => ({ ...counts }),
    stop: () => { enabled = false; }
  };
}

function assertFolded(samples, key, message) {
  assert.ok(samples.length, "No rendering opportunity was sampled");
  const exposed = samples.find(sample => {
    const answer = sample.answers[key];
    return !answer.registered || answer.collapsed !== "true" || answer.bodyDisplay !== "none" ||
      answer.bodyHasLayout || answer.controlCount !== 1 || !answer.controlHasLayout;
  });
  assert.equal(exposed, undefined, `${message}; first unexpected frame: ${JSON.stringify(exposed)}`);
}

function assertOpen(samples, key, message, registered = true) {
  assert.ok(samples.length, "No rendering opportunity was sampled");
  const hidden = samples.find(sample => {
    const answer = sample.answers[key];
    return !answer.connected || answer.bodyDisplay === "none" || !answer.bodyHasLayout ||
      (registered && (answer.collapsed !== "false" || answer.controlCount !== 1 || !answer.controlHasLayout)) ||
      (!registered && (answer.registered || answer.controlCount));
  });
  assert.equal(hidden, undefined, `${message}; first unexpected frame: ${JSON.stringify(hidden)}`);
}

function assertClean(samples, count, message) {
  const stale = samples.find(({ state }) => !state.exists || !state.active || !state.observingCurrentBody ||
    !state.observedBodyConnected || state.recordCount !== count || state.orderCount !== count ||
    state.ownControlCount !== count || state.disconnectedRecords || state.disconnectedOrder ||
    state.recordsOutsideCurrentBody || state.disconnectedQueuedRoots || state.disconnectedDirtyRecords ||
    state.openIntentCount > DEFAULTS.maxExpanded);
  assert.equal(stale, undefined, `${message}; first stale state: ${JSON.stringify(stale)}`);
}

function assertLocalWork(counts) {
  assert.equal(counts.untouchedAnswerCalls, 0, "A neutral update visited another registered answer");
  assert.equal(counts.hasVisibleStop, 0, "A neutral update rescanned global Stop controls");
  assert.equal(counts.streamingElements, 0, "A neutral update rescanned global streaming markers");
  for (const name of ["identity", "identityHint", "isAssistant", "collect"]) {
    assert.ok(counts[name] <= 2, `A neutral update performed repeated ${name} work: ${counts[name]}`);
  }
}

async function main() {
  const playwright = findPlaywright();
  if (!playwright) {
    console.error("NOT RUN: Playwright is not installed; see --help.");
    process.exitCode = 2;
    return;
  }
  const executablePath = [process.env.CHROME_PATH, process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    playwright.chromium.executablePath(), "/usr/bin/chromium", "/usr/bin/chromium-browser"]
    .find(candidate => candidate && fs.existsSync(candidate));
  if (!executablePath) {
    console.error("NOT RUN: No local Chromium executable; set CHROME_PATH or install Playwright Chromium.");
    process.exitCode = 2;
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const browser = await playwright.chromium.launch({ executablePath,
    headless: !process.argv.includes("--headed"),
    args: process.getuid?.() === 0 ? ["--no-sandbox"] : [] });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await context.route("**/*", route => route.request().url() === TEST_URL
    ? route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: HTML })
    : route.abort());
  let passed = 0;
  let failed = 0;

  async function test(name, action, options = {}) {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      const count = options.count || 3;
      await page.addInitScript(chromeMock, { key: SETTINGS_KEY, settings: options.settings || DEFAULTS, version: manifest.version });
      await page.goto(TEST_URL, { waitUntil: "domcontentloaded" });
      await page.evaluate(fixtureRuntime, { count, kind: options.kind || "message" });
      for (const entry of manifest.content_scripts) {
        for (const css of entry.css || []) await page.addStyleTag({ path: path.join(ROOT, css) });
        for (const js of entry.js || []) {
          if (js === "src/content.js") await page.evaluate(installCountingAdapter);
          await page.addScriptTag({ path: path.join(ROOT, js) });
        }
      }
      await page.waitForFunction(expected => document.documentElement.dataset.cgfActive === "true" &&
        document.querySelectorAll("[data-cgf-message]").length === expected &&
        document.getElementById("answer-old").dataset.cgfCollapsed === "true", count);
      // Finish page-load/own-control batches before measuring later mutations.
      // Frame sampling reads plain state only; it does not reconcile anything.
      await page.evaluate(() => maintenanceFixture.frames([]));
      await action(page);
      assert.deepEqual(errors, [], "Unexpected browser error");
      passed += 1;
      console.log(`PASS ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${name}\n  ${error.message.split("\n")[0]}`);
    } finally {
      await page.close();
    }
  }

  console.log("MODE: INJECTED content scripts + mocked Chrome APIs; lifecycle/maintenance assertions");
  try {
    await test("body replacement releases the old tree and folds its replacement before paint without interaction", async page => {
      const samples = await page.evaluate(async () => {
        document.documentElement.replaceChild(maintenanceFixture.makeBody(), document.body);
        return maintenanceFixture.frames(["old", "latest"]);
      });
      assertClean(samples, 3, "The replaced body remained retained by the controller");
      assertFolded(samples, "old", "The replacement body exposed an old answer");
      assertOpen(samples, "latest", "The latest open intention was lost during replacement");
    });

    await test("same-route body replacement preserves bounded manual open choices", async page => {
      await page.locator("#answer-old > [data-cgf-control]").click();
      await page.evaluate(() => maintenanceFixture.frames([]));
      const samples = await page.evaluate(async () => {
        document.documentElement.replaceChild(maintenanceFixture.makeBody(), document.body);
        return maintenanceFixture.frames(["old", "middle", "latest"]);
      });
      assertClean(samples, 3, "Body recovery kept disconnected records");
      assertOpen(samples, "old", "Body recovery discarded a manually opened stable message");
      assertOpen(samples, "latest", "Body recovery displaced another open answer under the cap");
      assertFolded(samples, "middle", "Body recovery opened an unchosen answer");
      assert.equal(samples.at(-1).state.openIntentCount, 2);
    });

    await test("body removal clears retained nodes and a later body insertion resumes automatically", async page => {
      const absent = await page.evaluate(async () => {
        document.body.remove();
        return maintenanceFixture.frames([]);
      });
      for (const { state } of absent) {
        assert.equal(state.bodyPresent, false);
        assert.equal(state.observedBodyPresent, false, "The absent body's observer still held its root");
        assert.equal(state.recordCount, 0, "Records survived a body removal");
        assert.equal(state.orderCount, 0);
        assert.equal(state.queuedRoots, 0);
        assert.equal(state.dirtyRecordCount, 0);
      }
      const restored = await page.evaluate(async () => {
        document.documentElement.append(maintenanceFixture.makeBody());
        return maintenanceFixture.frames(["old", "latest"]);
      });
      assertClean(restored, 3, "A body arriving in a later task was not observed");
      assertFolded(restored, "old", "A delayed body insertion exposed history");
      assertOpen(restored, "latest", "The gap between bodies lost the latest intention");
    });

    for (const mode of ["paused", "disabled", "pagehide", "destroyed"]) {
      await test(`${mode} controller does not restart when the body changes`, async page => {
        await page.evaluate(async mode => {
          const controller = globalThis.__chatGPTFoldControllerV1;
          if (mode === "paused") controller.command("restore");
          else if (mode === "disabled") await maintenanceMock.setSettings({ enabled: false, keepRecent: 1, maxExpanded: 3 });
          else if (mode === "pagehide") window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
          else controller.destroy();
          await maintenanceFixture.frames([]);
        }, mode);
        const samples = await page.evaluate(async () => {
          document.documentElement.replaceChild(maintenanceFixture.makeBody(), document.body);
          return maintenanceFixture.frames(["old", "latest"]);
        });
        assertOpen(samples, "old", `${mode} unexpectedly folded a newly mounted answer`, false);
        assertOpen(samples, "latest", `${mode} unexpectedly installed controls`, false);
        for (const { state } of samples) {
          if (mode === "destroyed") assert.equal(state.exists, false);
          else {
            assert.equal(state.active, false);
            assert.equal(state.recordCount, 0);
            assert.equal(state.orderCount, 0);
            assert.equal(state.observedBodyPresent, false);
            assert.equal(state.queuedRoots, 0);
            assert.equal(state.dirtyRecordCount, 0);
          }
        }
        if (mode === "destroyed") {
          assert.deepEqual(await page.evaluate(() => maintenanceMock.listenerCounts()), { storage: 0, messages: 0 });
          return;
        }
        const resumed = await page.evaluate(async mode => {
          if (mode === "paused") globalThis.__chatGPTFoldControllerV1.command("resume");
          else if (mode === "disabled") await maintenanceMock.setSettings({ enabled: true, keepRecent: 1, maxExpanded: 3 });
          else window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
          return maintenanceFixture.frames(["old"]);
        }, mode);
        assertClean(resumed, 3, `${mode} did not resume with the current body`);
        assertFolded(resumed, "old", `${mode} resume did not restore folding`);
      });
    }

    await test("repeated history windows release disconnected records and queued roots", async page => {
      const samples = await page.evaluate(async () => {
        const results = [];
        for (let offset = 0; offset < 300; offset += 20) {
          const fragment = document.createDocumentFragment();
          for (let index = offset; index < offset + 20; index += 1) fragment.append(maintenanceFixture.makeTurn(`window-${index}`));
          document.getElementById("thread").replaceChildren(fragment);
          await new Promise(requestAnimationFrame);
          results.push({ state: maintenanceFixture.retainedState(), answers: {} });
        }
        results.push(...await maintenanceFixture.frames([]));
        return results;
      });
      assertClean(samples, 20, "Windowed history left detached extension-owned references");
      assert.equal(samples.at(-1).state.queuedRoots, 0, "A settled window retained pending scan roots");
    });

    await test("ordinary text updates refresh one folded preview without walking historical records", async page => {
      const result = await page.evaluate(async () => {
        maintenanceWork.reset("answer-old");
        document.querySelector("#answer-old p").firstChild.data = "Changed text only. No historical identity or streaming scan is required.";
        const samples = await maintenanceFixture.frames(["old"]);
        return { samples, calls: maintenanceWork.read() };
      });
      assertFolded(result.samples, "old", "A neutral text update exposed folded content");
      assert.match(result.samples.at(-1).answers.old.label, /Changed text only/);
      assert.ok(result.calls.preview > 0, "The changed preview was never refreshed");
      assertLocalWork(result.calls);
    }, { count: 120 });

    await test("neutral paragraph and code markup updates do not rescan all mounted answers", async page => {
      const result = await page.evaluate(async () => {
        maintenanceWork.reset("answer-old");
        const body = document.querySelector('#answer-old [data-markdown-text-style="assistant-message"]');
        const paragraph = document.createElement("p");
        paragraph.textContent = "Replacement paragraph with neutral markup.";
        const code = document.createElement("pre");
        const token = document.createElement("span");
        token.className = "synthetic-code-token";
        token.textContent = "const result = 42;";
        code.append(token);
        body.replaceChildren(paragraph, code);
        const samples = await maintenanceFixture.frames(["old"]);
        return { samples, calls: maintenanceWork.read() };
      });
      assertFolded(result.samples, "old", "Replacing neutral markup exposed an old answer");
      assert.match(result.samples.at(-1).answers.old.label, /Replacement paragraph/);
      assert.ok(result.calls.preview > 0, "The replacement preview was not refreshed");
      assertLocalWork(result.calls);
    }, { count: 120 });

    await test("overflowing the bounded dirty queue refreshes every changed answer without retaining the overflow", async page => {
      const result = await page.evaluate(async () => {
        const controller = globalThis.__chatGPTFoldControllerV1;
        const before = controller.diagnostics().maintenance;
        const keys = ["old", ...Array.from({ length: 99 }, (_, index) => `history-${index}`)];
        for (const [index, key] of keys.entries()) {
          document.querySelector(`#answer-${key} p`).firstChild.data = `Stress update ${index}. A distinct answer in one mutation batch.`;
        }
        // All 100 notifications are delivered together. The read-only snapshot
        // must see a bounded queue and fallback work still pending, not flush it.
        await Promise.resolve();
        const pending = controller.diagnostics().maintenance;
        const samples = await maintenanceFixture.frames(["old", "latest"]);
        return {
          before,
          pending,
          samples,
          changed: keys.map(key => maintenanceFixture.answerState(key)),
          collapsed: document.querySelectorAll('[data-cgf-message][data-cgf-collapsed="true"]').length,
          expanded: document.querySelectorAll('[data-cgf-message][data-cgf-collapsed="false"]').length,
          settled: controller.diagnostics().maintenance
        };
      });
      assert.ok(result.pending.pendingDirtyRecordCount <= 80, "The batch retained more than 80 queued records");
      assert.equal(result.pending.policyPending, true, "Queue overflow did not schedule the conservative policy fallback");
      assert.equal(result.pending.timerPending, true);
      assert.equal(result.pending.fullFlushCount, result.before.fullFlushCount, "Reading pending work flushed it prematurely");
      assertClean(result.samples, 120, "The overflow batch retained stale records or controls");
      assertFolded(result.samples, "old", "Overflow processing reopened a folded answer");
      assertOpen(result.samples, "latest", "Overflow processing changed the latest open choice");
      assert.equal(result.changed.length, 100);
      for (const [index, answer] of result.changed.entries()) {
        assert.ok(answer.label.includes(`Stress update ${index}.`), `The dirty-queue fallback dropped answer ${index}'s preview update`);
        assert.equal(answer.collapsed, "true", `The fallback unexpectedly opened answer ${index}`);
      }
      assert.equal(result.collapsed, 119);
      assert.equal(result.expanded, 1);
      assert.equal(result.settled.pendingDirtyRecordCount, 0);
      assert.equal(result.settled.pendingScanRootCount, 0);
      assert.equal(result.settled.disconnectedRegisteredCount, 0);
      assert.equal(result.settled.policyPending, false);
      assert.equal(result.settled.timerPending, false);
      assert.equal(result.settled.previewRefreshCount, result.before.previewRefreshCount + 100);
      assert.ok(result.settled.fullFlushCount > result.before.fullFlushCount);
      assert.ok(result.settled.openIntentCount <= DEFAULTS.maxExpanded);
    }, { count: 120 });

    await test("streaming text takes the local path and marker removal refreshes the final preview", async page => {
      const started = await page.evaluate(async () => {
        const marker = document.createElement("span");
        marker.id = "streaming-marker";
        marker.className = "result-streaming";
        marker.textContent = "Synthetic streaming marker";
        document.querySelector("#answer-old p").append(marker);
        return maintenanceFixture.frames(["old"]);
      });
      assertOpen(started, "old", "An added explicit streaming marker did not protect its answer");
      assert.equal(started.at(-1).answers.old.badge, "生成中");
      const update = await page.evaluate(async () => {
        maintenanceWork.reset("answer-old");
        document.querySelector("#answer-old p").firstChild.data = "Final generated text after incremental updates. ";
        const samples = await maintenanceFixture.frames(["old"]);
        return { samples, calls: maintenanceWork.read() };
      });
      assertOpen(update.samples, "old", "A neutral streaming update lost protection");
      assertLocalWork(update.calls);
      assert.ok(update.samples.every(sample => sample.answers.old.disabled && sample.answers.old.badge === "生成中"));
      const finished = await page.evaluate(async () => {
        maintenanceWork.stop();
        document.getElementById("streaming-marker").remove();
        return maintenanceFixture.frames(["old"]);
      });
      assertFolded(finished, "old", "Removing the streaming marker left a generation-only answer open");
      assert.match(finished.at(-1).answers.old.label, /Final generated text/);
      assert.equal(finished.at(-1).answers.old.disabled, false);
    }, { count: 120 });

    await test("nested message ID insertion and removal re-evaluate identity instead of taking the markup shortcut", async page => {
      await page.locator("#answer-old > [data-cgf-control]").click();
      await page.evaluate(() => maintenanceFixture.frames([]));
      const conflict = await page.evaluate(async () => {
        const carrier = document.createElement("span");
        carrier.id = "nested-conflict";
        carrier.setAttribute("data-message-id", "another-message");
        carrier.textContent = "Nested identity conflict";
        document.querySelector("#answer-old p").append(carrier);
        return maintenanceFixture.frames(["old"]);
      });
      assertFolded(conflict, "old", "A conflicting nested message ID inherited a stable open intention");
      const restored = await page.evaluate(async () => {
        document.getElementById("nested-conflict").remove();
        return maintenanceFixture.frames(["old"]);
      });
      assertOpen(restored, "old", "Removing the identity conflict failed to restore the original stable message choice");
    });

    await test("a nested non-assistant role boundary suppresses a legacy fallback and removal restores discovery", async page => {
      const blocked = await page.evaluate(async () => {
        const marker = document.createElement("span");
        marker.id = "non-assistant-boundary";
        marker.setAttribute("data-message-role", "tool");
        marker.textContent = "Synthetic tool result inside an ambiguous legacy wrapper";
        document.querySelector("#answer-old p").append(marker);
        return maintenanceFixture.frames(["old"]);
      });
      assertOpen(blocked, "old", "The fallback shortcut hid a non-assistant role boundary", false);
      const restored = await page.evaluate(async () => {
        document.getElementById("non-assistant-boundary").remove();
        return maintenanceFixture.frames(["old"]);
      });
      assertFolded(restored, "old", "Removing a role conflict did not rediscover the legacy answer");
    }, { kind: "fallback" });

    await test("a bare root text node changing from whitespace to content stays fail-open", async page => {
      await page.evaluate(async () => {
        document.getElementById("answer-old").append(document.createTextNode(" "));
        await maintenanceFixture.frames([]);
      });
      const changed = await page.evaluate(async () => {
        document.getElementById("answer-old").lastChild.data = "Bare text cannot be folded without moving original nodes.";
        return maintenanceFixture.frames(["old"]);
      });
      assertOpen(changed, "old", "A direct-root text change took the safe nested-text shortcut");
      assert.ok(changed.every(sample => sample.answers.old.disabled && sample.answers.old.badge === "保持原样"));
      const restored = await page.evaluate(async () => {
        document.getElementById("answer-old").lastChild.data = " ";
        return maintenanceFixture.frames(["old"]);
      });
      assertFolded(restored, "old", "Removing direct-root text did not release unsupported protection");
    });

    for (const action of ["click", "settings"]) {
      await test(`a ${action} policy update cannot discard a pending control repair`, async page => {
        const samples = await page.evaluate(async action => {
          document.querySelector("#answer-old > [data-cgf-control]").remove();
          // Deliver the removal's observer notification, leaving its debounced
          // repair pending. Apply another policy in the same task before the
          // timer can run; no status request or rescan may rescue the toolbar.
          await Promise.resolve();
          if (action === "click") document.querySelector("#answer-middle > [data-cgf-control]").click();
          else await maintenanceMock.setSettings({ enabled: true, keepRecent: 1, maxExpanded: 2 });
          return maintenanceFixture.frames(["old"]);
        }, action);
        assert.equal(samples.at(-1).answers.old.controlCount, 1,
          `The ${action} policy cleared scheduled repair and left a folded answer without its control`);
        assertFolded(samples, "old", `The ${action} policy did not repair the missing control before paint`);
        assertClean(samples, 3, `The ${action} policy left controls inconsistent with registered records`);
        assert.equal(samples.at(-1).answers.old.disabled, false);
      });
    }

    await test("maintenance diagnostics expose fixed counts and report pending work without flushing it", async page => {
      const result = await page.evaluate(async () => {
        const controller = globalThis.__chatGPTFoldControllerV1;
        const before = controller.diagnostics();
        document.querySelector("#answer-old p").firstChild.data = "PRIVATE_SYNTHETIC_DIAGNOSTIC_TEXT_92: never export a preview or body.";
        // Let MutationObserver queue maintenance, but not the debounce timer.
        await Promise.resolve();
        const pending = controller.diagnostics();
        const samePending = controller.diagnostics();
        await maintenanceFixture.frames([]);
        return { before, pending, samePending, settled: controller.diagnostics() };
      });
      const countKeys = ["disconnectedRegisteredCount", "openIntentCount", "pendingScanRootCount",
        "pendingDirtyRecordCount", "fullFlushCount", "incrementalFlushCount", "previewRefreshCount",
        "bodyReplacementCount", "releasedRecordCount"];
      const flagKeys = ["bodyObserverConnected", "pageSuspended", "fullScanPending", "policyPending", "timerPending"];
      for (const report of Object.values(result)) {
        assert.equal(report.schemaVersion, 3);
        assert.deepEqual(Object.keys(report.maintenance).sort(), [...countKeys, ...flagKeys].sort());
        for (const key of countKeys) assert.ok(Number.isSafeInteger(report.maintenance[key]) && report.maintenance[key] >= 0, `Invalid count: ${key}`);
        for (const key of flagKeys) assert.equal(typeof report.maintenance[key], "boolean", `Invalid flag: ${key}`);
        assert.equal(report.maintenance.disconnectedRegisteredCount, 0);
        assert.equal(report.maintenance.bodyObserverConnected, true);
        assert.equal(report.maintenance.pageSuspended, false);
        assert.ok(report.maintenance.openIntentCount <= DEFAULTS.maxExpanded);
      }
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SYNTHETIC_DIAGNOSTIC_TEXT_92|message-old|fold-maintenance-test/,
        "Diagnostics leaked synthetic content, a message identity, or the URL");
      assert.equal(result.pending.maintenance.pendingDirtyRecordCount, 1);
      assert.equal(result.pending.maintenance.timerPending, true);
      assert.deepEqual(result.pending, result.samePending, "Reading diagnostics changed pending state");
      assert.equal(result.pending.maintenance.fullFlushCount, result.before.maintenance.fullFlushCount);
      assert.equal(result.settled.maintenance.pendingDirtyRecordCount, 0);
      assert.equal(result.settled.maintenance.pendingScanRootCount, 0);
      assert.equal(result.settled.maintenance.timerPending, false);
      assert.equal(result.settled.maintenance.incrementalFlushCount, result.before.maintenance.incrementalFlushCount + 1);
      assert.equal(result.settled.maintenance.previewRefreshCount, result.before.maintenance.previewRefreshCount + 1);
      assert.equal(result.settled.maintenance.fullFlushCount, result.before.maintenance.fullFlushCount);
    });

    await test("a body replacement discards queued preview work and diagnostics count released records", async page => {
      const result = await page.evaluate(async () => {
        const controller = globalThis.__chatGPTFoldControllerV1;
        const before = controller.diagnostics().maintenance;
        document.querySelector("#answer-old p").firstChild.data = "A preview update pending on the body that is about to leave.";
        await Promise.resolve();
        document.documentElement.replaceChild(maintenanceFixture.makeBody(), document.body);
        const samples = await maintenanceFixture.frames(["old"]);
        return { before, samples, after: controller.diagnostics().maintenance };
      });
      assertClean(result.samples, 3, "Body replacement retained an old dirty record");
      assertFolded(result.samples, "old", "Pending preview work delayed replacement folding");
      assert.equal(result.after.pendingDirtyRecordCount, 0);
      assert.equal(result.after.pendingScanRootCount, 0);
      assert.equal(result.after.disconnectedRegisteredCount, 0);
      assert.equal(result.after.bodyReplacementCount, result.before.bodyReplacementCount + 1);
      assert.equal(result.after.releasedRecordCount, result.before.releasedRecordCount + 3);
      assert.equal(result.after.bodyObserverConnected, true);
    });

    console.log(`${passed}/${passed + failed} lifecycle/maintenance groups passed.`);
    if (failed) process.exitCode = 1;
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
