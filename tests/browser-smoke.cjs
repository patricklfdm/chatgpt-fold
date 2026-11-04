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
    async function releaseInteraction() {
      await page.evaluate(() => {
        document.activeElement?.blur();
        document.getSelection()?.removeAllRanges();
      });
    }
    async function assertIdentity() {
      assert.equal(await page.evaluate(() => window.fixture.identitiesIntact()), true, "Original native nodes were moved or recreated");
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
        // Exhaust the content-change quiet timer while the marker remains.
        // Its removal must then be observed, rather than rescued by that timer.
        await page.waitForTimeout(1800);
        assert.equal(await isCollapsed("risk-streaming-answer"), false);
        assert.equal(await page.locator("#risk-streaming-answer [data-cgf-toggle]").isDisabled(), true);
        await page.evaluate(() => document.querySelector("#risk-streaming-answer .markdown").classList.remove("result-streaming"));
        await waitCollapsed("risk-streaming-answer", true);
        await waitDomCounts(originalCount + 1, originalCount + 1);
        await page.evaluate(() => document.getElementById("risk-stop-label").setAttribute("aria-label", "Stop generating"));
        await waitCollapsed("risk-streaming-answer", false);
        await waitDomCounts(originalCount + 1, originalCount);
        assert.equal(await page.locator("#risk-streaming-answer [data-cgf-toggle]").isDisabled(), true);
        await page.evaluate(() => document.getElementById("risk-stop-label").removeAttribute("aria-label"));
        await waitCollapsed("risk-streaming-answer", true);
        await waitDomCounts(originalCount + 1, originalCount + 1);
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

    await test("reload starts cleanly without duplicated controls or a stale pause state", async () => {
      await command("restore");
      await page.reload({ waitUntil: "domcontentloaded" });
      if (mode === "injected") await inject();
      await waitStatus(value => value.total === 5 && !value.paused && value.expanded === 1 && value.collapsed === 4, "Reload did not reset state");
      assert.equal(await page.locator("[data-cgf-control]").count(), 5);
      await assertIdentity();
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
