#!/usr/bin/env node
"use strict";

/*
 * Browser integration tests against a synthetic page, never a user's chats.
 * Default: load the real unpacked extension into a fresh Chromium profile.
 * --mode=injected: explicitly test content scripts with a mocked Chrome API.
 * Neither mode proves that future/live ChatGPT markup is compatible.
 * Missing dependencies/browser produce exit code 2 (NOT RUN), never a pass.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures", "chat.html"), "utf8");
const TEST_URL = "https://chatgpt.com/c/fold-synthetic-test";
const SETTINGS_KEY = "cgf.settings.v1";
const DEFAULTS = { enabled: true, keepRecent: 1, maxExpanded: 1 };
const args = process.argv.slice(2);
const mode = args.find(arg => arg.startsWith("--mode="))?.slice(7) || "extension";
const headed = args.includes("--headed");

if (args.includes("--help")) {
  console.log(`ChatGPT Fold synthetic browser integration tests

  npm run test:browser                     Real MV3 extension, fresh profile
  npm run test:browser -- --headed          Show the test browser
  npm run test:browser -- --mode=injected  Explicit Chrome API mock fallback

Optional environment variables:
  CGF_PLAYWRIGHT_MODULE  Absolute path to playwright or playwright-core
  CODEX_PRIMARY_RUNTIME_NODE_MODULES  Runtime-provided module directory
  CHROME_PATH           Existing Chromium executable (prefer Playwright Chromium)
  CGF_TEST_SCREENSHOT   Optional absolute PNG path written only on failure

Developer setup, if Playwright/Chromium are not installed:
  npm install --no-save playwright
  npx playwright install chromium

The fixture URL is fully intercepted. No real ChatGPT page or chat is fetched.
Tests do not measure memory savings or establish live-site compatibility.`);
  process.exit(0);
}
if (!["extension", "injected"].includes(mode)) {
  console.error("Unknown mode. Use --mode=extension or --mode=injected.");
  process.exit(2);
}

function findPlaywright() {
  const choices = [process.env.CGF_PLAYWRIGHT_MODULE, "playwright", "playwright-core"];
  if (process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES) {
    choices.push(path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, "playwright"));
    choices.push(path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, "playwright-core"));
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

function findExecutable(chromium) {
  const choices = [
    process.env.CHROME_PATH,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    chromium.executablePath(),
    "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ];
  return choices.find(candidate => candidate && fs.existsSync(candidate));
}

function chromeMock({ key, defaults, version }) {
  // Isolated test storage persists over a fixture reload. This mock is never
  // shipped in the extension and never touches real chrome.storage.
  const localKey = "__cgf_synthetic_extension_settings__";
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  let values;
  try { values = JSON.parse(localStorage.getItem(localKey) || "null"); } catch { values = null; }
  values = values || { [key]: defaults };
  const storageListeners = new Set();
  const messageListeners = new Set();
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  function answer(value, callback) {
    if (callback) queueMicrotask(() => callback(clone(value)));
    return Promise.resolve(clone(value));
  }
  const local = {
    get(keys, callback) {
      let result;
      if (keys == null) result = values;
      else if (typeof keys === "string") result = { [keys]: values[keys] };
      else if (Array.isArray(keys)) result = Object.fromEntries(keys.map(item => [item, values[item]]));
      else result = Object.fromEntries(Object.entries(keys).map(([item, fallback]) =>
        [item, Object.hasOwn(values, item) ? values[item] : fallback]));
      return answer(result, callback);
    },
    set(items, callback) {
      const changes = {};
      for (const [item, value] of Object.entries(items)) {
        changes[item] = { oldValue: clone(values[item]), newValue: clone(value) };
        values[item] = clone(value);
      }
      localStorage.setItem(localKey, JSON.stringify(values));
      queueMicrotask(() => {
        for (const listener of storageListeners) listener(changes, "local");
      });
      return answer(undefined, callback);
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
  globalThis.__CGF_TEST__ = {
    setSettings: settings => local.set({ [key]: settings }),
    async send(message) {
      if (!messageListeners.size) throw new Error("Content script has no message listener");
      return new Promise((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => reject(new Error("No content response")), 3000);
        const respond = value => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(value);
        };
        for (const listener of messageListeners) {
          try {
            const result = listener(message, { id: extensionId }, respond);
            if (result && typeof result.then === "function") result.then(respond, reject);
            else if (result !== true && result !== undefined && result !== false) respond(result);
          } catch (error) {
            clearTimeout(timer);
            reject(error);
          }
        }
      });
    }
  };
}

async function extensionIdFromContext(cdp, contexts) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    for (const context of contexts.values()) {
      if (context.auxData?.isDefault) continue;
      try {
        const result = await cdp.send("Runtime.evaluate", {
          contextId: context.id,
          expression: 'typeof chrome === "object" && chrome.runtime && chrome.runtime.id',
          returnByValue: true
        });
        const id = result.result?.value;
        if (typeof id === "string" && /^[a-p]{32}$/.test(id)) return id;
      } catch { /* Context may have been destroyed during navigation. */ }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Unpacked extension did not start. Use Playwright Chromium; some branded Chrome builds reject --load-extension. No injection fallback was silently used.");
}

