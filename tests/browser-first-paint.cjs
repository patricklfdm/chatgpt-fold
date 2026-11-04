#!/usr/bin/env node
"use strict";

/*
 * First-frame regressions for historical answers mounted by a windowed page.
 * Actual Chromium DOM/CSS/MutationObserver; explicitly mocked Chrome APIs.
 * Every fixture is synthetic and all network requests are intercepted.
 * These tests observe the next rendering opportunity after a page mutation.
 * They never query controller status or force a scan during an assertion.
 * They do not test real MV3 injection, cold-start paint, or memory savings.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const TEST_URL = "https://chatgpt.com/c/fold-first-paint-test";
const SETTINGS_KEY = "cgf.settings.v1";
const DEFAULTS = { enabled: true, keepRecent: 1, maxExpanded: 1 };
const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <title>ChatGPT Fold synthetic first-frame fixture</title>
  <style>
    body { margin: 20px; font: 16px/1.5 system-ui; }
    main { max-width: 700px; }
    [data-turn-key] { margin: 12px 0; }
    [data-user-message-bubble] { margin: 6px 0; }
    [data-markdown-text-style] { display: block; }
  </style></head><body><main id="thread"></main>
  <form id="composer" data-chatgpt-composer><textarea aria-label="Synthetic input"></textarea></form>
  </body></html>`;

if (process.argv.includes("--help")) {
  console.log(`ChatGPT Fold first-frame browser regressions

  node tests/browser-first-paint.cjs
  node tests/browser-first-paint.cjs --headed

Uses injected content scripts with explicit Chrome API mocks, never a live chat.
Optional: CGF_PLAYWRIGHT_MODULE, CODEX_PRIMARY_RUNTIME_NODE_MODULES, CHROME_PATH.
Missing Playwright/Chromium exits 2 (NOT RUN), never a pass.`);
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
  globalThis.__CGF_PAINT_TEST__ = {
    setSettings: value => local.set({ [key]: value }),
    send(message) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("No content response")), 3000);
        const respond = value => { clearTimeout(timer); resolve(value); };
        for (const listener of messageListeners) {
          try { listener(message, { id: extensionId }, respond); }
          catch (error) { clearTimeout(timer); reject(error); }
        }
      });
    }
  };
}

function fixtureRuntime() {
  function makeTurn(key) {
    const turn = document.createElement("div");
    turn.id = `turn-${key}`;
    turn.setAttribute("data-turn-key", key);
    const question = document.createElement("div");
    question.setAttribute("data-user-message-bubble", "true");
    question.textContent = `Synthetic question ${key}`;
    const answer = document.createElement("div");
    answer.id = `answer-${key}`;
    answer.setAttribute("data-chatgpt-search-unit-key", `${key}:assistant`);
    answer.setAttribute("data-chatgpt-search-message-ids", `message-${key}`);
    answer.setAttribute("data-chatgpt-selection-message-id", `message-${key}`);
    const body = document.createElement("div");
    body.setAttribute("data-markdown-text-style", "assistant-message");
    const paragraph = document.createElement("p");
    paragraph.textContent = `Synthetic answer ${key}. This body must not flash while history is mounted.`;
    body.append(paragraph);
    answer.append(body);
    turn.append(question, answer);
    return turn;
  }

  function snapshot(id) {
    const answer = document.getElementById(id);
    const body = answer?.querySelector('[data-markdown-text-style="assistant-message"]');
    const control = answer?.querySelector("[data-cgf-control]");
    return {
      connected: Boolean(answer?.isConnected),
      registered: Boolean(answer?.hasAttribute("data-cgf-message")),
      collapsed: answer?.getAttribute("data-cgf-collapsed") || null,
      bodyDisplay: body ? getComputedStyle(body).display : null,
      bodyHasLayout: Boolean(body?.getClientRects().length),
      controlCount: answer?.querySelectorAll("[data-cgf-control]").length || 0,
      controlHasLayout: Boolean(control?.getClientRects().length)
    };
  }

  async function frames(id, duration = 240) {
    const start = performance.now();
    const samples = [];
    await new Promise(resolve => {
      function sample() {
        samples.push({ elapsed: Math.round(performance.now() - start), ...snapshot(id) });
        if (performance.now() - start >= duration) resolve();
        else requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    });
    return samples;
  }

  for (const key of ["old", "middle", "latest"]) {
    document.getElementById("thread").append(makeTurn(key));
  }
  globalThis.paintFixture = { makeTurn, snapshot, frames };
}

function assertFoldedFrames(samples, message) {
  assert.ok(samples.length > 0, "No animation frames were sampled");
  const exposed = samples.find(sample => !sample.registered || sample.collapsed !== "true" ||
    sample.bodyDisplay !== "none" || sample.bodyHasLayout || sample.controlCount !== 1 || !sample.controlHasLayout);
  assert.equal(exposed, undefined, `${message}; first unexpected frame: ${JSON.stringify(exposed)}`);
}

function assertVisibleFrames(samples, message, withControl = true) {
  assert.ok(samples.length > 0, "No animation frames were sampled");
  const hidden = samples.find(sample => !sample.connected || sample.bodyDisplay === "none" || !sample.bodyHasLayout ||
    (withControl && (sample.controlCount !== 1 || !sample.controlHasLayout)) ||
    (!withControl && (sample.registered || sample.controlCount !== 0)));
  assert.equal(hidden, undefined, `${message}; first unexpected frame: ${JSON.stringify(hidden)}`);
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

  async function test(name, action, settings = DEFAULTS) {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.addInitScript(chromeMock, { key: SETTINGS_KEY, settings, version: manifest.version });
      await page.goto(TEST_URL, { waitUntil: "domcontentloaded" });
      await page.evaluate(fixtureRuntime);
      for (const entry of manifest.content_scripts) {
        for (const css of entry.css || []) await page.addStyleTag({ path: path.join(ROOT, css) });
        for (const js of entry.js || []) await page.addScriptTag({ path: path.join(ROOT, js) });
      }
      // Read DOM state only. A status request can force a flush and mask bugs.
      await page.waitForFunction(() => document.documentElement.dataset.cgfActive === "true" &&
        document.querySelectorAll("[data-cgf-message]").length === 3 &&
        document.getElementById("answer-old").dataset.cgfCollapsed === "true");
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

  console.log("MODE: INJECTED content scripts + mocked Chrome APIs; first-frame synthetic DOM assertions");
  try {
    await test("newly mounted old history is folded on its first visible frame", async page => {
      const samples = await page.evaluate(async () => {
        document.getElementById("thread").prepend(paintFixture.makeTurn("history"));
        return paintFixture.frames("answer-history");
      });
      assertFoldedFrames(samples, "Old history flashed before folding");
      assert.equal(await page.locator("#answer-latest").getAttribute("data-cgf-collapsed"), "false",
        "Mounting older history stole the latest answer's expansion");
      assert.equal(await page.locator("[data-user-message-bubble] [data-cgf-control]").count(), 0);
    });

    await test("a retired old answer remounts folded with the same message identity", async page => {
      await page.evaluate(() => {
        window.retiredAnswer = document.getElementById("answer-old");
        document.getElementById("turn-old").remove();
      });
      await page.waitForFunction(() => !window.retiredAnswer.hasAttribute("data-cgf-message"));
      const samples = await page.evaluate(async () => {
        document.getElementById("thread").prepend(paintFixture.makeTurn("old"));
        return paintFixture.frames("answer-old");
      });
      assertFoldedFrames(samples, "Remounting a retired answer exposed its original body");
    });

    await test("late text hydration never reopens a collapsed historical answer", async page => {
      const samples = await page.evaluate(async () => {
        document.querySelector("#answer-old p").firstChild.appendData(" Deferred text arrived.");
        return paintFixture.frames("answer-old");
      });
      assertFoldedFrames(samples, "An ordinary text mutation reopened old content");
    });

    await test("reusing a historical root for another identity keeps it folded", async page => {
      const samples = await page.evaluate(async () => {
        const answer = document.getElementById("answer-old");
        answer.setAttribute("data-chatgpt-search-unit-key", "replacement-history:assistant");
        answer.setAttribute("data-chatgpt-search-message-ids", "message-replacement-history");
        answer.setAttribute("data-chatgpt-selection-message-id", "message-replacement-history");
        answer.querySelector("p").textContent = "A different historical message now uses this root.";
        return paintFixture.frames("answer-old");
      });
      assertFoldedFrames(samples, "Changing an old root's identity treated history as generation");
    });

    await test("historical window tails stay folded and a remounted known latest permits genuine appends", async page => {
      const remaining = await page.evaluate(async () => {
        document.getElementById("turn-latest").remove();
        return paintFixture.frames("answer-middle");
      });
      assertFoldedFrames(remaining, "Removing the real latest answer expanded the older mounted tail");
      // A later task can append more history after the still-mounted older
      // tail. That tail must not silently become the known newest answer.
      const appendedHistory = await page.evaluate(async () => {
        document.getElementById("thread").append(paintFixture.makeTurn("history-tail"));
        return paintFixture.frames("answer-history-tail");
      });
      assertFoldedFrames(appendedHistory, "Appending after an older window tail was mistaken for a new answer");

      // The real latest can return as a new DOM object with the same identity.
      // Its own open/closed state is not prescribed here; registration alone
      // must allow a subsequent genuine append to honor keepRecent again.
      await page.evaluate(() => {
        document.getElementById("thread").append(paintFixture.makeTurn("latest"));
      });
      await page.waitForFunction(() => document.getElementById("answer-latest").hasAttribute("data-cgf-message"));
      const advanced = await page.evaluate(async () => {
        document.getElementById("thread").append(paintFixture.makeTurn("new-latest"));
        const [newest, previous] = await Promise.all([
          paintFixture.frames("answer-new-latest"), paintFixture.frames("answer-latest")
        ]);
        return { newest, previous, history: [paintFixture.snapshot("answer-middle"), paintFixture.snapshot("answer-history-tail")] };
      });
      assertVisibleFrames(advanced.newest, "A genuine append after the remounted known latest did not open");
      assertFoldedFrames(advanced.previous, "The previous latest stayed open after a genuine append");
      assertFoldedFrames(advanced.history, "A genuine append reopened an older historical answer");

      const replaced = await page.evaluate(async () => {
        document.getElementById("thread").replaceChildren(
          paintFixture.makeTurn("window-old"), paintFixture.makeTurn("window-tail"));
        return paintFixture.frames("answer-window-tail");
      });
      assertFoldedFrames(replaced, "Replacing the visible window expanded its historical tail");
    });

    await test("replacing an old body preserves folding and repairs its control before paint", async page => {
      const samples = await page.evaluate(async () => {
        const body = document.createElement("div");
        body.setAttribute("data-markdown-text-style", "assistant-message");
        const paragraph = document.createElement("p");
        paragraph.textContent = "Deferred historical subtree replacement.";
        body.append(paragraph);
        document.getElementById("answer-old").replaceChildren(body);
        return paintFixture.frames("answer-old");
      });
      assertFoldedFrames(samples, "Replacing the historical subtree exposed its content or lost its control");
    });

    await test("a cached hidden timeline is folded before its first visible frame", async page => {
      await page.evaluate(async () => {
        const cache = document.createElement("section");
        cache.id = "cached-history";
        cache.style.display = "none";
        cache.append(paintFixture.makeTurn("cached"));
        document.getElementById("thread").prepend(cache);
        await new Promise(requestAnimationFrame);
      });
      const samples = await page.evaluate(async () => {
        document.getElementById("cached-history").style.display = "block";
        return paintFixture.frames("answer-cached");
      });
      assertFoldedFrames(samples, "Activating a cached timeline exposed old content");
    });

    await test("changing an assistant unit to a user restores content before paint", async page => {
      const samples = await page.evaluate(async () => {
        document.getElementById("answer-old").setAttribute("data-chatgpt-search-unit-key", "old:user");
        return paintFixture.frames("answer-old");
      });
      assertVisibleFrames(samples, "An explicit user role remained folded", false);
    });

    await test("a new streaming answer stays visible even when keepRecent is zero", async page => {
      const samples = await page.evaluate(async () => {
        const stop = document.createElement("button");
        stop.type = "button";
        stop.setAttribute("aria-label", "Stop");
        stop.textContent = "Stop synthetic generation";
        document.getElementById("composer").append(stop);
        document.getElementById("thread").append(paintFixture.makeTurn("streaming"));
        return paintFixture.frames("answer-streaming");
      });
      assertVisibleFrames(samples, "The streaming answer was hidden or registered too late");
    }, { ...DEFAULTS, keepRecent: 0 });

    await test("a streaming marker inside a collapsed answer restores it before paint", async page => {
      const samples = await page.evaluate(async () => {
        document.querySelector('#answer-old [data-markdown-text-style="assistant-message"]').classList.add("result-streaming");
        return paintFixture.frames("answer-old");
      });
      assertVisibleFrames(samples, "Extension folding concealed an explicit descendant streaming marker");
    });

    await test("a natively CSS-hidden streaming marker does not reopen historical content", async page => {
      const samples = await page.evaluate(async () => {
        const style = document.createElement("style");
        style.textContent = ".synthetic-native-hidden-stream { display: none; }";
        document.head.append(style);
        const marker = document.createElement("div");
        marker.className = "synthetic-native-hidden-stream result-streaming";
        marker.textContent = "Native hidden generation UI from an inactive branch.";
        document.getElementById("answer-old").append(marker);
        return paintFixture.frames("answer-old");
      });
      assertFoldedFrames(samples, "A site-hidden streaming marker reopened history");
    });

    await test("paused folding leaves newly mounted history visible", async page => {
      await page.evaluate(() => window.__CGF_PAINT_TEST__.send({ type: "CGF_COMMAND", command: "restore" }));
      const samples = await page.evaluate(async () => {
        document.getElementById("thread").prepend(paintFixture.makeTurn("paused"));
        return paintFixture.frames("answer-paused");
      });
      assertVisibleFrames(samples, "Paused folding affected newly mounted history", false);
    });

    await test("disabled folding leaves newly mounted history visible", async page => {
      await page.evaluate(settings => window.__CGF_PAINT_TEST__.setSettings(settings), { ...DEFAULTS, enabled: false });
      await page.waitForFunction(() => !document.documentElement.hasAttribute("data-cgf-active"));
      const samples = await page.evaluate(async () => {
        document.getElementById("thread").prepend(paintFixture.makeTurn("disabled"));
        return paintFixture.frames("answer-disabled");
      });
      assertVisibleFrames(samples, "Disabled folding affected newly mounted history", false);
    });

    console.log(`${passed}/${passed + failed} first-frame groups passed.`);
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
