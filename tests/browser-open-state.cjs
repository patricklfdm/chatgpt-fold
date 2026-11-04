#!/usr/bin/env node
"use strict";

/*
 * Open-state regressions for history remounts and newly appended replies.
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
const TEST_URL = "https://chatgpt.com/c/fold-open-state-test";
const SETTINGS_KEY = "cgf.settings.v1";
const DEFAULTS = { enabled: true, keepRecent: 1, maxExpanded: 3 };
const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <title>ChatGPT Fold synthetic open-state fixture</title>
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
  console.log(`ChatGPT Fold open-state browser regressions

  node tests/browser-open-state.cjs
  node tests/browser-open-state.cjs --headed

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
  globalThis.__CGF_OPEN_TEST__ = {
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
  function makeTurn(key, identityKind = "message") {
    const turn = document.createElement("div");
    turn.id = `turn-${key}`;
    turn.setAttribute("data-turn-key", key);
    const question = document.createElement("div");
    question.setAttribute("data-user-message-bubble", "true");
    question.textContent = `Synthetic question ${key}`;
    const answer = document.createElement("div");
    answer.id = `answer-${key}`;
    if (["anonymous", "nested-carrier"].includes(identityKind)) answer.setAttribute("data-message-author-role", "assistant");
    else answer.setAttribute(identityKind === "content-unit" ? "data-content-search-unit-key" :
      "data-chatgpt-search-unit-key", ['unit', 'content-unit'].includes(identityKind) ?
      'fallback-turn-0:0:assistant' : `${key}:assistant`);
    if (identityKind === "message") {
      answer.setAttribute("data-chatgpt-search-message-ids", `message-${key}`);
      answer.setAttribute("data-chatgpt-selection-message-id", `message-${key}`);
    }
    const body = document.createElement("div");
    body.setAttribute("data-markdown-text-style", "assistant-message");
    if (identityKind === "nested-carrier") body.setAttribute("data-chatgpt-search-message-ids", `message-${key}`);
    const paragraph = document.createElement("p");
    paragraph.textContent = `Synthetic answer ${key}. Its open state belongs to this message.`;
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

  for (const key of ["a", "b", "latest"]) {
    document.getElementById("thread").append(makeTurn(key));
  }
  globalThis.openFixture = { makeTurn, snapshot, frames };
}

function assertFoldedFrames(samples, message) {
  assert.ok(samples.length > 0, "No animation frames were sampled");
  const exposed = samples.find(sample => !sample.registered || sample.collapsed !== "true" ||
    sample.bodyDisplay !== "none" || sample.bodyHasLayout || sample.controlCount !== 1 || !sample.controlHasLayout);
  assert.equal(exposed, undefined, `${message}; first unexpected frame: ${JSON.stringify(exposed)}`);
}

function assertVisibleFrames(samples, message, withControl = true) {
  assert.ok(samples.length > 0, "No animation frames were sampled");
  const hidden = samples.find(sample => !sample.connected || (withControl && sample.collapsed !== "false") || sample.bodyDisplay === "none" || !sample.bodyHasLayout ||
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
        document.getElementById("answer-a").dataset.cgfCollapsed === "true");
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


  async function openOnly(page, keys) {
    // Explicit user actions establish the initial state. No status/rescan is
    // sent between a later site mutation and its frame assertions.
    await page.locator('#answer-latest > [data-cgf-toggle]').click();
    for (const key of keys) await page.locator(`#answer-${key} > [data-cgf-toggle]`).click();
  }

  async function retire(page, key) {
    await page.evaluate(key => {
      window.retiredAnswer = document.getElementById(`answer-${key}`);
      document.getElementById(`turn-${key}`).remove();
    }, key);
    await page.waitForFunction(() => !window.retiredAnswer.hasAttribute('data-cgf-message'));
  }

  console.log('MODE: INJECTED content scripts + mocked Chrome APIs; open-state first-frame assertions');
  try {
    await test('manual opens survive fresh historical remounts with spare capacity', async page => {
      await openOnly(page, ['a', 'b']);
      await retire(page, 'a');
      const samples = await page.evaluate(async () => {
        document.getElementById('thread').prepend(openFixture.makeTurn('a'));
        const [restored, retained] = await Promise.all([
          openFixture.frames('answer-a'), openFixture.frames('answer-b')
        ]);
        return { restored, retained };
      });
      assertVisibleFrames(samples.restored, 'Remounting a manually opened answer discarded its open state');
      assertVisibleFrames(samples.retained, 'Restoring one answer collapsed another within capacity');
    });

    await test('new replies preserve already open answers until the cap is exceeded', async page => {
      await openOnly(page, ['a', 'b']);
      const samples = await page.evaluate(async () => {
        const stop = document.createElement('button');
        stop.id = 'generation-stop';
        stop.type = 'button';
        stop.setAttribute('aria-label', 'Stop');
        document.getElementById('composer').append(stop);
        document.getElementById('thread').append(openFixture.makeTurn('c'));
        return Promise.all(['a', 'b', 'c'].map(key => openFixture.frames(`answer-${key}`)));
      });
      for (const sample of samples) assertVisibleFrames(sample, 'A new reply reset existing opens with room available');
      const finished = await page.evaluate(async () => {
        document.getElementById('generation-stop').remove();
        return Promise.all(['a', 'b', 'c'].map(key => openFixture.frames(`answer-${key}`)));
      });
      for (const sample of finished) assertVisibleFrames(sample, 'Generation completion discarded an open answer within capacity');
      assert.equal(await page.locator('[data-cgf-message][data-cgf-collapsed="false"]').count(), 3);
    });

    await test('off-DOM open intentions count toward the cap and evicted history stays folded', async page => {
      await openOnly(page, ['a', 'b']);
      await retire(page, 'a');
      const onceRestored = await page.evaluate(async () => {
        document.getElementById('thread').prepend(openFixture.makeTurn('a'));
        return openFixture.frames('answer-a');
      });
      assertVisibleFrames(onceRestored, 'A manual open was lost before testing eviction priority');
      // Merely revisiting history must not make its old intention newer than B.
      await retire(page, 'a');
      await page.evaluate(async () => {
        document.getElementById('thread').append(openFixture.makeTurn('c'));
        await openFixture.frames('answer-c');
      });
      const full = await page.evaluate(async () => {
        document.getElementById('thread').append(openFixture.makeTurn('d'));
        return Promise.all(['b', 'c', 'd'].map(key => openFixture.frames(`answer-${key}`)));
      });
      for (const sample of full) assertVisibleFrames(sample, 'Adding a fourth intention evicted more than the oldest open');
      // Free a slot before A returns: an already evicted off-DOM choice must
      // not resurrect merely because capacity becomes available again.
      await page.locator('#answer-d > [data-cgf-toggle]').click();
      const evicted = await page.evaluate(async () => {
        document.getElementById('thread').prepend(openFixture.makeTurn('a'));
        return openFixture.frames('answer-a');
      });
      assertFoldedFrames(evicted, 'An off-DOM intention evicted by the cap was restored anyway');
      await page.locator('#answer-d > [data-cgf-toggle]').click();
      await page.locator('#answer-a > [data-cgf-toggle]').click();
      const manual = await page.evaluate(() => Promise.all(['a', 'c', 'd'].map(key => openFixture.frames(`answer-${key}`))));
      for (const sample of manual) assertVisibleFrames(sample, 'A manual open failed to retain the newer ordinary opens');
      const oldest = await page.evaluate(() => openFixture.frames('answer-b'));
      assertFoldedFrames(oldest, 'A manual open over the cap did not evict the oldest remaining intention');
    });

    await test('manual collapse is preserved through remount and later reply insertion', async page => {
      await openOnly(page, ['a', 'b']);
      await page.locator('#answer-a > [data-cgf-toggle]').click();
      await retire(page, 'a');
      const restored = await page.evaluate(async () => {
        document.getElementById('thread').prepend(openFixture.makeTurn('a'));
        return openFixture.frames('answer-a');
      });
      assertFoldedFrames(restored, 'A deliberately collapsed answer reopened when remounted');
      const appended = await page.evaluate(async () => {
        document.getElementById('thread').append(openFixture.makeTurn('c'));
        const [closed, kept, newest] = await Promise.all([
          openFixture.frames('answer-a'), openFixture.frames('answer-b'), openFixture.frames('answer-c')
        ]);
        return { closed, kept, newest };
      });
      assertFoldedFrames(appended.closed, 'A new reply undid an explicit collapse');
      assertVisibleFrames(appended.kept, 'A new reply reset another retained open below the cap');
      assertVisibleFrames(appended.newest, 'A newly appended answer did not honor keepRecent');
    });

    await test('native hidden timelines retain manual opens when they become active again', async page => {
      await openOnly(page, ['a', 'b']);
      await page.evaluate(() => { document.getElementById('turn-a').style.display = 'none'; });
      await page.waitForFunction(() => !document.getElementById('answer-a').hasAttribute('data-cgf-message'));
      const samples = await page.evaluate(async () => {
        document.getElementById('turn-a').style.display = 'block';
        return Promise.all(['a', 'b'].map(key => openFixture.frames(`answer-${key}`)));
      });
      for (const sample of samples) assertVisibleFrames(sample, 'Hiding and reactivating native history lost a manual open');
    });

    await test('recycling an open root does not transfer its state to a different message', async page => {
      await openOnly(page, ['a', 'b']);
      const recycled = await page.evaluate(async () => {
        const turn = document.getElementById('turn-a');
        const answer = document.getElementById('answer-a');
        turn.id = 'turn-recycled';
        answer.id = 'answer-recycled';
        answer.setAttribute('data-chatgpt-search-unit-key', 'recycled:assistant');
        answer.setAttribute('data-chatgpt-search-message-ids', 'message-recycled');
        answer.setAttribute('data-chatgpt-selection-message-id', 'message-recycled');
        answer.querySelector('p').textContent = 'A different historical message now occupies this root.';
        return openFixture.frames('answer-recycled');
      });
      assertFoldedFrames(recycled, 'A different message inherited the old root\'s manual open');
      const original = await page.evaluate(async () => {
        document.getElementById('thread').prepend(openFixture.makeTurn('a'));
        return openFixture.frames('answer-a');
      });
      assertVisibleFrames(original, 'The original message lost its open intention when its DOM was recycled');
    });

    await test('positional unit keys stay conservative while actual nested message IDs restore', async page => {
      await openOnly(page, []);
      for (const kind of ['unit', 'content-unit', 'nested-carrier']) {
        await page.evaluate(kind => {
          document.getElementById('thread').prepend(openFixture.makeTurn(kind, kind));
        }, kind);
        await page.locator(`#answer-${kind} > [data-cgf-toggle]`).click();
        await retire(page, kind);
        const samples = await page.evaluate(async kind => {
          const turn = openFixture.makeTurn(kind, kind);
          if (kind !== 'nested-carrier') turn.querySelector('p').textContent =
            'A different historical answer now uses the same fallback-turn-0:0:assistant position.';
          document.getElementById('thread').prepend(turn);
          return openFixture.frames(`answer-${kind}`);
        }, kind);
        if (kind === 'nested-carrier') assertVisibleFrames(samples, 'An actual nested message identity lost its manual open');
        else assertFoldedFrames(samples, `The ${kind} positional key transferred an open to another historical answer`);
      }
      assert.equal(await page.locator('[data-cgf-message][data-cgf-collapsed="false"]').count(), 1);

      // An actual ID may arrive later on the same DOM root. Preserve that
      // choice when the live positional hint still refers to the same unit.
      await page.evaluate(() => {
        document.getElementById('thread').prepend(openFixture.makeTurn('late-id', 'unit'));
      });
      await page.locator('#answer-late-id > [data-cgf-toggle]').click();
      const enriched = await page.evaluate(async () => {
        const answer = document.getElementById('answer-late-id');
        answer.setAttribute('data-chatgpt-search-message-ids', 'message-late-id');
        answer.setAttribute('data-chatgpt-selection-message-id', 'message-late-id');
        return openFixture.frames('answer-late-id');
      });
      assertVisibleFrames(enriched, 'Late identity enrichment discarded an existing manual open on the same live unit');
      await retire(page, 'late-id');
      const identified = await page.evaluate(async () => {
        document.getElementById('thread').prepend(openFixture.makeTurn('late-id'));
        return openFixture.frames('answer-late-id');
      });
      assertVisibleFrames(identified, 'An enriched actual message identity was not remembered after remount');

      // A different live unit plus a new actual ID is a recycled unknown root,
      // not enrichment of its previous message. Do not transfer its open state.
      await page.evaluate(() => {
        document.getElementById('thread').prepend(openFixture.makeTurn('unknown-reused', 'unit'));
      });
      await page.locator('#answer-unknown-reused > [data-cgf-toggle]').click();
      const changed = await page.evaluate(async () => {
        const answer = document.getElementById('answer-unknown-reused');
        answer.setAttribute('data-chatgpt-search-unit-key', 'fallback-turn-8:0:assistant');
        answer.setAttribute('data-chatgpt-search-message-ids', 'message-different-history');
        answer.setAttribute('data-chatgpt-selection-message-id', 'message-different-history');
        answer.querySelector('p').textContent = 'A different identified historical answer replaced the unidentified one.';
        return openFixture.frames('answer-unknown-reused');
      });
      assertFoldedFrames(changed, 'A recycled unidentified root transferred its open to a different live unit');
    });

    await test('collapse-all and explicit recent reset remembered off-DOM intentions', async page => {
      await openOnly(page, ['a', 'b']);
      await retire(page, 'a');
      await page.evaluate(() => __CGF_OPEN_TEST__.send({ type: 'CGF_COMMAND', command: 'collapse-all' }));
      const cleared = await page.evaluate(async () => {
        document.getElementById('thread').prepend(openFixture.makeTurn('a'));
        return Promise.all(['a', 'b'].map(key => openFixture.frames(`answer-${key}`)));
      });
      for (const sample of cleared) assertFoldedFrames(sample, 'Collapse-all left a remembered open behind');

      for (const key of ['a', 'b']) await page.locator(`#answer-${key} > [data-cgf-toggle]`).click();
      await retire(page, 'a');
      await page.evaluate(() => __CGF_OPEN_TEST__.send({ type: 'CGF_COMMAND', command: 'recent' }));
      const reset = await page.evaluate(async () => {
        document.getElementById('thread').prepend(openFixture.makeTurn('a'));
        const [old, other, latest] = await Promise.all([
          openFixture.frames('answer-a'), openFixture.frames('answer-b'), openFixture.frames('answer-latest')
        ]);
        return { old, other, latest };
      });
      assertFoldedFrames(reset.old, 'Explicit recent retained an off-DOM manual open');
      assertFoldedFrames(reset.other, 'Explicit recent did not reset the mounted selection');
      assertVisibleFrames(reset.latest, 'Explicit recent did not open the configured latest answer');
    });

    await test('conversation changes do not restore another conversation\'s open identities', async page => {
      await openOnly(page, ['a', 'b']);
      await retire(page, 'a');
      const moved = await page.evaluate(async () => {
        history.pushState(null, '', '/c/other-open-state-test');
        document.getElementById('thread').replaceChildren(
          openFixture.makeTurn('a'), openFixture.makeTurn('b'), openFixture.makeTurn('other-latest'));
        const [old, other, latest] = await Promise.all([
          openFixture.frames('answer-a'), openFixture.frames('answer-b'), openFixture.frames('answer-other-latest')
        ]);
        return { old, other, latest };
      });
      assertFoldedFrames(moved.old, 'An off-DOM intention crossed the conversation boundary');
      assertFoldedFrames(moved.other, 'A mounted intention crossed the conversation boundary');
      assertVisibleFrames(moved.latest, 'New-conversation defaults did not apply');
    });

    await test('lowering the cap evicts oldest intentions and raising it does not resurrect them', async page => {
      await openOnly(page, ['a', 'b']);
      await page.locator('#answer-latest > [data-cgf-toggle]').click();
      await retire(page, 'a');
      const limited = await page.evaluate(async () => {
        await __CGF_OPEN_TEST__.setSettings({ enabled: true, keepRecent: 1, maxExpanded: 2 });
        return Promise.all(['b', 'latest'].map(key => openFixture.frames(`answer-${key}`)));
      });
      for (const sample of limited) assertVisibleFrames(sample, 'Changing only the cap reset newer opens unnecessarily');
      const raised = await page.evaluate(async () => {
        await __CGF_OPEN_TEST__.setSettings({ enabled: true, keepRecent: 1, maxExpanded: 4 });
        document.getElementById('thread').prepend(openFixture.makeTurn('a'));
        const [evicted, kept, latest] = await Promise.all([
          openFixture.frames('answer-a'), openFixture.frames('answer-b'), openFixture.frames('answer-latest')
        ]);
        return { evicted, kept, latest };
      });
      assertFoldedFrames(raised.evicted, 'Increasing the cap resurrected an already evicted intention');
      assertVisibleFrames(raised.kept, 'Increasing the cap discarded a retained open');
      assertVisibleFrames(raised.latest, 'Increasing the cap discarded the latest open');
    });

    await test('fresh roots without stable identity do not borrow a remembered open', async page => {
      await openOnly(page, ['b']);
      await page.evaluate(() => {
        document.getElementById('thread').prepend(openFixture.makeTurn('anonymous', 'anonymous'));
      });
      await page.locator('#answer-anonymous > [data-cgf-toggle]').click();
      await retire(page, 'anonymous');
      const samples = await page.evaluate(async () => {
        document.getElementById('thread').prepend(openFixture.makeTurn('anonymous', 'anonymous'));
        return openFixture.frames('answer-anonymous');
      });
      assertFoldedFrames(samples, 'A fresh identity-less root guessed an open state from its text or DOM ID');
      const kept = await page.evaluate(() => openFixture.frames('answer-b'));
      assertVisibleFrames(kept, 'Anonymous remount discarded another identified manual open');
    });

    await test('ambiguous duplicate message IDs do not restore one intention into multiple answers', async page => {
      await openOnly(page, ['a', 'b']);
      await retire(page, 'a');
      const duplicates = await page.evaluate(async () => {
        const fragment = document.createDocumentFragment();
        for (const key of ['duplicate-one', 'duplicate-two']) {
          const turn = openFixture.makeTurn(key);
          const answer = turn.querySelector('[data-chatgpt-search-unit-key]');
          answer.setAttribute('data-chatgpt-search-message-ids', 'message-a');
          answer.setAttribute('data-chatgpt-selection-message-id', 'message-a');
          fragment.append(turn);
        }
        document.getElementById('thread').prepend(fragment);
        return Promise.all(['duplicate-one', 'duplicate-two'].map(key => openFixture.frames(`answer-${key}`)));
      });
      for (const sample of duplicates) assertFoldedFrames(sample, 'An ambiguous identity copied one manual open into duplicate roots');
      const retained = await page.evaluate(() => openFixture.frames('answer-b'));
      assertVisibleFrames(retained, 'Ambiguous history displaced a different valid open');
    });

    await test('temporary streaming protection alone does not create or evict remembered opens', async page => {
      // keepRecent=0 starts all ordinary answers folded; only user actions add
      // intentions. Generation is a temporary exception to the ordinary cap.
      for (const key of ['a', 'b']) await page.locator(`#answer-${key} > [data-cgf-toggle]`).click();
      const during = await page.evaluate(async () => {
        const stop = document.createElement('button');
        stop.id = 'generation-stop';
        stop.type = 'button';
        stop.setAttribute('aria-label', 'Stop');
        document.getElementById('composer').append(stop);
        document.getElementById('thread').append(openFixture.makeTurn('c'));
        return Promise.all(['a', 'b', 'c'].map(key => openFixture.frames(`answer-${key}`)));
      });
      for (const sample of during) assertVisibleFrames(sample, 'Temporary generation protection displaced an existing manual open');
      const finished = await page.evaluate(async () => {
        document.getElementById('generation-stop').remove();
        // Scoped Stop removal already uses the bounded policy batch. Wait for
        // its disabled control to release, observing A/B on every frame; this
        // test concerns persistent intentions, not zero-latency stop detection.
        const kept = [];
        const deadline = performance.now() + 12000;
        await new Promise((resolve, reject) => {
          function sample() {
            kept.push(openFixture.snapshot('answer-a'), openFixture.snapshot('answer-b'));
            const control = document.querySelector('#answer-c > [data-cgf-toggle]');
            if (control && !control.disabled) return resolve();
            if (performance.now() > deadline) return reject(new Error('Generation protection did not release'));
            requestAnimationFrame(sample);
          }
          requestAnimationFrame(sample);
        });
        return { kept, generated: await openFixture.frames('answer-c') };
      });
      assertVisibleFrames(finished.kept, 'Generation completion discarded an existing manual open');
      assertFoldedFrames(finished.generated, 'Temporary protection became a persistent open despite keepRecent=0');
      await retire(page, 'c');
      const remounted = await page.evaluate(async () => {
        document.getElementById('thread').append(openFixture.makeTurn('c'));
        return openFixture.frames('answer-c');
      });
      assertFoldedFrames(remounted, 'A generation-only open was remembered after remount');
    }, { enabled: true, keepRecent: 0, maxExpanded: 2 });

    console.log(`${passed}/${passed + failed} open-state groups passed.`);
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
