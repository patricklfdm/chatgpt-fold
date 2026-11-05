#!/usr/bin/env node
"use strict";

/*
 * First-frame regressions for history mounts and generation ownership.
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
      controlHasLayout: Boolean(control?.getClientRects().length),
      controlDisabled: control?.disabled ?? null,
      badge: control?.querySelector(".cgf-badge")?.textContent || null
    };
  }

  function makePendingTurn(key) {
    const turn = makeTurn(key);
    turn.querySelector('[data-chatgpt-search-unit-key$=":assistant"]').remove();
    return turn;
  }

  function addStop() {
    const stop = document.createElement("button");
    stop.id = "generation-stop";
    stop.type = "button";
    stop.setAttribute("aria-label", "Stop");
    stop.textContent = "Stop synthetic generation";
    document.getElementById("composer").append(stop);
    return stop;
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
  globalThis.paintFixture = { makeTurn, makePendingTurn, addStop, snapshot, frames };
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

function assertOperableFrames(samples, message) {
  assert.ok(samples.length > 0, "No animation frames were sampled");
  const blocked = samples.find(sample => !sample.registered || sample.controlCount !== 1 ||
    !sample.controlHasLayout || sample.controlDisabled !== false || sample.badge === "生成中");
  assert.equal(blocked, undefined, `${message}; first unexpected frame: ${JSON.stringify(blocked)}`);
}

function assertGeneratingFrames(samples, message) {
  assertVisibleFrames(samples, message);
  const unprotected = samples.find(sample => !sample.controlDisabled || sample.badge !== "生成中");
  assert.equal(unprotected, undefined, `${message}; first unexpected frame: ${JSON.stringify(unprotected)}`);
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

    await test("Stop before the new prompt leaves the previous answer operable", async page => {
      const thinking = await page.evaluate(async () => {
        paintFixture.addStop();
        return paintFixture.frames("answer-latest");
      });
      assertVisibleFrames(thinking, "Thinking changed the previous answer's expansion");
      assertOperableFrames(thinking, "Stop alone mislabeled the previous completed answer as generating");

      const folded = await page.evaluate(async () => {
        document.querySelector("#answer-latest [data-cgf-control]").click();
        return paintFixture.frames("answer-latest");
      });
      assertFoldedFrames(folded, "The previous answer could not be folded while the next reply was thinking");
      assertOperableFrames(folded, "Folding the previous answer incorrectly disabled its control");

      const pending = await page.evaluate(async () => {
        document.getElementById("thread").append(paintFixture.makePendingTurn("pending"));
        return paintFixture.frames("answer-latest");
      });
      assertFoldedFrames(pending, "Mounting only a new question reopened the previous answer");
      assertOperableFrames(pending, "Mounting the pending question locked the previous answer");

      const generated = await page.evaluate(async () => {
        const answer = paintFixture.makeTurn("pending").querySelector("#answer-pending");
        document.getElementById("turn-pending").append(answer);
        const [current, previous] = await Promise.all([
          paintFixture.frames("answer-pending"), paintFixture.frames("answer-latest")
        ]);
        return { current, previous };
      });
      assertGeneratingFrames(generated.current, "The real new reply did not acquire generation protection");
      assertFoldedFrames(generated.previous, "The real new reply reopened the previous answer");
      assertOperableFrames(generated.previous, "The previous answer stayed locked after the new reply arrived");
    });

    await test("a pending user question never transfers Stop protection to a folded old answer", async page => {
      await page.evaluate(() => {
        document.getElementById("thread").append(paintFixture.makePendingTurn("pending"));
      });
      const thinking = await page.evaluate(async () => {
        paintFixture.addStop();
        return paintFixture.frames("answer-latest");
      });
      assertOperableFrames(thinking, "A pending user question left the old answer marked as generating");
      assertFoldedFrames(thinking, "Thinking reopened a previously folded answer");

      const generated = await page.evaluate(async () => {
        document.getElementById("turn-pending").append(
          paintFixture.makeTurn("pending").querySelector("#answer-pending"));
        return paintFixture.frames("answer-pending");
      });
      assertGeneratingFrames(generated, "A new reply was folded despite active generation and keepRecent zero");
      await page.evaluate(() => document.getElementById("generation-stop").remove());
      // Completion can use the normal debounced cleanup; no status or rescan
      // request may be used to force that cleanup.
      await page.waitForFunction(() => document.querySelector("#answer-pending [data-cgf-control]")?.disabled === false);
      const finished = await page.evaluate(() => paintFixture.frames("answer-pending"));
      assertFoldedFrames(finished, "Completed generation ignored keepRecent zero");
      assertOperableFrames(finished, "Completed generation retained a stale protection reason");
    }, { ...DEFAULTS, keepRecent: 0 });

    await test("cancelling thinking before an answer leaves no stale generation target", async page => {
      const thinking = await page.evaluate(async () => {
        document.getElementById("thread").append(paintFixture.makePendingTurn("cancelled"));
        paintFixture.addStop();
        return paintFixture.frames("answer-latest");
      });
      assertOperableFrames(thinking, "A cancelled request first locked an unrelated completed answer");
      assertFoldedFrames(thinking, "A cancelled request reopened the previous answer");
      const cancelled = await page.evaluate(async () => {
        document.getElementById("generation-stop").remove();
        return paintFixture.frames("answer-latest");
      });
      assertFoldedFrames(cancelled, "Cancelling thinking changed the previous answer's expansion");
      assertOperableFrames(cancelled, "Cancelling thinking left the previous answer disabled");
      const afterCancel = await page.evaluate(async () => {
        document.getElementById("turn-cancelled").append(
          paintFixture.makeTurn("cancelled").querySelector("#answer-cancelled"));
        return paintFixture.frames("answer-cancelled");
      });
      assertFoldedFrames(afterCancel, "An answer arriving after Stop disappeared inherited stale protection");
      assertOperableFrames(afterCancel, "The cancelled generation session remained attached to a later answer");
    }, { ...DEFAULTS, keepRecent: 0 });

    await test("historical unmounts and remounts cannot acquire a pending request's Stop protection", async page => {
      await page.evaluate(async () => {
        document.getElementById("thread").append(paintFixture.makePendingTurn("pending"));
        paintFixture.addStop();
        await new Promise(requestAnimationFrame);
      });
      const olderTail = await page.evaluate(async () => {
        document.getElementById("turn-latest").remove();
        return paintFixture.frames("answer-middle");
      });
      assertOperableFrames(olderTail, "Unmounting the latest old answer moved Stop protection onto older history");
      assertFoldedFrames(olderTail, "Unmounting the latest old answer reopened the historical tail");

      const remounted = await page.evaluate(async () => {
        const thread = document.getElementById("thread");
        thread.prepend(paintFixture.makeTurn("history"));
        thread.insertBefore(paintFixture.makeTurn("latest"), document.getElementById("turn-pending"));
        const [latest, history] = await Promise.all([
          paintFixture.frames("answer-latest"), paintFixture.frames("answer-history")
        ]);
        return { latest, history };
      });
      assertOperableFrames(remounted.latest, "Remounting the completed latest answer stole pending generation protection");
      assertFoldedFrames(remounted.latest, "Remounting the completed latest answer reopened it during thinking");
      assertOperableFrames(remounted.history, "Mounting older history acquired pending generation protection");
      assertFoldedFrames(remounted.history, "Mounting older history reopened it during thinking");

      const generated = await page.evaluate(async () => {
        document.getElementById("turn-pending").append(
          paintFixture.makeTurn("pending").querySelector("#answer-pending"));
        return paintFixture.frames("answer-pending");
      });
      assertGeneratingFrames(generated, "History remounts prevented the real answer from acquiring protection");
    }, { ...DEFAULTS, keepRecent: 0 });

    await test("an explicit local regeneration marker protects only its own answer", async page => {
      const samples = await page.evaluate(async () => {
        paintFixture.addStop();
        document.querySelector('#answer-old [data-markdown-text-style="assistant-message"]').classList.add("result-streaming");
        const [regenerating, unrelated] = await Promise.all([
          paintFixture.frames("answer-old"), paintFixture.frames("answer-latest")
        ]);
        return { regenerating, unrelated };
      });
      assertGeneratingFrames(samples.regenerating, "A local marker failed to protect regeneration of an older answer");
      assertOperableFrames(samples.unrelated, "Composer Stop additionally locked an unrelated completed answer");
      assertFoldedFrames(samples.unrelated, "Composer Stop additionally reopened an unrelated completed answer");
    }, { ...DEFAULTS, keepRecent: 0 });

    await test("an active target survives identity enrichment and stable remounts without protecting history", async page => {
      const anonymous = await page.evaluate(async () => {
        paintFixture.addStop();
        const turn = paintFixture.makeTurn("target");
        const answer = turn.querySelector("#answer-target");
        answer.removeAttribute("data-chatgpt-search-message-ids");
        answer.removeAttribute("data-chatgpt-selection-message-id");
        document.getElementById("thread").append(turn);
        return paintFixture.frames("answer-target");
      });
      assertGeneratingFrames(anonymous, "A genuine append without stable IDs did not acquire generation protection");

      const enriched = await page.evaluate(async () => {
        const answer = document.getElementById("answer-target");
        answer.setAttribute("data-chatgpt-search-message-ids", "message-target");
        answer.setAttribute("data-chatgpt-selection-message-id", "message-target");
        return paintFixture.frames("answer-target");
      });
      assertGeneratingFrames(enriched, "Adding stable IDs to the same live answer lost generation protection");

      const unmounted = await page.evaluate(async () => {
        document.getElementById("turn-target").remove();
        return paintFixture.frames("answer-latest");
      });
      assertFoldedFrames(unmounted, "Unmounting the active target reopened an older answer");
      assertOperableFrames(unmounted, "Unmounting the active target transferred its protection to history");
      const history = await page.evaluate(async () => {
        document.getElementById("thread").append(paintFixture.makeTurn("history-tail"));
        return paintFixture.frames("answer-history-tail");
      });
      assertFoldedFrames(history, "History mounted in place of an absent generation target reopened");
      assertOperableFrames(history, "History mounted in place of an absent generation target acquired protection");

      const remounted = await page.evaluate(async () => {
        document.getElementById("thread").append(paintFixture.makeTurn("target"));
        return paintFixture.frames("answer-target");
      });
      assertGeneratingFrames(remounted, "The target's stable message identity failed to survive remounting");
    }, { ...DEFAULTS, keepRecent: 0 });

    await test("a later request uses a fresh target and anonymous remounts cannot inherit it", async page => {
      const first = await page.evaluate(async () => {
        paintFixture.addStop();
        document.getElementById("thread").append(paintFixture.makeTurn("first-request"));
        return paintFixture.frames("answer-first-request");
      });
      assertGeneratingFrames(first, "The first request did not acquire a generation target");
      await page.evaluate(() => document.getElementById("generation-stop").remove());
      await page.waitForFunction(() => document.querySelector("#answer-first-request [data-cgf-control]")?.disabled === false);

      const thinking = await page.evaluate(async () => {
        paintFixture.addStop();
        return paintFixture.frames("answer-first-request");
      });
      assertFoldedFrames(thinking, "Starting a later request reopened the completed previous target");
      assertOperableFrames(thinking, "Starting a later request reused the previous generation target");

      const second = await page.evaluate(async () => {
        const turn = paintFixture.makeTurn("second-request");
        const answer = turn.querySelector("#answer-second-request");
        answer.removeAttribute("data-chatgpt-search-message-ids");
        answer.removeAttribute("data-chatgpt-selection-message-id");
        document.getElementById("thread").append(turn);
        const [current, previous] = await Promise.all([
          paintFixture.frames("answer-second-request"), paintFixture.frames("answer-first-request")
        ]);
        return { current, previous };
      });
      assertGeneratingFrames(second.current, "A later request failed to protect its own new answer");
      assertOperableFrames(second.previous, "The previous target remained protected during the later reply");
      assertFoldedFrames(second.previous, "The previous target reopened during the later reply");

      await page.evaluate(async () => {
        document.getElementById("turn-second-request").remove();
        await paintFixture.frames("answer-first-request");
      });
      const replacement = await page.evaluate(async () => {
        // A positional key can be reused by another historical DOM root. With
        // no stable message ID it cannot prove ownership of the retired target.
        const turn = paintFixture.makeTurn("second-request");
        const answer = turn.querySelector("#answer-second-request");
        answer.removeAttribute("data-chatgpt-search-message-ids");
        answer.removeAttribute("data-chatgpt-selection-message-id");
        document.getElementById("thread").append(turn);
        return paintFixture.frames("answer-second-request");
      });
      assertOperableFrames(replacement, "An anonymous replacement root inherited a retired record's protection");
      assertFoldedFrames(replacement, "An anonymous replacement root was mistaken for the active reply");
    }, { ...DEFAULTS, keepRecent: 0 });

    await test("a modern in-progress reply stays open after the previous tail unmounts", async page => {
      await page.evaluate(async () => {
        const pending = paintFixture.makePendingTurn("native-pending");
        pending.setAttribute("data-talvt-turn-state", "in_progress");
        document.getElementById("thread").append(pending);
        paintFixture.addStop();
        await new Promise(requestAnimationFrame);
      });
      const older = await page.evaluate(async () => {
        document.getElementById("turn-latest").remove();
        return paintFixture.frames("answer-middle");
      });
      assertFoldedFrames(older, "Losing the tail transferred native generation protection to history");
      assertOperableFrames(older, "An unrelated historical answer became locked during generation");

      const generated = await page.evaluate(async () => {
        document.getElementById("turn-native-pending").append(
          paintFixture.makeTurn("native-pending").querySelector("#answer-native-pending"));
        return paintFixture.frames("answer-native-pending");
      });
      assertGeneratingFrames(generated, "The new native reply folded because its previous tail was absent");
      const updated = await page.evaluate(async () => {
        document.querySelector("#answer-native-pending p").firstChild.appendData(" More streamed text.");
        return paintFixture.frames("answer-native-pending");
      });
      assertGeneratingFrames(updated, "Ordinary streamed text lost the native turn's protection");
    });

    await test("native generation survives a message ID change and replacement answer root", async page => {
      const initial = await page.evaluate(async () => {
        paintFixture.addStop();
        const turn = paintFixture.makeTurn("native-target");
        turn.setAttribute("data-talvt-turn-state", "in_progress");
        document.getElementById("thread").append(turn);
        return paintFixture.frames("answer-native-target");
      });
      assertGeneratingFrames(initial, "The initial native target did not acquire generation protection");

      const changed = await page.evaluate(async () => {
        const answer = document.getElementById("answer-native-target");
        answer.setAttribute("data-chatgpt-search-message-ids", "message-native-final");
        answer.setAttribute("data-chatgpt-selection-message-id", "message-native-final");
        answer.querySelector("p").textContent = "The native final response is still being generated.";
        return paintFixture.frames("answer-native-target");
      });
      assertGeneratingFrames(changed, "Changing the active message identity folded an in-progress reply");

      const replaced = await page.evaluate(async () => {
        const answer = paintFixture.makeTurn("native-target").querySelector("#answer-native-target");
        answer.setAttribute("data-chatgpt-search-message-ids", "message-native-final");
        answer.setAttribute("data-chatgpt-selection-message-id", "message-native-final");
        document.getElementById("answer-native-target").replaceWith(answer);
        return paintFixture.frames("answer-native-target");
      });
      assertGeneratingFrames(replaced, "Replacing the active root lost its native turn's generation protection");
    });

    await test("native generation overrides the expansion cap temporarily and releases on completion", async page => {
      const initial = await page.evaluate(async () => {
        document.getElementById("turn-latest").setAttribute("data-talvt-turn-state", "complete");
        return paintFixture.frames("answer-latest");
      });
      assertFoldedFrames(initial, "An already registered completed reply ignored keepRecent zero");
      const started = await page.evaluate(async () => {
        document.getElementById("turn-latest").setAttribute("data-talvt-turn-state", "in_progress");
        return paintFixture.frames("answer-latest");
      });
      assertGeneratingFrames(started, "A registered reply did not open when its native turn started generation");

      const openedHistory = await page.evaluate(async () => {
        document.querySelector("#answer-middle [data-cgf-control]").click();
        const [current, history] = await Promise.all([
          paintFixture.frames("answer-latest"), paintFixture.frames("answer-middle")
        ]);
        return { current, history };
      });
      assertGeneratingFrames(openedHistory.current, "Opening history at the cap folded the actively generating reply");
      assertVisibleFrames(openedHistory.history, "Generation protection displaced a manual history choice");
      assertOperableFrames(openedHistory.history, "A manually opened historical answer inherited generation protection");

      const completed = await page.evaluate(async () => {
        document.getElementById("turn-latest").setAttribute("data-talvt-turn-state", "complete");
        const [current, history] = await Promise.all([
          paintFixture.frames("answer-latest"), paintFixture.frames("answer-middle")
        ]);
        return { current, history };
      });
      assertFoldedFrames(completed.current, "Temporary native protection became a persistent open choice");
      assertOperableFrames(completed.current, "Completion left the native generation control disabled");
      assertVisibleFrames(completed.history, "Completing generation discarded a manual history choice");
    }, { ...DEFAULTS, keepRecent: 0 });

    await test("a native pending user turn leaves the previous completed reply operable", async page => {
      const pending = await page.evaluate(async () => {
        const turn = paintFixture.makePendingTurn("native-thinking");
        turn.setAttribute("data-talvt-turn-state", "in_progress");
        document.getElementById("thread").append(turn);
        return paintFixture.frames("answer-latest");
      });
      assertVisibleFrames(pending, "A pending native turn changed the previous reply's expansion");
      assertOperableFrames(pending, "A native thinking turn locked the previous completed reply");

      const folded = await page.evaluate(async () => {
        document.querySelector("#answer-latest [data-cgf-control]").click();
        paintFixture.addStop();
        return paintFixture.frames("answer-latest");
      });
      assertFoldedFrames(folded, "A pending native turn or composer Stop reopened the previous reply");
      assertOperableFrames(folded, "Adding Stop to native thinking disabled the previous reply's control");
      assert.equal(await page.locator("#turn-native-thinking [data-cgf-control]").count(), 0,
        "A pending question acquired an assistant folding control");
    });

    await test("native turn state protects generation when the global Stop control disappears", async page => {
      const initial = await page.evaluate(async () => {
        paintFixture.addStop();
        const turn = paintFixture.makeTurn("native-stop-gap");
        turn.setAttribute("data-talvt-turn-state", "in_progress");
        document.getElementById("thread").append(turn);
        return paintFixture.frames("answer-native-stop-gap");
      });
      assertGeneratingFrames(initial, "The native reply failed to acquire its initial protection");
      const stopGap = await page.evaluate(async () => {
        document.getElementById("generation-stop").remove();
        return paintFixture.frames("answer-native-stop-gap");
      });
      assertGeneratingFrames(stopGap, "Removing the global Stop control folded a native in-progress reply");

      const finished = await page.evaluate(async () => {
        document.getElementById("turn-native-stop-gap").setAttribute("data-talvt-turn-state", "complete");
        return paintFixture.frames("answer-native-stop-gap");
      });
      assertFoldedFrames(finished, "The native reply remained permanently open after completion");
      assertOperableFrames(finished, "The native reply retained stale generation protection after completion");
    }, { ...DEFAULTS, keepRecent: 0 });

    await test("native-hidden in-progress markers cannot reopen historical content", async page => {
      for (const mode of ["hidden", "aria-hidden", "display", "visibility", "presentation"]) {
        const samples = await page.evaluate(async mode => {
          document.getElementById("hidden-native-marker")?.remove();
          const marker = document.createElement("div");
          marker.id = "hidden-native-marker";
          marker.setAttribute("data-talvt-turn-state", "in_progress");
          if (mode === "hidden") marker.hidden = true;
          if (mode === "aria-hidden") marker.setAttribute("aria-hidden", "true");
          if (mode === "display") marker.style.display = "none";
          if (mode === "visibility") marker.style.visibility = "hidden";
          if (mode === "presentation") {
            marker.setAttribute("data-app-action-timeline-scroll", "");
            marker.setAttribute("role", "presentation");
          }
          document.getElementById("answer-old").append(marker);
          return paintFixture.frames("answer-old");
        }, mode);
        assertFoldedFrames(samples, `A native ${mode} marker reopened historical content`);
        assertOperableFrames(samples, `A native ${mode} marker disabled a historical control`);
      }
    });

    await test("unknown and completed native turn states do not imply generation", async page => {
      for (const state of ["", "complete", "pending", "streaming", "in-progress", "IN_PROGRESS", "other"]) {
        const samples = await page.evaluate(async state => {
          document.getElementById("turn-latest").setAttribute("data-talvt-turn-state", state);
          return paintFixture.frames("answer-latest");
        }, state);
        assertFoldedFrames(samples, `Native turn state ${JSON.stringify(state)} reopened completed content`);
        assertOperableFrames(samples, `Native turn state ${JSON.stringify(state)} claimed generation ownership`);
      }
    }, { ...DEFAULTS, keepRecent: 0 });

    await test("an ambiguous in-progress ancestor cannot expand multiple answers", async page => {
      const answers = await page.evaluate(async () => {
        document.getElementById("thread").setAttribute("data-talvt-turn-state", "in_progress");
        return Promise.all(["old", "middle", "latest"].map(key => paintFixture.frames(`answer-${key}`)));
      });
      for (const samples of answers) {
        assertFoldedFrames(samples, "A broad native generation marker reopened the conversation history");
        assertOperableFrames(samples, "A broad native generation marker locked unrelated answers");
      }
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