async function main() {
  const playwright = findPlaywright();
  if (!playwright) {
    console.error("NOT RUN: Playwright is not installed. See node tests/browser-smoke.cjs --help.");
    process.exitCode = 2;
    return;
  }
  const executablePath = findExecutable(playwright.chromium);
  if (!executablePath) {
    console.error("NOT RUN: Playwright is available, but no local Chromium executable was found. Install Chromium with npx playwright install chromium, or set CHROME_PATH. No browser assertions ran.");
    process.exitCode = 2;
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-fold-test-"));
  let context;
  let browser;
  let page;
  let passed = 0;
  const pageErrors = [];
  try {
    const launchOptions = {
      executablePath,
      headless: !headed,
      args: process.getuid?.() === 0 ? ["--no-sandbox"] : []
    };
    if (mode === "extension") {
      launchOptions.args.push(`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`);
      context = await playwright.chromium.launchPersistentContext(profile, launchOptions);
    } else {
      browser = await playwright.chromium.launch(launchOptions);
      context = await browser.newContext();
      await context.addInitScript(chromeMock, { key: SETTINGS_KEY, defaults: DEFAULTS, version: manifest.version });
    }
    await context.route("**/*", async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.protocol === "chrome-extension:") return route.continue();
      if (url.origin === "https://chatgpt.com" && request.resourceType() === "document") {
        return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: FIXTURE });
      }
      return route.abort();
    });
    page = context.pages()[0] || await context.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    page.on("pageerror", error => pageErrors.push(error.message));
    let driver;
    let tabId;
    let send;
    let setSettings;
    const inject = async () => {
      for (const entry of manifest.content_scripts) {
        for (const css of entry.css || []) await page.addStyleTag({ path: path.join(ROOT, css) });
        for (const js of entry.js || []) await page.addScriptTag({ path: path.join(ROOT, js) });
      }
    };
    const cdp = mode === "extension" ? await context.newCDPSession(page) : null;
    const contexts = new Map();
    if (cdp) {
      cdp.on("Runtime.executionContextCreated", event => contexts.set(event.context.id, event.context));
      cdp.on("Runtime.executionContextDestroyed", event => contexts.delete(event.executionContextId));
      cdp.on("Runtime.executionContextsCleared", () => contexts.clear());
      await cdp.send("Runtime.enable");
    }
    await page.goto(TEST_URL, { waitUntil: "domcontentloaded" });
    if (mode === "extension") {
      const extensionId = await extensionIdFromContext(cdp, contexts);
      driver = await context.newPage();
      await driver.goto(`chrome-extension://${extensionId}/${manifest.action.default_popup}`);
      tabId = await driver.evaluate(async () => {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          for (const tab of await chrome.tabs.query({})) {
            if (!tab.id) continue;
            try {
              const status = await chrome.tabs.sendMessage(tab.id, { type: "CGF_GET_STATUS" });
              if (status?.ok) return tab.id;
            } catch { /* A blank tab/popup or starting content script has no listener. */ }
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error("No fixture tab with a responding content script");
      });
      send = message => driver.evaluate(({ id, message }) => chrome.tabs.sendMessage(id, message), { id: tabId, message });
      setSettings = settings => driver.evaluate(({ key, settings }) => chrome.storage.local.set({ [key]: settings }), { key: SETTINGS_KEY, settings });
    } else {
      await inject();
      send = message => page.evaluate(message => window.__CGF_TEST__.send(message), message);
      setSettings = settings => page.evaluate(settings => window.__CGF_TEST__.setSettings(settings), settings);
    }
    const command = value => send({ type: "CGF_COMMAND", command: value });
    const status = () => send({ type: "CGF_GET_STATUS" });
    async function waitStatus(predicate, reason, timeout = 12000) {
      const deadline = Date.now() + timeout;
      let current;
      while (Date.now() < deadline) {
        current = await status();
        if (predicate(current)) return current;
        await new Promise(resolve => setTimeout(resolve, 80));
      }
      assert.fail(`${reason}; last status: ${JSON.stringify(current)}`);
    }
    async function isCollapsed(id) {
      return page.locator(`#${id}`).evaluate(element => getComputedStyle(element.querySelector(".markdown")).display === "none");
    }
    async function waitCollapsed(id, expected) {
      await page.waitForFunction(({ id, expected }) => {
        const markdown = document.getElementById(id)?.querySelector(".markdown");
        return markdown && (getComputedStyle(markdown).display === "none") === expected;
      }, { id, expected }, { timeout: 12000 });
    }
    async function waitDomCounts(total, collapsed) {
      // Observation only: unlike a runtime status request, this cannot flush
      // the controller and accidentally repair an unobserved DOM mutation.
      await page.waitForFunction(({ total, collapsed }) => {
        const messages = [...document.querySelectorAll("[data-cgf-message]")];
        return messages.length === total && messages.filter(element =>
          element.getAttribute("data-cgf-collapsed") === "true").length === collapsed;
      }, { total, collapsed }, { timeout: 12000 });
    }
    async function waitRegistered(total) {
      await page.waitForFunction(total => document.querySelectorAll("[data-cgf-message]").length === total,
        total, { timeout: 12000 });
    }
    async function waitParagraph(id, visible) {
      await page.waitForFunction(({ id, visible }) => {
        const element = document.getElementById(id);
        return element && (element.getClientRects().length > 0) === visible;
      }, { id, visible }, { timeout: 12000 });
    }
    async function releaseInteraction() {
      await page.evaluate(() => {
        document.activeElement?.blur();
        document.getSelection()?.removeAllRanges();
      });
    }
    async function assertIdentity() {
      assert.equal(await page.evaluate(() => window.fixture.identitiesIntact()), true, "Original native nodes were moved or recreated");
    }
    async function withTemporaryCase(id, markup, action) {
      const originalCount = await page.locator("[data-cgf-message]").count();
      try {
        await setSettings({ ...DEFAULTS, keepRecent: 0 });
        await waitDomCounts(originalCount, originalCount);
        await page.evaluate(({ id, markup }) => {
          const section = document.createElement("section");
          section.id = id;
          // Static synthetic markup supplied by these tests, never user HTML.
          section.innerHTML = markup;
          document.getElementById("thread").append(section);
        }, { id, markup });
        await action(originalCount);
      } finally {
        await page.evaluate(id => document.getElementById(id)?.remove(), id);
        await setSettings(DEFAULTS);
        await waitDomCounts(originalCount, Math.max(0, originalCount - 1));
      }
    }
    async function test(name, action) {
      await action();
      passed += 1;
      console.log(`PASS ${String(passed).padStart(2, "0")} ${name}`);
    }
    console.log(`MODE: ${mode === "extension" ? "real unpacked MV3 extension" : "INJECTED content scripts + mocked Chrome APIs"}; synthetic DOM only`);

    await test("default: only the latest answer is expanded; controls remain visible", async () => {
      await waitStatus(value => value.total === 5 && value.expanded === 1 && value.collapsed === 4, "Default folding did not settle");
      for (let i = 1; i <= 4; i += 1) {
        assert.equal(await isCollapsed(`answer-${i}`), true);
        assert.equal(await page.locator(`#answer-${i} [data-cgf-control]`).isVisible(), true);
      }
      assert.equal(await isCollapsed("answer-5"), false);
      assert.equal(await page.locator('[data-message-author-role="user"] [data-cgf-control]').count(), 0);
      await assertIdentity();
    });

    await test("opening an old answer enforces the ordinary expansion cap", async () => {
      await page.locator("#answer-1 [data-cgf-toggle]").click();
      await waitCollapsed("answer-1", false);
      await waitCollapsed("answer-5", true);
      await waitStatus(value => value.expanded === 1, "Expansion cap was exceeded");
      await page.locator("#answer-1 [data-fixture-native]").click();
      assert.equal(await page.evaluate(() => window.fixture.clicks("answer-1")), 1, "Native click handler was lost");
      await releaseInteraction();
      await assertIdentity();
    });

    await test("collapse/expand preserves original node identity and native handlers", async () => {
      await page.locator("#answer-1 [data-cgf-toggle]").click();
      await waitCollapsed("answer-1", true);
      await page.locator("#answer-1 [data-cgf-toggle]").click();
      await waitCollapsed("answer-1", false);
      await page.locator("#answer-1 [data-fixture-native]").click();
      assert.equal(await page.evaluate(() => window.fixture.clicks("answer-1")), 2);
      await releaseInteraction();
      await assertIdentity();
    });

    await test("restore pauses folding and resume reapplies the current defaults", async () => {
      await command("restore");
      await waitStatus(value => value.paused && value.collapsed === 0, "Restore did not pause folding");
      for (let i = 1; i <= 5; i += 1) assert.equal(await isCollapsed(`answer-${i}`), false);
      await assertIdentity();
      await command("resume");
      await waitStatus(value => !value.paused && value.expanded === 1 && value.collapsed === 4, "Resume did not fold old answers");
    });

    await test("disabling restores native content; enabling attaches one control per answer", async () => {
      await setSettings({ ...DEFAULTS, enabled: false });
      await waitStatus(value => !value.enabled && value.collapsed === 0, "Disable did not restore native content");
      for (let i = 1; i <= 5; i += 1) assert.equal(await isCollapsed(`answer-${i}`), false);
      await assertIdentity();
      await setSettings(DEFAULTS);
      await waitStatus(value => value.enabled && value.total === 5 && value.collapsed === 4, "Enable did not restore folding");
      assert.equal(await page.locator("[data-cgf-control]").count(), 5);
    });

    await test("streaming answer remains visible even under collapse-all", async () => {
      await page.evaluate(() => {
        window.fixture.startStreaming();
        window.fixture.addAnswer({ id: "answer-6", summary: "生成中的首行：正在输出。" });
      });
      await waitStatus(value => value.total === 6 && value.protected >= 1, "Streaming answer was not recognized");
      await command("collapse-all");
      await waitCollapsed("answer-6", false);
      for (let i = 0; i < 3; i += 1) {
        await page.evaluate(() => window.fixture.appendText("answer-6", " 新片段。"));
        assert.equal(await isCollapsed("answer-6"), false);
      }
      await page.evaluate(() => window.fixture.finishStreaming());
      await waitStatus(value => value.protected === 0 && value.collapsed === 6, "Finished streaming did not release collapse protection");
      await command("recent");
      await waitStatus(value => value.expanded === 1 && value.collapsed === 5, "Recent command did not reopen newest answer");
    });

    await test("asynchronously inserted answer is recognized and older content folds", async () => {
      await page.evaluate(() => window.fixture.addAnswer({ id: "answer-7", summary: "异步新增首行：新的回答。" }));
      await waitStatus(value => value.total === 7 && value.expanded === 1 && value.collapsed === 6, "New answer did not settle");
      await waitCollapsed("answer-7", false);
      await waitCollapsed("answer-6", true);
      await assertIdentity();
    });

    await test("replaced content subtree gets exactly one updated control and clean preview", async () => {
      await page.evaluate(() => window.fixture.replaceBody("answer-7", "替换后的首行：预览只来自正文。"));
      await page.waitForSelector("#answer-7 [data-cgf-toggle]");
      await page.waitForFunction(() => document.querySelector("#answer-7 .cgf-label")?.textContent.includes("替换后的首行"));
      assert.equal(await page.locator("#answer-7 [data-cgf-control]").count(), 1);
      const preview = await page.locator("#answer-7 .cgf-label").textContent();
      assert.equal(preview.includes("原生测试按钮"), false, "Preview included a native button label");
      assert.equal(preview.includes("收起") || preview.includes("展开"), false, "Preview included extension controls");
      await page.locator("#answer-7 [data-fixture-native]").click();
      assert.equal(await page.evaluate(() => window.fixture.clicks("answer-7")), 1);
      await releaseInteraction();
      await assertIdentity();
    });

    await test("settings changes apply without a reload and cap additional openings", async () => {
      await setSettings({ enabled: true, keepRecent: 2, maxExpanded: 3 });
      await waitStatus(value => value.protected === 0 && value.expanded === 2, "keepRecent setting was not applied");
      await page.locator("#answer-1 [data-cgf-toggle]").click();
      await waitStatus(value => value.expanded === 3, "maxExpanded=3 did not allow the third answer");
      await page.locator("#answer-2 [data-cgf-toggle]").click();
      await waitCollapsed("answer-2", false);
      assert.equal((await status()).expanded, 3);
      await setSettings(DEFAULTS);
      await waitStatus(value => value.expanded === 1, "Default cap was not restored");
    });

    await test("canonical user roles override fallback articles and release an existing assistant", async () => {
      const originalCount = await page.locator("[data-cgf-message]").count();
      try {
        await setSettings({ ...DEFAULTS, keepRecent: 0 });
        await waitDomCounts(originalCount, originalCount);
        await page.evaluate(() => {
          const temporary = document.createElement("section");
          temporary.id = "risk-role-cases";
          for (const [id, role] of [["risk-role-changing", "assistant"], ["risk-role-user", "user"]]) {
            const article = document.createElement("article");
            article.dataset.turn = "assistant";
            const message = document.createElement("div");
            message.id = id;
            message.dataset.messageAuthorRole = role;
            const markdown = document.createElement("div");
            markdown.className = "markdown";
            markdown.textContent = "角色优先级测试正文。";
            message.append(markdown);
            article.append(message);
            temporary.append(article);
          }
          document.getElementById("thread").append(temporary);
        });
        await waitDomCounts(originalCount + 1, originalCount + 1);
        await waitCollapsed("risk-role-changing", true);
        assert.equal(await page.locator("#risk-role-user [data-cgf-control]").count(), 0);
        assert.equal(await isCollapsed("risk-role-user"), false, "Fallback article hid a canonical user message");
        await page.evaluate(() => {
          document.getElementById("risk-role-changing").dataset.messageAuthorRole = "user";
        });
        await page.waitForFunction(() => {
          const temporary = document.getElementById("risk-role-cases");
          return temporary && !temporary.querySelector("[data-cgf-message], [data-cgf-collapsed], [data-cgf-control]");
        }, undefined, { timeout: 12000 });
        await waitDomCounts(originalCount, originalCount);
        assert.equal(await isCollapsed("risk-role-changing"), false, "Changing assistant to user did not restore its body");
        assert.equal(await isCollapsed("risk-role-user"), false);
      } finally {
        await page.evaluate(() => document.getElementById("risk-role-cases")?.remove());
        await setSettings(DEFAULTS);
        await waitDomCounts(originalCount, originalCount - 1);
      }
    });

    await test("streaming class and stop-label changes work through observation alone", async () => {
      const originalCount = await page.locator("[data-cgf-message]").count();
      try {
        await setSettings({ ...DEFAULTS, keepRecent: 0 });
        await waitDomCounts(originalCount, originalCount);
        await page.evaluate(() => {
          const temporary = document.createElement("section");
          temporary.id = "risk-streaming-case";
          const article = document.createElement("article");
          article.dataset.turn = "assistant";
          const message = document.createElement("div");
          message.id = "risk-streaming-answer";
          message.dataset.messageAuthorRole = "assistant";
          const markdown = document.createElement("div");
          markdown.className = "markdown";
          markdown.textContent = "只改变流式标记，不改变正文或查询控制器。";
          message.append(markdown);
          article.append(message);
          temporary.append(article);
          const stop = document.createElement("button");
          stop.type = "button";
          stop.id = "risk-stop-label";
          stop.setAttribute("aria-label", "Ready");
          stop.textContent = "合成生成控制";
          temporary.append(stop);
          document.getElementById("thread").append(temporary);
        });
        await waitDomCounts(originalCount + 1, originalCount + 1);
        await waitCollapsed("risk-streaming-answer", true);
        // No status()/waitStatus()/commands during either attribute cycle.
        await page.evaluate(() => document.querySelector("#risk-streaming-answer .markdown").classList.add("result-streaming"));
        await waitCollapsed("risk-streaming-answer", false);
        // Leave the marker in place beyond any ordinary mutation batch;
        // removing it must be observed without a status request.
        await page.waitForTimeout(1800);
        assert.equal(await isCollapsed("risk-streaming-answer"), false);
        assert.equal(await page.locator("#risk-streaming-answer [data-cgf-toggle]").isDisabled(), true);
        await page.evaluate(() => document.querySelector("#risk-streaming-answer .markdown").classList.remove("result-streaming"));
        await waitCollapsed("risk-streaming-answer", true);
        await waitDomCounts(originalCount + 1, originalCount + 1);
        await page.evaluate(() => document.getElementById("risk-stop-label").setAttribute("aria-label", "Stop generating"));
        await page.waitForTimeout(200);
        assert.equal(await isCollapsed("risk-streaming-answer"), true, "Stop before the next answer reopened completed history");
        assert.equal(await page.locator("#risk-streaming-answer [data-cgf-toggle]").isDisabled(), false);
        await page.evaluate(() => {
          const article = document.createElement("article");
          article.dataset.turn = "assistant";
          const message = document.createElement("div");
          message.id = "risk-streaming-new-answer";
          message.dataset.messageAuthorRole = "assistant";
          message.dataset.messageId = "risk-streaming-new-message";
          const markdown = document.createElement("div");
          markdown.className = "markdown";
          markdown.textContent = "Stop belongs to this newly appended answer.";
          message.append(markdown);
          article.append(message);
          document.getElementById("risk-streaming-case").append(article);
        });
        await waitCollapsed("risk-streaming-new-answer", false);
        await waitDomCounts(originalCount + 2, originalCount + 1);
        assert.equal(await page.locator("#risk-streaming-new-answer [data-cgf-toggle]").isDisabled(), true);
        assert.equal(await page.locator("#risk-streaming-answer [data-cgf-toggle]").isDisabled(), false);
        await page.evaluate(() => document.getElementById("risk-stop-label").removeAttribute("aria-label"));
        await waitCollapsed("risk-streaming-new-answer", true);
        await waitDomCounts(originalCount + 2, originalCount + 2);
      } finally {
        await page.evaluate(() => document.getElementById("risk-streaming-case")?.remove());
        await setSettings(DEFAULTS);
        await waitDomCounts(originalCount, originalCount - 1);
      }
    });

    await test("a busy conversation container does not open history or duplicate nested fallback records", async () => {
      const originalCount = await page.locator("[data-cgf-message]").count();
      const previousBusy = await page.locator("main#thread").getAttribute("aria-busy");
      try {
        await setSettings({ ...DEFAULTS, keepRecent: 0 });
        await waitDomCounts(originalCount, originalCount);
        await page.evaluate(() => {
          const temporary = document.createElement("section");
          temporary.id = "risk-fallback-case";
          const outer = document.createElement("article");
          outer.id = "risk-fallback-outer";
          outer.dataset.turn = "assistant";
          const body = document.createElement("div");
          body.className = "markdown";
          const summary = document.createElement("p");
          summary.textContent = "外层 fallback 回答。";
          const inner = document.createElement("article");
          inner.id = "risk-fallback-inner";
          inner.dataset.turn = "assistant";
          const nestedBody = document.createElement("div");
          nestedBody.className = "markdown";
          nestedBody.textContent = "嵌套 fallback 不应重复注册。";
          inner.append(nestedBody);
          body.append(summary, inner);
          outer.append(body);
          temporary.append(outer);
          document.getElementById("thread").append(temporary);
        });
        await waitDomCounts(originalCount + 1, originalCount + 1);
        await waitCollapsed("risk-fallback-outer", true);
        assert.equal(await page.locator("#risk-fallback-case [data-cgf-control]").count(), 1);
        assert.equal(await page.locator("#risk-fallback-inner[data-cgf-message], #risk-fallback-inner [data-cgf-control]").count(), 0);
        await page.evaluate(() => document.getElementById("thread").setAttribute("aria-busy", "true"));
        // Give the debounced attribute observer time to run before asserting a
        // negative result; a status request must not drive this observation.
        await page.waitForTimeout(500);
        assert.equal(await page.locator('[data-cgf-message][data-cgf-collapsed="false"]').count(), 0, "A global busy marker reopened conversation history");
        assert.equal(await page.locator("[data-cgf-message]").count(), originalCount + 1);
        assert.equal(await page.evaluate(() => [...document.querySelectorAll("[data-cgf-message]")].every(element =>
          getComputedStyle(element.querySelector(".markdown")).display === "none")), true);
      } finally {
        await page.evaluate(previous => {
          document.getElementById("risk-fallback-case")?.remove();
          const thread = document.getElementById("thread");
          if (previous === null) thread.removeAttribute("aria-busy");
          else thread.setAttribute("aria-busy", previous);
        }, previousBusy);
        await setSettings(DEFAULTS);
        await waitDomCounts(originalCount, originalCount - 1);
      }
    });

    await test("non-article assistant turns work without guessing user or generic content", async () => {
      await withTemporaryCase("regression-turn-cases", `
        <div id="turn-valid" data-turn="assistant"><div class="markdown">明确的 div 回答。</div></div>
        <div id="turn-conflict" data-turn="assistant" data-message-author-role="user"><div class="markdown">冲突标记必须保持显示。</div></div>
        <div id="turn-descendant-user" data-turn="assistant"><div data-message-author-role="user"><div class="markdown">用户后代必须保持显示。</div></div></div>
        <section data-message-author-role="user"><div id="turn-in-user-role" data-turn="assistant"><div class="markdown">用户角色内部不能折叠。</div></div></section>
        <section data-turn="user"><div id="turn-in-user-turn" data-turn="assistant"><div class="markdown">用户轮次内部不能折叠。</div></div></section>
        <section id="turn-outer" data-turn="assistant"><div class="markdown"><p>外层明确回答。</p><div id="turn-inner" data-turn="assistant"><div class="markdown">嵌套标记不能重复注册。</div></div></div></section>
        <section id="turn-mixed-outer" data-turn="assistant"><div id="turn-mixed-assistant" data-turn="assistant"><div class="markdown">混合外层中的有效回答。</div></div><div id="turn-mixed-user" data-turn="user"><div class="markdown">混合外层中的用户内容必须显示。</div></div></section>
        <article id="turn-generic"><div class="markdown">单靠 article 或 markdown 不应识别为回答。</div></article>
      `, async originalCount => {
        await waitDomCounts(originalCount + 3, originalCount + 3);
        assert.equal(await page.locator("#regression-turn-cases [data-cgf-control]").count(), 3);
        await waitCollapsed("turn-valid", true);
        await waitCollapsed("turn-outer", true);
        await waitCollapsed("turn-mixed-assistant", true);
        assert.equal(await page.locator("#turn-mixed-outer[data-cgf-message]").count(), 0);
        assert.equal(await page.locator("#turn-inner[data-cgf-message], #turn-inner [data-cgf-control]").count(), 0);
        for (const id of ["turn-conflict", "turn-descendant-user", "turn-in-user-role", "turn-in-user-turn", "turn-mixed-user", "turn-generic"]) {
          assert.equal(await page.locator(`#${id}[data-cgf-message], #${id} [data-cgf-control]`).count(), 0, `${id} was incorrectly registered`);
          assert.equal(await page.locator(`#${id} .markdown`).isVisible(), true, `${id} was hidden by an ancestor`);
        }
      });
    });

    await test("removing a role attribute discovers the surviving assistant ancestor automatically", async () => {
      await withTemporaryCase("regression-role-removal", `
        <article id="role-removal-outer" data-turn="assistant">
          <div id="role-removal-inner" data-message-author-role="assistant"><div class="markdown">移除角色标记后，外层仍有明确回答语义。</div></div>
        </article>
      `, async originalCount => {
        await waitDomCounts(originalCount + 1, originalCount + 1);
        assert.equal(await page.locator("#role-removal-inner[data-cgf-message]").count(), 1);
        await page.evaluate(() => document.getElementById("role-removal-inner").removeAttribute("data-message-author-role"));
        // Do not send status/rescan: either would mask a missed ancestor scan.
        await page.waitForFunction(() => {
          const outer = document.getElementById("role-removal-outer");
          const inner = document.getElementById("role-removal-inner");
          return outer?.hasAttribute("data-cgf-message") && !inner?.hasAttribute("data-cgf-message");
        }, undefined, { timeout: 12000 });
        await waitDomCounts(originalCount + 1, originalCount + 1);
        assert.equal(await page.locator("#regression-role-removal [data-cgf-control]").count(), 1);
        assert.equal(await page.locator("#role-removal-inner > .markdown").count(), 1, "Native answer body was moved");
        assert.equal(await page.locator("#role-removal-inner [data-cgf-control]").count(), 0, "Old registration left a stale control");
        assert.equal(await page.locator("#role-removal-inner").isVisible(), false, "The fallback did not fold its original child");
      });
    });

    await test("removal-only mutations rescan the surviving parent, not just newly added nodes", async () => {
      await withTemporaryCase("regression-child-removal", `
        <div id="child-removal-outer" data-turn="assistant">
          <div id="child-removal-old" data-message-author-role="assistant"><div class="markdown">即将被页面删除的角色容器。</div></div>
          <div class="markdown" id="child-removal-survivor">预先存在、没有新插入的原始正文。</div>
        </div>
      `, async originalCount => {
        await waitDomCounts(originalCount + 1, originalCount + 1);
        await page.evaluate(() => document.getElementById("child-removal-old").remove());
        // The only application mutation is a deletion; no status request can
        // help the controller discover the newly eligible outer container.
        await page.waitForFunction(() => document.getElementById("child-removal-outer")?.hasAttribute("data-cgf-message"), undefined, { timeout: 12000 });
        await waitDomCounts(originalCount + 1, originalCount + 1);
        assert.equal(await page.locator("#regression-child-removal [data-cgf-control]").count(), 1);
        assert.equal(await page.locator("#child-removal-outer > #child-removal-survivor").count(), 1);
        assert.equal(await page.locator("#child-removal-survivor").isVisible(), false);
      });
    });

    await test("rescan preserves deliberate pause and disabled preferences", async () => {
      const originalCount = await page.locator("[data-cgf-message]").count();
      try {
        await command("restore");
        const paused = await command("rescan");
        assert.equal(paused.ok, true);
        assert.equal(paused.paused, true, "Rescan unexpectedly resumed a paused page");
        assert.equal(paused.total, originalCount);
        assert.equal(paused.collapsed, 0);
        assert.equal(await page.locator("[data-cgf-control]").count(), 0);
        await setSettings({ ...DEFAULTS, enabled: false });
        const disabled = await command("rescan");
        assert.equal(disabled.ok, true);
        assert.equal(disabled.enabled, false, "Rescan unexpectedly enabled the extension");
        assert.equal(disabled.collapsed, 0);
        assert.equal(await page.locator("[data-cgf-control]").count(), 0);
      } finally {
        await setSettings(DEFAULTS);
        await command("resume");
        await waitDomCounts(originalCount, Math.max(0, originalCount - 1));
      }
    });

    await test("diagnostics expose only a fixed metadata/count schema, never page content or identifiers", async () => {
      const originalCount = await page.locator("[data-cgf-message]").count();
      const previousTitle = await page.title();
      const sentinels = [
        "PRIVATE_BODY_SENTINEL_73021", "PRIVATE_TITLE_SENTINEL_73021",
        "PRIVATE_ELEMENT_ID_SENTINEL_73021", "PRIVATE_MESSAGE_ID_SENTINEL_73021",
        "PRIVATE_ROLE_SENTINEL_73021", "PRIVATE_TURN_SENTINEL_73021",
        "PRIVATE_SEARCH_ID_SENTINEL_73021", "PRIVATE_SEARCH_KEY_SENTINEL_73021",
        "PRIVATE_SELECTION_ID_SENTINEL_73021", "PRIVATE_CONTENT_KEY_SENTINEL_73021",
        "PRIVATE_TURN_KEY_SENTINEL_73021", "PRIVATE_TURN_STATE_SENTINEL_73021"
      ];
      try {
        await page.evaluate(values => {
          const section = document.createElement("section");
          section.id = values[2];
          section.dataset.messageId = values[3];
          section.dataset.messageAuthorRole = values[4];
          section.dataset.turn = values[5];
          section.setAttribute("data-chatgpt-search-message-ids", values[6]);
          section.setAttribute("data-chatgpt-search-unit-key", values[7] + ":assistant");
          section.setAttribute("data-chatgpt-selection-message-id", values[8]);
          section.setAttribute("data-content-search-unit-key", values[9] + ":assistant");
          section.setAttribute("data-turn-key", values[10]);
          section.setAttribute("data-talvt-turn-state", values[11]);
          section.setAttribute("data-markdown-text-style", "assistant-message");
          section.textContent = values[0];
          section.setAttribute("aria-label", values[0]);
          document.title = values[1];
          document.getElementById("thread").append(section);
        }, sentinels);
        const response = await send({ type: "CGF_GET_DIAGNOSTICS" });
        assert.equal(response.ok, true);
        const report = response.diagnostics;
        assert.ok(report && typeof report === "object", "Missing diagnostics object");
        const countKeys = [
          "registeredAnswerCount", "connectedRegisteredCount", "rawAssistantRoleCount",
          "rawAssistantTurnCount", "nonArticleAssistantTurnCount", "eligibleAnswerCount",
          "nestedRejectedCount", "fallbackSuppressedCount", "conflictingRoleCount",
          "conversationTurnCount", "messageIdElementCount", "articleCount", "mainCount", "iframeCount"
        ];
        const flagKeys = ["topFrame", "hasBody", "enabled", "active", "paused", "observerConnected"];
        const allowedKeys = ["schemaVersion", "scriptVersion", "readyState", "roleCounts", "turnCounts", "modern", "maintenance", ...countKeys, ...flagKeys];
        assert.deepEqual(Object.keys(report).sort(), allowedKeys.sort(), "Diagnostics schema must remain explicitly allowlisted");
        assert.equal(report.schemaVersion, 3);
        assert.equal(report.scriptVersion, manifest.version);
        assert.ok(["interactive", "complete"].includes(report.readyState));
        for (const key of flagKeys) assert.equal(typeof report[key], "boolean", `${key} is not a boolean`);
        assert.equal(report.topFrame, true);
        assert.equal(report.hasBody, true);
        assert.equal(report.enabled, true);
        assert.equal(report.active, true);
        assert.equal(report.paused, false);
        assert.equal(report.observerConnected, true);
        for (const key of countKeys) assert.ok(Number.isSafeInteger(report[key]) && report[key] >= 0, `${key} is not a nonnegative integer`);
        assert.equal(report.registeredAnswerCount, originalCount);
        assert.equal(report.connectedRegisteredCount, originalCount);
        assert.equal(report.eligibleAnswerCount, originalCount);
        for (const key of ["roleCounts", "turnCounts"]) {
          assert.deepEqual(Object.keys(report[key]).sort(), ["assistant", "user", "system", "tool", "developer", "empty", "other"].sort());
          for (const value of Object.values(report[key])) assert.ok(Number.isSafeInteger(value) && value >= 0);
          assert.ok(report[key].other >= 1, "Unknown role/turn values should be counted only as 'other'");
        }
        assert.deepEqual(Object.keys(report.modern).sort(), [
          "messageRoleAssistantCount", "searchUnitAssistantCount", "contentUnitAssistantCount",
          "assistantBodyCount", "searchMessageContainerCount", "selectionMessageContainerCount",
          "userBubbleCount", "turnContainerCount", "inactiveCandidateCount"
        ].sort());
        for (const [key, value] of Object.entries(report.modern)) {
          assert.ok(Number.isSafeInteger(value) && value >= 0, `modern.${key} is not a count`);
        }
        const maintenanceCounts = ["disconnectedRegisteredCount", "openIntentCount", "pendingScanRootCount",
          "pendingDirtyRecordCount", "fullFlushCount", "incrementalFlushCount", "previewRefreshCount",
          "bodyReplacementCount", "releasedRecordCount"];
        const maintenanceFlags = ["bodyObserverConnected", "pageSuspended", "fullScanPending", "policyPending", "timerPending"];
        assert.deepEqual(Object.keys(report.maintenance).sort(), [...maintenanceCounts, ...maintenanceFlags].sort());
        for (const key of maintenanceCounts) assert.ok(Number.isSafeInteger(report.maintenance[key]) && report.maintenance[key] >= 0,
          `maintenance.${key} is not a count`);
        for (const key of maintenanceFlags) assert.equal(typeof report.maintenance[key], "boolean", `maintenance.${key} is not a boolean`);
        assert.equal(report.maintenance.disconnectedRegisteredCount, 0);
        assert.ok(report.maintenance.openIntentCount <= 5);
        assert.ok(report.maintenance.pendingScanRootCount <= 80);
        assert.ok(report.maintenance.pendingDirtyRecordCount <= 80);
        const serialized = JSON.stringify(response);
        for (const sentinel of [...sentinels, new URL(page.url()).pathname, page.url()]) {
          assert.equal(serialized.includes(sentinel), false, "Diagnostics leaked page text, metadata, or an identifier");
        }
      } finally {
        await page.evaluate(({ id, title }) => {
          document.getElementById(id)?.remove();
          document.title = title;
        }, { id: sentinels[2], title: previousTitle });
      }
    });

    await test("SPA route replacement resets message state and cleans retired controls", async () => {
      await page.evaluate(() => window.fixture.navigate("/c/fold-synthetic-second", 3));
      await waitStatus(value => value.total === 3 && !value.paused && value.expanded === 1 && value.collapsed === 2, "SPA route did not reset state");
      assert.equal(await page.locator("[data-cgf-control]").count(), 3);
      assert.equal(await page.evaluate(() => window.fixture.retiredConnected()), false);
      assert.equal(await page.evaluate(() => window.fixture.retiredControls()), 0, "Removed answers retained extension controls");
      await assertIdentity();
      await command("restore");
      await page.evaluate(() => window.fixture.navigate("/c/fold-synthetic-third", 3));
      await waitStatus(value => value.total === 3 && !value.paused && value.collapsed === 2, "SPA route retained the previous route pause state");
    });

    await test("rescan preserves same-conversation choices across body replacement and observes new answers", async () => {
      await page.locator("[data-cgf-toggle]").first().click();
      await page.evaluate(() => {
        const answers = [...document.querySelectorAll("[data-cgf-message]")];
        const selected = answers[0].getAttribute("data-message-id");
        const latest = answers[answers.length - 1].getAttribute("data-message-id");
        const nextBody = document.createElement("body");
        const thread = document.createElement("main");
        thread.id = "body-replacement-thread";
        for (const [id, messageId] of [["body-replacement-first", selected], ["body-replacement-latest", latest]]) {
          const answer = document.createElement("div");
          answer.id = id;
          answer.dataset.messageAuthorRole = "assistant";
          answer.dataset.messageId = messageId;
          const body = document.createElement("div");
          body.className = "markdown";
          body.textContent = "同一对话中的回答在整个 body 替换后重新挂载。";
          answer.append(body);
          thread.append(answer);
        }
        nextBody.append(thread);
        document.body.replaceWith(nextBody);
      });
      const recovered = await command("rescan");
      assert.equal(recovered.ok, true);
      assert.equal(recovered.total, 2);
      assert.equal(recovered.expanded, 1);
      await waitDomCounts(2, 1);
      await waitCollapsed("body-replacement-first", false);
      await waitCollapsed("body-replacement-latest", true);
      await page.evaluate(() => {
        const answer = document.createElement("div");
        answer.id = "body-replacement-second";
        answer.dataset.messageAuthorRole = "assistant";
        answer.dataset.messageId = "body-replacement-new-message";
        const body = document.createElement("div");
        body.className = "markdown";
        body.textContent = "必须通过重新绑定的 observer 发现这条新回答。";
        answer.append(body);
        document.getElementById("body-replacement-thread").append(answer);
      });
      // Observation only after the explicit recovery: a stale observer would
      // leave this second answer undiscovered until another status request.
      await waitDomCounts(3, 2);
      await waitCollapsed("body-replacement-first", true);
      await waitCollapsed("body-replacement-second", false);
    });

    await test("reload starts cleanly without duplicated controls or a stale pause state", async () => {
      await command("restore");
      await page.reload({ waitUntil: "domcontentloaded" });
      if (mode === "injected") await inject();
      await waitStatus(value => value.total === 5 && !value.paused && value.expanded === 1 && value.collapsed === 4, "Reload did not reset state");
      assert.equal(await page.locator("[data-cgf-control]").count(), 5);
      await assertIdentity();
    });

    await test("a modern-only transcript initializes and folds answers without changing questions or native nodes", async () => {
      let originalBody;
      try {
        await command("restore");
        await setSettings(DEFAULTS);
        await page.evaluate(() => {
          document.getElementById("thread").innerHTML = `
            <div id="modern-turn-1" data-turn-key="private-turn-1" data-talvt-turn-state="complete">
              <div id="modern-user-1" data-chatgpt-search-unit-key="fallback-turn-0:0:user" data-chatgpt-search-message-ids="private-question-1">
                <div data-user-message-bubble="true"><p id="modern-question-1">Modern question one remains visible.</p></div>
              </div>
              <div id="modern-a1" data-chatgpt-search-unit-key="fallback-turn-0:0:assistant" data-chatgpt-search-message-ids="private-answer-1">
                <div id="modern-a1-body" data-markdown-text-style="assistant-message"><p id="modern-text-1">Modern answer one.</p></div>
                <div><button type="button" id="modern-native" data-clicks="0">Native answer action</button></div>
              </div>
            </div>
            <div id="modern-turn-2" data-turn-key="private-turn-2" data-talvt-turn-state="complete">
              <div id="modern-user-2" data-content-search-unit-key="fallback-turn-1:0:user">
                <div data-user-message-bubble="true"><p id="modern-question-2">Modern question two remains visible.</p></div>
              </div>
              <div id="modern-a2" style="display: contents" data-content-search-unit-key="fallback-turn-1:0:assistant" data-chatgpt-search-message-ids="private-answer-2">
                <div data-markdown-text-style="assistant-message"><p id="modern-text-2">Modern answer two.</p></div>
              </div>
            </div>
          `;
          const button = document.getElementById("modern-native");
          button.addEventListener("click", () => { button.dataset.clicks = String(Number(button.dataset.clicks) + 1); });
        });
        assert.equal(await page.locator('article, .markdown, [data-message-author-role], [data-message-role], [data-turn]').count(), 0,
          "Modern-only initialization accidentally relied on legacy selectors");
        originalBody = await page.locator("#modern-a1-body").elementHandle();
        await command("resume");
        await waitDomCounts(2, 1);
        await waitParagraph("modern-text-1", false);
        await waitParagraph("modern-text-2", true);
        assert.equal(await page.locator("#modern-a1 > [data-cgf-control], #modern-a2 > [data-cgf-control]").count(), 2);
        assert.equal(await page.locator("#modern-turn-1[data-cgf-message], #modern-turn-2[data-cgf-message]").count(), 0,
          "A mixed question/answer turn was registered");
        for (const id of ["modern-user-1", "modern-user-2"]) {
          assert.equal(await page.locator("#" + id + " [data-cgf-control]").count(), 0);
        }
        await page.locator("#modern-a1 > [data-cgf-toggle]").click();
        await waitParagraph("modern-text-1", true);
        await waitParagraph("modern-text-2", false);
        await waitDomCounts(2, 1);
        await page.locator("#modern-native").click();
        assert.equal(await page.locator("#modern-native").getAttribute("data-clicks"), "1", "The original native action handler was lost");
        await releaseInteraction();
        assert.equal(await originalBody.evaluate(element => element === document.getElementById("modern-a1-body") &&
          element.parentElement === document.getElementById("modern-a1")), true, "Original modern body was moved or recreated");
        for (const id of ["modern-question-1", "modern-question-2"]) {
          assert.equal(await page.locator("#" + id).isVisible(), true, "Folding an answer hid a question");
        }
      } finally {
        await originalBody?.dispose();
        await command("restore");
        await page.evaluate(() => window.fixture.reset());
        await setSettings(DEFAULTS);
        await command("resume");
        await waitDomCounts(5, 4);
      }
    });

    await test("modern markdown fallbacks fold one message carrier while leaving its shared turn and prompt visible", async () => {
      await withTemporaryCase("modern-fallback-cases", `
        <div id="modern-shared-turn" data-turn-key="shared-turn-id" data-talvt-turn-state="complete">
          <div data-user-message-bubble="true"><p id="modern-fallback-question">User prompt must remain visible.</p></div>
          <div id="modern-carrier" data-chatgpt-search-message-ids="same-id same-id">
            <div data-markdown-text-style="assistant-message"><p id="modern-part-one">First part of one answer.</p></div>
            <div data-markdown-text-style="assistant-message"><p id="modern-part-two">Second part of the same answer.</p></div>
          </div>
          <div id="modern-selection-carrier" data-chatgpt-selection-message-id="selection-id">
            <div data-markdown-text-style="assistant-message"><p id="modern-selection-text">Selection-ID fallback.</p></div>
          </div>
          <div id="modern-body-fallback" data-markdown-text-style="assistant-message"><p id="modern-body-text">A body inside a known turn.</p></div>
          <div id="modern-unclassified" data-chatgpt-search-message-ids="unknown-id"><p id="modern-unclassified-text">IDs alone are not author roles.</p></div>
        </div>
        <div data-turn-key="nested-unit-group">
          <div id="modern-aggregate-body" data-markdown-text-style="assistant-message">
            <div id="modern-inner-unit-one" data-chatgpt-search-unit-key="inner-one:assistant"><div data-markdown-text-style="assistant-message"><p id="modern-inner-unit-text-one">First nested unit.</p></div></div>
            <div id="modern-inner-unit-two" data-content-search-unit-key="inner-two:assistant"><div data-markdown-text-style="assistant-message"><p id="modern-inner-unit-text-two">Second nested unit.</p></div></div>
          </div>
        </div>
        <div data-turn-key="nested-carrier-group">
          <div id="modern-aggregate-carrier-body" data-markdown-text-style="assistant-message">
            <div id="modern-inner-carrier-one" data-chatgpt-search-message-ids="inner-carrier-one"><div data-markdown-text-style="assistant-message"><p id="modern-inner-carrier-text-one">First nested carrier.</p></div></div>
            <div id="modern-inner-carrier-two" data-chatgpt-search-message-ids="inner-carrier-two"><div data-markdown-text-style="assistant-message"><p id="modern-inner-carrier-text-two">Second nested carrier.</p></div></div>
          </div>
        </div>
      `, async originalCount => {
        await waitDomCounts(originalCount + 7, originalCount + 7);
        for (const id of ["modern-carrier", "modern-selection-carrier", "modern-body-fallback", "modern-inner-unit-one", "modern-inner-unit-two", "modern-inner-carrier-one", "modern-inner-carrier-two"]) {
          assert.equal(await page.locator("#" + id + " > [data-cgf-control]").count(), 1);
        }
        assert.equal(await page.locator("#modern-carrier [data-cgf-control]").count(), 1, "Multiple body fragments created duplicate controls");
        for (const id of ["modern-part-one", "modern-part-two", "modern-selection-text", "modern-body-text", "modern-inner-unit-text-one", "modern-inner-unit-text-two", "modern-inner-carrier-text-one", "modern-inner-carrier-text-two"]) await waitParagraph(id, false);
        assert.equal(await page.locator("#modern-shared-turn[data-cgf-message], #modern-unclassified[data-cgf-message], #modern-aggregate-body[data-cgf-message], #modern-aggregate-carrier-body[data-cgf-message]").count(), 0);
        assert.equal(await page.locator("#modern-fallback-question").isVisible(), true);
        assert.equal(await page.locator("#modern-unclassified-text").isVisible(), true);
      });
    });

    await test("modern user bubbles and user unit keys override misleading assistant hints", async () => {
      await withTemporaryCase("modern-user-conflicts", `
        <div id="modern-valid-alias" data-message-role="assistant"><div data-markdown-text-style="assistant-message"><p id="modern-valid-alias-text">A valid explicit alias.</p></div></div>
        <div data-chatgpt-search-unit-key="turn:0:user"><div data-markdown-text-style="assistant-message"><p id="modern-user-key-text">User key wins.</p></div></div>
        <div data-content-search-unit-key="turn:1:user"><div data-message-author-role="assistant"><p id="modern-content-user-text">User content key wins.</p></div></div>
        <div data-user-message-bubble="true"><div data-chatgpt-search-unit-key="turn:2:assistant"><div data-markdown-text-style="assistant-message"><p id="modern-user-bubble-text">User bubble wins.</p></div></div></div>
        <div data-message-role="user" data-chatgpt-search-unit-key="turn:3:assistant"><div data-markdown-text-style="assistant-message"><p id="modern-user-alias-text">Explicit user alias wins.</p></div></div>
        <div data-chatgpt-search-unit-key="turn:4:assistant" data-content-search-unit-key="turn:4:user"><div data-markdown-text-style="assistant-message"><p id="modern-conflicting-keys-text">Conflicting keys remain visible.</p></div></div>
        <div data-chatgpt-search-unit-key="turn:5:assistant"><div data-user-message-bubble="true"><p id="modern-mixed-user-text">An assistant-labelled wrapper cannot hide a user descendant.</p></div></div>
      `, async originalCount => {
        await waitDomCounts(originalCount + 1, originalCount + 1);
        assert.equal(await page.locator("#modern-user-conflicts [data-cgf-control]").count(), 1);
        await waitParagraph("modern-valid-alias-text", false);
        for (const id of ["modern-user-key-text", "modern-content-user-text", "modern-user-bubble-text", "modern-user-alias-text", "modern-conflicting-keys-text", "modern-mixed-user-text"]) {
          assert.equal(await page.locator("#" + id).isVisible(), true, id + " was incorrectly hidden");
        }
      });
    });

    await test("modern role and body attributes update discovery without a status or rescan request", async () => {
      await withTemporaryCase("modern-changing-markers", `
        <div id="modern-changing-carrier" data-chatgpt-search-message-ids="one-modern-answer">
          <div id="modern-changing-inner" data-message-author-role="assistant">
            <div id="modern-changing-body" data-markdown-text-style="assistant-message"><p id="modern-changing-text">Preserved answer body.</p></div>
          </div>
        </div>
        <div data-turn-key="second-turn">
          <div id="modern-changing-body-only" data-markdown-text-style="user-message"><p id="modern-changing-body-text">Late assistant body marker.</p></div>
        </div>
      `, async originalCount => {
        await waitDomCounts(originalCount + 1, originalCount + 1);
        assert.equal(await page.locator("#modern-changing-inner[data-cgf-message]").count(), 1);
        const body = await page.locator("#modern-changing-body").elementHandle();
        try {
          await page.evaluate(() => document.getElementById("modern-changing-inner").removeAttribute("data-message-author-role"));
          await page.waitForFunction(() => document.getElementById("modern-changing-carrier")?.hasAttribute("data-cgf-message") &&
            !document.getElementById("modern-changing-inner")?.hasAttribute("data-cgf-message"));
          await waitDomCounts(originalCount + 1, originalCount + 1);
          assert.equal(await body.evaluate(element => element === document.getElementById("modern-changing-body") &&
            element.parentElement === document.getElementById("modern-changing-inner")), true);
          assert.equal(await page.locator("#modern-changing-carrier [data-cgf-control]").count(), 1);
          await page.evaluate(() => document.getElementById("modern-changing-carrier").setAttribute("data-chatgpt-search-unit-key", "same-turn:user"));
          await waitRegistered(originalCount);
          await waitParagraph("modern-changing-text", true);
          await page.evaluate(() => document.getElementById("modern-changing-carrier").setAttribute("data-chatgpt-search-unit-key", "same-turn:assistant"));
          await waitDomCounts(originalCount + 1, originalCount + 1);
          await page.evaluate(() => {
            const carrier = document.getElementById("modern-changing-carrier");
            carrier.removeAttribute("data-chatgpt-search-unit-key");
            carrier.setAttribute("data-content-search-unit-key", "same-turn:user");
          });
          await waitRegistered(originalCount);
          await waitParagraph("modern-changing-text", true);
          await page.evaluate(() => document.getElementById("modern-changing-carrier").setAttribute("data-content-search-unit-key", "same-turn:assistant"));
          await waitDomCounts(originalCount + 1, originalCount + 1);
          await page.evaluate(() => document.getElementById("modern-changing-body-only").setAttribute("data-markdown-text-style", "assistant-message"));
          await waitDomCounts(originalCount + 2, originalCount + 2);
          await waitParagraph("modern-changing-body-text", false);
          await page.evaluate(() => document.getElementById("modern-changing-body-only").setAttribute("data-markdown-text-style", "user-message"));
          await waitRegistered(originalCount + 1);
          await waitParagraph("modern-changing-body-text", true);
        } finally {
          await body.dispose();
        }
      });
    });

    await test("inactive modern timelines are released and re-discovered while display-contents and offscreen answers stay eligible", async () => {
      await withTemporaryCase("modern-visibility-cases", `
        <style>.modern-cached { display: none; }</style>
        <div id="modern-cache" class="modern-cached" data-app-action-timeline-scroll role="region">
          <div id="modern-cached-answer" data-chatgpt-search-unit-key="cache:assistant"><div data-markdown-text-style="assistant-message"><p>Cached answer.</p></div></div>
        </div>
        <div id="modern-contents-answer" style="display:contents" data-chatgpt-search-unit-key="contents:assistant"><div data-markdown-text-style="assistant-message"><p>Display contents is visible content.</p></div></div>
        <div style="position:absolute;top:20000px;left:0;width:400px"><div id="modern-offscreen-answer" data-chatgpt-search-unit-key="offscreen:assistant"><div data-markdown-text-style="assistant-message"><p>Offscreen does not mean inactive.</p></div></div></div>
        <div role="presentation" inert><div id="modern-presentation-answer" data-chatgpt-search-unit-key="ordinary-presentation:assistant"><div data-markdown-text-style="assistant-message"><p>Ordinary presentation wrapper stays eligible.</p></div></div></div>
        <div hidden><form data-chatgpt-composer><button type="button" aria-label="Stop">Hidden cached composer</button></form></div>
      `, async originalCount => {
        await waitDomCounts(originalCount + 3, originalCount + 3);
        assert.equal(await page.locator("#modern-cache [data-cgf-control]").count(), 0);
        for (const id of ["modern-contents-answer", "modern-offscreen-answer", "modern-presentation-answer"]) {
          assert.equal(await page.locator("#" + id + "[data-cgf-message]").count(), 1);
        }
        await page.evaluate(() => document.getElementById("modern-cache").classList.remove("modern-cached"));
        await waitRegistered(originalCount + 4);
        for (const [attribute, inactiveValue, activeValue] of [
          ["style", "display:none", "display:contents"],
          ["hidden", "", null],
          ["aria-hidden", "true", "false"],
          ["role", "presentation", "region"],
          ["style", "visibility:hidden", "visibility:visible"]
        ]) {
          await page.evaluate(({ attribute, value }) => document.getElementById("modern-cache").setAttribute(attribute, value),
            { attribute, value: inactiveValue });
          await waitRegistered(originalCount + 3);
          assert.equal(await page.locator("#modern-cache [data-cgf-control]").count(), 0, "Inactive subtree retained controls for " + attribute);
          await page.evaluate(({ attribute, value }) => {
            const element = document.getElementById("modern-cache");
            if (value === null) element.removeAttribute(attribute);
            else element.setAttribute(attribute, value);
          }, { attribute, value: activeValue });
          await waitRegistered(originalCount + 4);
        }
        // The timeline's qualifying attribute is itself mutable; changing only
        // that attribute must also refresh eligibility.
        await page.evaluate(() => document.getElementById("modern-cache").setAttribute("role", "presentation"));
        await waitRegistered(originalCount + 3);
        await page.evaluate(() => document.getElementById("modern-cache").removeAttribute("data-app-action-timeline-scroll"));
        await waitRegistered(originalCount + 4);
        await page.evaluate(() => document.getElementById("modern-cache").setAttribute("data-app-action-timeline-scroll", ""));
        await waitRegistered(originalCount + 3);
        await page.evaluate(() => document.getElementById("modern-cache").setAttribute("role", "region"));
        await waitDomCounts(originalCount + 4, originalCount + 4);
        const mutations = await page.evaluate(() => new Promise(resolve => {
          let count = 0;
          const observer = new MutationObserver(records => { count += records.length; });
          observer.observe(document.getElementById("modern-visibility-cases"), { attributes: true, childList: true, characterData: true, subtree: true });
          setTimeout(() => { observer.disconnect(); resolve(count); }, 450);
        }));
        assert.equal(mutations, 0, "Modern visibility checks repeatedly removed/recreated idle controls");
      });
    });

    await test("scoped modern Stop protects only a confirmed new answer and hidden or ended sessions release it", async () => {
      await withTemporaryCase("modern-streaming-case", `
        <div data-turn-key="modern-streaming-turn" data-talvt-turn-state="complete">
          <div data-user-message-bubble="true"><p id="modern-streaming-question">Question remains visible.</p></div>
          <div id="modern-streaming-answer" data-chatgpt-search-unit-key="modern-streaming:assistant">
            <div data-markdown-text-style="assistant-message"><p id="modern-streaming-text">Modern answer awaiting generation state.</p></div>
          </div>
        </div>
        <button type="button" aria-label="Stop">Unrelated rich-content Stop action</button>
        <form id="modern-composer" data-chatgpt-composer><button type="button" id="modern-stop" aria-label="Ready">Synthetic composer control</button></form>
      `, async originalCount => {
        const appendStreamingAnswer = async index => {
          await page.evaluate(value => {
            const answer = document.createElement("div");
            answer.id = `modern-streaming-new-${value}`;
            answer.setAttribute("data-chatgpt-search-unit-key", `modern-streaming-new-${value}:assistant`);
            answer.setAttribute("data-chatgpt-search-message-ids", `modern-streaming-message-${value}`);
            const body = document.createElement("div");
            body.setAttribute("data-markdown-text-style", "assistant-message");
            const paragraph = document.createElement("p");
            paragraph.id = `modern-streaming-new-${value}-text`;
            paragraph.textContent = "A new answer in this observed Stop session.";
            body.append(paragraph);
            answer.append(body);
            document.getElementById("modern-composer").before(answer);
          }, index);
          await waitParagraph(`modern-streaming-new-${index}-text`, true);
          assert.equal(await page.locator(`#modern-streaming-new-${index} > [data-cgf-toggle]`).isDisabled(), true);
          assert.equal(await page.locator("#modern-streaming-answer > [data-cgf-toggle]").isDisabled(), false);
        };
        await waitDomCounts(originalCount + 1, originalCount + 1);
        await waitParagraph("modern-streaming-text", false);
        await page.evaluate(() => document.getElementById("modern-stop").setAttribute("aria-label", "Stop"));
        await page.waitForTimeout(200);
        assert.equal(await page.locator("#modern-streaming-text").isVisible(), false);
        assert.equal(await page.locator("#modern-streaming-answer > [data-cgf-toggle]").isDisabled(), false);
        await appendStreamingAnswer(1);
        await page.waitForTimeout(1600);
        assert.equal(await page.locator("#modern-streaming-new-1 > [data-cgf-toggle]").isDisabled(), true);
        assert.equal(await page.locator("#modern-streaming-new-1-text").isVisible(), true, "Generation protection expired during the same Stop session");
        await page.evaluate(() => { document.getElementById("modern-composer").hidden = true; });
        await waitParagraph("modern-streaming-new-1-text", false);
        await page.evaluate(() => { document.getElementById("modern-composer").hidden = false; });
        await page.waitForTimeout(200);
        assert.equal(await page.locator("#modern-streaming-new-1-text").isVisible(), false, "Reappearing Stop reused a previous session's target");
        await appendStreamingAnswer(2);
        await page.evaluate(() => document.getElementById("modern-composer").removeAttribute("data-chatgpt-composer"));
        await waitParagraph("modern-streaming-new-2-text", false);
        await page.evaluate(() => document.getElementById("modern-composer").setAttribute("data-chatgpt-composer", ""));
        await page.waitForTimeout(200);
        assert.equal(await page.locator("#modern-streaming-new-2-text").isVisible(), false);
        await appendStreamingAnswer(3);
        await page.evaluate(() => document.getElementById("modern-stop").setAttribute("aria-label", "停止"));
        await page.waitForTimeout(200);
        assert.equal(await page.locator("#modern-streaming-new-3-text").isVisible(), true, "Equivalent visible Stop labels broke the current association");
        await page.evaluate(() => document.getElementById("modern-stop").removeAttribute("aria-label"));
        await waitParagraph("modern-streaming-new-3-text", false);
        await page.evaluate(() => document.getElementById("modern-stop").setAttribute("aria-label", "停止"));
        await page.waitForTimeout(200);
        assert.equal(await page.locator("#modern-streaming-new-3-text").isVisible(), false);
        await appendStreamingAnswer(4);
        await page.evaluate(() => document.getElementById("modern-stop").remove());
        await waitDomCounts(originalCount + 5, originalCount + 5);
        await waitParagraph("modern-streaming-new-4-text", false);
        await waitParagraph("modern-streaming-text", false);
        assert.equal(await page.locator("#modern-streaming-question").isVisible(), true);
      });
    });

    await test("idle fixture has no self-triggered DOM mutation loop", async () => {
      // Allow the intentionally bounded streaming/debounce timeout to finish.
      await page.waitForTimeout(1800);
      const mutations = await page.evaluate(() => new Promise(resolve => {
        let count = 0;
        const observer = new MutationObserver(records => { count += records.length; });
        observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
        setTimeout(() => { observer.disconnect(); resolve(count); }, 650);
      }));
      assert.equal(mutations, 0, "The extension kept mutating an otherwise idle DOM");
      assert.deepEqual(pageErrors, [], "Browser page raised JavaScript errors");
    });

    console.log(`\n${passed} browser integration checks passed (${mode}; synthetic fixture only).`);
    console.log("No memory reduction percentage is inferred. Live ChatGPT validation remains a separate manual check.");
  } catch (error) {
    if (page && process.env.CGF_TEST_SCREENSHOT) {
      try {
        const target = path.resolve(process.env.CGF_TEST_SCREENSHOT);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        await page.screenshot({ path: target, fullPage: true, timeout: 3000 });
        console.error(`Synthetic fixture failure screenshot: ${target}`);
      } catch { /* The original test error is more useful than a screenshot error. */ }
    }
    console.error(`FAIL after ${passed} passed checks (${mode}, synthetic fixture): ${error.stack || error}`);
    process.exitCode = 1;
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
