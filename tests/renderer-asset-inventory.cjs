#!/usr/bin/env node
"use strict";

/*
 * Manual asset inventory regressions, not native lifecycle integration.
 * All pages and requests are intercepted synthetic Chromium fixtures. Normal
 * collection uses real script loads, preload links and Resource Timing;
 * privacy/limit cases explicitly substitute Resource Timing records.
 * No live ChatGPT is accessed.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PROBE = path.join(ROOT, "experiments", "renderer-asset-inventory.js");
const PRIVATE = {
  route: "SYNTHETIC_PRIVATE_ROUTE_a71e",
  query: "SYNTHETIC_PRIVATE_QUERY_a71e",
  fragment: "SYNTHETIC_PRIVATE_FRAGMENT_a71e",
  title: "SYNTHETIC_PRIVATE_TITLE_a71e",
  text: "SYNTHETIC_PRIVATE_CHAT_a71e",
  identity: "SYNTHETIC_PRIVATE_MESSAGE_a71e",
  inline: "SYNTHETIC_PRIVATE_INLINE_a71e",
  error: "SYNTHETIC_PRIVATE_ERROR_a71e",
  credential: "SYNTHETIC_PRIVATE_CREDENTIAL_a71e"
};
const TEST_URL = `https://chatgpt.com/c/${PRIVATE.route}?private=${PRIVATE.query}`;
const FIRST = "https://chatgpt.com/cdn/assets/renderer-entry.js";
const SECOND = "https://cdn.oaistatic.com/assets/conversation-window.mjs";
const THIRD = "https://chatgpt.com/_next/static/chunks/virtual-window.js";
const HTML = `<!doctype html><html><head><meta charset="utf-8">
  <title>${PRIVATE.title}</title><link rel="icon" href="data:,">
  <script src="${FIRST}?private=${PRIVATE.query}#${PRIVATE.fragment}"></script>
  <script type="module" src="${SECOND}?private=${PRIVATE.query}"></script>
  <script id="private-inline" type="application/json">{"value":"${PRIVATE.inline}"}</script>
  </head><body><main data-message-id="${PRIVATE.identity}">${PRIVATE.text}</main></body></html>`;

if (process.argv.includes("--help")) {
  console.log(`ChatGPT Fold renderer asset inventory regressions

  node tests/renderer-asset-inventory.cjs
  node tests/renderer-asset-inventory.cjs --headed

Uses intercepted synthetic Chromium pages; no live ChatGPT or extension.
Privacy/limit tests explicitly mock Resource Timing records.
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
    } catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }
  }
  return null;
}

function checkReport(raw) {
  assert.equal(typeof raw, "string", "The copied report must be a JSON string");
  assert.ok(raw.length < 360000, "The serialized report exceeded its bounded size");
  for (const secret of Object.values(PRIVATE)) {
    assert.ok(!raw.includes(secret), "Report contains synthetic private fixture data");
  }
  const report = JSON.parse(raw);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.probeVersion, "0.2.0-assets.2");
  assert.equal(report.coverage, "current-records-only");
  assert.equal(report.nativeEntry, "not-tested");
  assert.ok(["completed", "rejected"].includes(report.outcome));
  assert.ok([null, "wrong_page", "not_top_frame", "inventory_error"].includes(report.reason));
  assert.ok(report.scripts.length <= report.limits.assets);
  assert.equal(report.counts.includedAssets, report.scripts.length);
  assert.ok(report.counts.inspectedScriptElements <= report.limits.scriptElements);
  assert.ok(report.counts.inspectedLinkElements <= report.limits.linkElements);
  assert.ok(report.counts.inspectedResourceEntries <= report.limits.resourceEntries);
  assert.equal(report.counts.inspectedInlineScripts + report.counts.inspectedExternalScripts,
    report.counts.inspectedScriptElements);
  const urls = report.scripts.map(item => item.url);
  assert.equal(new Set(urls).size, urls.length, "The inventory contains duplicate canonical URLs");
  assert.deepEqual(urls, [...urls].sort(), "Public URLs should have stable ordering");
  for (const item of report.scripts) {
    const url = new URL(item.url);
    assert.equal(url.search + url.hash + url.username + url.password + url.port, "");
    assert.ok(item.url.length <= report.limits.urlLength);
    assert.deepEqual(item.sources, [...new Set(item.sources)].sort());
    assert.ok(item.sources.every(value => ["script-element", "resource-timing",
      "link-modulepreload", "link-preload-script"].includes(value)));
  }
  assert.ok(report.sourceWarnings.every(value =>
    ["script-elements-unavailable", "link-elements-unavailable", "resource-timing-unavailable"].includes(value)));
  return report;
}

async function addInertScripts(page, urls) {
  await page.evaluate(values => {
    for (const src of values) {
      const script = document.createElement("script");
      script.type = "application/json";
      script.src = src;
      document.head.appendChild(script);
    }
  }, urls);
}

async function addLinks(page, definitions) {
  await page.evaluate(values => {
    const fragment = document.createDocumentFragment();
    for (const attributes of values) {
      const link = document.createElement("link");
      for (const [name, value] of Object.entries(attributes)) link.setAttribute(name, value);
      fragment.appendChild(link);
    }
    document.head.appendChild(fragment);
  }, definitions);
}

async function setMockResources(page, urls) {
  // Intentional fixture substitution. Normal collection has its own real
  // Resource Timing test; these records cover otherwise impractical inputs.
  await page.evaluate(values => {
    Object.defineProperty(performance, "getEntriesByType", {
      configurable: true,
      value: type => type === "resource" ? values.map(name => ({ name })) : []
    });
  }, urls);
}

function installSideEffectAudit() {
  const calls = { timers: 0, intervals: 0, frames: 0, listeners: 0,
    observers: 0, fetch: 0, xhr: 0, beacon: 0, contentReads: 0 };
  const wrap = (owner, key, count) => {
    const original = owner[key];
    if (typeof original !== "function") return;
    owner[key] = function (...args) {
      calls[count] += 1;
      return Reflect.apply(original, this, args);
    };
  };
  wrap(window, "setTimeout", "timers");
  wrap(window, "setInterval", "intervals");
  wrap(window, "requestAnimationFrame", "frames");
  wrap(EventTarget.prototype, "addEventListener", "listeners");
  wrap(window, "fetch", "fetch");
  wrap(XMLHttpRequest.prototype, "send", "xhr");
  wrap(navigator, "sendBeacon", "beacon");
  const OriginalObserver = window.MutationObserver;
  window.MutationObserver = class extends OriginalObserver {
    constructor(...args) { super(...args); calls.observers += 1; }
  };
  for (const [node, property] of [
    [document.body, "textContent"], [document, "title"],
    [document.getElementById("private-inline"), "text"],
    [document.getElementById("private-inline"), "textContent"],
    [document.getElementById("private-inline"), "innerHTML"]
  ]) {
    Object.defineProperty(node, property, { configurable: true, get() {
      calls.contentReads += 1;
      throw new Error("Unexpected content read");
    } });
  }
  const descriptorSnapshots = [Node.prototype, Element.prototype, Document.prototype]
    .map(object => [object, Object.getOwnPropertyDescriptors(object)]);
  const html = document.documentElement.outerHTML;
  globalThis.inventoryAudit = () => ({ calls: { ...calls }, htmlUnchanged:
    document.documentElement.outerHTML === html,
    nativeDescriptorsUnchanged: descriptorSnapshots.every(([object, previous]) => {
      const current = Object.getOwnPropertyDescriptors(object);
      return Reflect.ownKeys(current).length === Reflect.ownKeys(previous).length &&
        Reflect.ownKeys(previous).every(key => {
          const a = previous[key], b = current[key];
          return b && ["value", "get", "set", "writable", "enumerable", "configurable"]
            .every(part => a[part] === b[part]);
        });
    }) });
}

async function main() {
  const playwright = findPlaywright();
  if (!playwright) { console.error("NOT RUN: Playwright is not installed; see --help."); process.exitCode = 2; return; }
  const executablePath = [process.env.CHROME_PATH, process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    playwright.chromium.executablePath(), "/usr/bin/chromium", "/usr/bin/chromium-browser"]
    .find(candidate => candidate && fs.existsSync(candidate));
  if (!executablePath) { console.error("NOT RUN: No Chromium executable; set CHROME_PATH."); process.exitCode = 2; return; }
  const source = fs.readFileSync(PROBE, "utf8");
  const browser = await playwright.chromium.launch({ executablePath,
    headless: !process.argv.includes("--headed"), args: process.getuid?.() === 0 ? ["--no-sandbox"] : [] });
  const context = await browser.newContext();
  await context.route("**/*", route => {
    const request = route.request();
    if (request.isNavigationRequest() && request.resourceType() === "document") {
      return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: HTML });
    }
    const url = new URL(request.url());
    if ([new URL(FIRST).pathname, new URL(SECOND).pathname].includes(url.pathname)) {
      return route.fulfill({ status: 200, contentType: "application/javascript",
        headers: { "access-control-allow-origin": "*" }, body: "globalThis.syntheticLoadedAssets = (globalThis.syntheticLoadedAssets || 0) + 1;" });
    }
    return route.abort();
  });
  let passed = 0, failed = 0;

  async function run(page) {
    await page.evaluate(source);
    return checkReport(await page.evaluate(() => globalThis.__CGF_ASSET_REPORT_V1__));
  }
  async function test(name, action) {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.goto(TEST_URL, { waitUntil: "load" });
      await action(page);
      assert.deepEqual(errors, [], "Unexpected browser error");
      passed += 1;
      console.log(`PASS ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${name}\n  ${error.message.split("\n")[0]}`);
    } finally { await page.close(); }
  }

  console.log("MODE: synthetic Chromium; real script/preload/timing baseline, explicit timing mocks for boundaries; no live ChatGPT");
  try {
    await test("actual script loads merge DOM and Resource Timing without query or fragment data", async page => {
      assert.equal(await page.evaluate(() => syntheticLoadedAssets), 2);
      const report = await run(page);
      assert.equal(report.outcome, "completed");
      assert.equal(report.reason, null);
      assert.equal(report.truncated, false);
      assert.deepEqual(report.sourceWarnings, []);
      assert.equal(report.counts.inspectedInlineScripts, 1);
      assert.equal(report.counts.inspectedExternalScripts, 2);
      assert.deepEqual(report.scripts, [FIRST, SECOND].sort().map(url =>
        ({ url, sources: ["resource-timing", "script-element"] })));
    });

    await test("inline bootstrap remains discoverable through modulepreload after Resource Timing is cleared", async page => {
      const relative = `/cdn/assets/renderer-entry.js?inline=${PRIVATE.query}#${PRIVATE.fragment}`;
      await page.setContent(`<!doctype html><html><head><title>${PRIVATE.title}</title>
        <link rel="icon" href="data:,"><link rel="modulepreload" href="${relative}">
        <script type="module">import "${relative}"; globalThis.inlineBootstrapReady = true;</script>
        <script id="private-inline" type="application/json">{"value":"${PRIVATE.inline}"}</script>
        </head><body>${PRIVATE.text}</body></html>`, { waitUntil: "load" });
      assert.equal(await page.evaluate(() => globalThis.inlineBootstrapReady), true);
      assert.equal(await page.evaluate(() => [...document.scripts].every(script => !script.src)), true);
      await page.evaluate(() => performance.clearResourceTimings());
      assert.equal(await page.evaluate(() => performance.getEntriesByType("resource").length), 0);
      const report = await run(page);
      assert.equal(report.outcome, "completed");
      assert.equal(report.truncated, false);
      assert.equal(report.counts.inspectedInlineScripts, 2);
      assert.equal(report.counts.inspectedExternalScripts, 0);
      assert.equal(report.counts.resourceEntries, 0);
      assert.equal(report.counts.linkElements, 1);
      assert.equal(report.counts.inspectedLinkElements, 1);
      assert.deepEqual(report.scripts, [{ url: FIRST, sources: ["link-modulepreload"] }]);
    });

    await test("script preload links merge case-insensitive sources and exclude unrelated link types", async page => {
      const fourth = "https://chatgpt.com/cdn/assets/preloaded-renderer.js";
      await addLinks(page, [
        { rel: "  MoDuLePrElOaD  ", href: `${FIRST}?cache=${PRIVATE.query}#${PRIVATE.fragment}` },
        { rel: "PrElOaD", as: "ScRiPt", href: `${FIRST}?other=${PRIVATE.query}` },
        { rel: "modulepreload", href: "/_next/static/chunks/virtual-window.js" },
        { rel: "preload", as: "script", href: fourth },
        { rel: "preload", as: "style", href: "https://chatgpt.com/cdn/assets/style-only.js" },
        { rel: "preload", as: "image", href: "https://chatgpt.com/cdn/assets/image-only.js" },
        { rel: "stylesheet", href: "https://chatgpt.com/cdn/assets/stylesheet-only.js" },
        { rel: "preconnect", href: "https://chatgpt.com/cdn/assets/preconnect-only.js" },
        { rel: "modulepreload", href: `https://chatgpt.com/backend-api/${PRIVATE.identity}.js` },
        { rel: "modulepreload", href: "https://chatgpt.com/cdn/assets/styles.css" }
      ]);
      // This case tests link classification, independent of which preloads
      // the browser fetches; the real fetch/timing path is tested above.
      await setMockResources(page, [FIRST, SECOND]);
      const report = await run(page);
      assert.equal(report.counts.linkElements, 6);
      assert.equal(report.counts.inspectedLinkElements, 6);
      const byURL = Object.fromEntries(report.scripts.map(item => [item.url, item.sources]));
      assert.deepEqual(Object.keys(byURL).sort(), [FIRST, SECOND, THIRD, fourth].sort());
      assert.deepEqual(byURL[FIRST], ["link-modulepreload", "link-preload-script", "resource-timing", "script-element"]);
      assert.deepEqual(byURL[SECOND], ["resource-timing", "script-element"]);
      assert.deepEqual(byURL[THIRD], ["link-modulepreload"]);
      assert.deepEqual(byURL[fourth], ["link-preload-script"]);
    });

    await test("static URL boundaries reject private routes, credentials, alternate origins and schemes", async page => {
      const blocked = [
        `https://chatgpt.com/backend-api/conversation/${PRIVATE.identity}.js`,
        `https://chatgpt.com/c/${PRIVATE.route}.js`,
        `https://chatgpt.com/assets/${PRIVATE.identity}.js`,
        `https://cdn.oaistatic.com/private/${PRIVATE.identity}.js`,
        `https://third-party.invalid/assets/${PRIVATE.identity}.js`,
        `https://cdn.oaistatic.com.evil.invalid/assets/${PRIVATE.identity}.js`,
        `https://chatgpt.com:444/cdn/assets/${PRIVATE.identity}.js`,
        `https://${PRIVATE.credential}@chatgpt.com/cdn/assets/private.js`,
        `https://user:${PRIVATE.credential}@cdn.oaistatic.com/assets/private.js`,
        `http://chatgpt.com/cdn/assets/${PRIVATE.identity}.js`,
        `blob:https://chatgpt.com/${PRIVATE.identity}.js`,
        `data:text/javascript,${PRIVATE.inline}`,
        `chrome-extension://extension/${PRIVATE.identity}.js`,
        `https://chatgpt.com/cdn/assets/%2f${PRIVATE.identity}.js`,
        `https://chatgpt.com/cdn/assets/../../backend-api/${PRIVATE.identity}.js`,
        `https://chatgpt.com/cdn/assets/${PRIVATE.identity}.json`
      ];
      await addInertScripts(page, [THIRD, ...blocked]);
      await setMockResources(page, [
        ...blocked,
        `${FIRST}?private=${PRIVATE.query}#${PRIVATE.fragment}`,
        `https://chatgpt.com:443/_next/static/chunks/virtual-window.js?private=${PRIVATE.query}`,
        `${SECOND}#${PRIVATE.fragment}`
      ]);
      const report = await run(page);
      assert.equal(report.outcome, "completed");
      assert.deepEqual(report.scripts.map(item => item.url), [FIRST, SECOND, THIRD].sort());
      assert.ok(report.scripts.every(item => item.sources.length === 2));
    });

    await test("collection and output caps remain bounded when script, link and resource lists are large", async page => {
      await addInertScripts(page, Array.from({ length: 600 }, (_, index) =>
        `https://chatgpt.com/cdn/assets/dom-${index}.js`));
      // Reuse one URL to exercise the link scan bound without making hundreds
      // of distinct fixture network requests.
      await addLinks(page, Array.from({ length: 600 }, () => ({ rel: "modulepreload", href: FIRST })));
      await setMockResources(page, Array.from({ length: 5000 }, (_, index) =>
        `https://chatgpt.com/cdn/assets/resource-${index}.js`));
      const report = await run(page);
      assert.equal(report.truncated, true);
      assert.ok(report.counts.scriptElements >= 600);
      assert.equal(report.counts.linkElements, 600);
      assert.equal(report.counts.resourceEntries, 5000);
      assert.equal(report.counts.inspectedScriptElements, 512);
      assert.equal(report.counts.inspectedLinkElements, 512);
      assert.equal(report.counts.inspectedResourceEntries, 4096);
      assert.equal(report.scripts.length, 256);
    });

    await test("oversized candidate and canonical URLs are omitted with an explicit truncation flag", async page => {
      await setMockResources(page, [
        FIRST + "?private=" + PRIVATE.query + "x".repeat(4200),
        "https://chatgpt.com/cdn/assets/" + "x".repeat(1050) + ".js",
        THIRD
      ]);
      const report = await run(page);
      assert.equal(report.limits.inputUrlLength, 4096);
      assert.equal(report.truncated, true);
      assert.deepEqual(report.scripts.map(item => item.url), [FIRST, SECOND, THIRD].sort());
    });

    await test("unavailable sources preserve other results and never export exception text", async page => {
      await page.evaluate(message => {
        Object.defineProperty(performance, "getEntriesByType", { configurable: true,
          value() { throw new Error(message); } });
      }, PRIVATE.error);
      let report = await run(page);
      assert.equal(report.outcome, "completed");
      assert.deepEqual(report.sourceWarnings, ["resource-timing-unavailable"]);
      assert.deepEqual(report.scripts, [FIRST, SECOND].sort().map(url => ({ url, sources: ["script-element"] })));
      await page.evaluate(message => {
        Object.defineProperty(document, "querySelectorAll", { configurable: true,
          value() { throw new Error(message); } });
      }, PRIVATE.error);
      report = await run(page);
      assert.deepEqual(report.sourceWarnings, ["link-elements-unavailable", "resource-timing-unavailable"]);
      assert.deepEqual(report.scripts, [FIRST, SECOND].sort().map(url => ({ url, sources: ["script-element"] })));
      await page.evaluate(() => { delete document.querySelectorAll; });
      await setMockResources(page, [THIRD]);
      await page.evaluate(message => {
        Object.defineProperty(document, "scripts", { configurable: true,
          get() { throw new Error(message); } });
      }, PRIVATE.error);
      report = await run(page);
      assert.deepEqual(report.sourceWarnings, ["script-elements-unavailable"]);
      assert.deepEqual(report.scripts, [{ url: THIRD, sources: ["resource-timing"] }]);
      await page.evaluate(() => {
        Object.defineProperty(performance, "getEntriesByType", { configurable: true, value: undefined });
      });
      report = await run(page);
      assert.deepEqual(report.sourceWarnings, ["script-elements-unavailable", "resource-timing-unavailable"]);
      assert.deepEqual(report.scripts, []);
    });

    await test("wrong pages and child frames reject before collecting resources", async page => {
      for (const url of [`https://example.invalid/c/${PRIVATE.route}`, "https://chatgpt.com/"]) {
        await page.goto(url, { waitUntil: "load" });
        const report = await run(page);
        assert.equal(report.outcome, "rejected");
        assert.equal(report.reason, "wrong_page");
        assert.deepEqual(report.scripts, []);
        assert.equal(report.counts.inspectedScriptElements + report.counts.inspectedLinkElements +
          report.counts.inspectedResourceEntries, 0);
      }
      await page.goto(`https://chatgpt.com/g/synthetic-project/c/${PRIVATE.route}`, { waitUntil: "load" });
      assert.equal((await run(page)).outcome, "completed");
      const navigated = page.waitForEvent("framenavigated", { predicate: item => item !== page.mainFrame() });
      await page.evaluate(url => {
        const iframe = document.createElement("iframe");
        iframe.src = url;
        document.body.appendChild(iframe);
      }, TEST_URL);
      const frame = await navigated;
      await frame.waitForLoadState("load");
      await frame.evaluate(source);
      const report = checkReport(await frame.evaluate(() => globalThis.__CGF_ASSET_REPORT_V1__));
      assert.equal(report.outcome, "rejected");
      assert.equal(report.reason, "not_top_frame");
      assert.deepEqual(report.scripts, []);
      assert.equal(report.counts.inspectedScriptElements + report.counts.inspectedLinkElements +
        report.counts.inspectedResourceEntries, 0);
    });

    await test("repeated runs do not read content, mutate DOM/native methods, or start background work", async page => {
      let requests = 0;
      page.on("request", () => { requests += 1; });
      await page.evaluate(installSideEffectAudit);
      const first = await run(page);
      const second = await run(page);
      assert.deepEqual(second, first, "A repeated inventory changed a stable page's report");
      const audit = await page.evaluate(() => inventoryAudit());
      assert.equal(audit.htmlUnchanged, true);
      assert.equal(audit.nativeDescriptorsUnchanged, true);
      assert.ok(Object.values(audit.calls).every(count => count === 0), JSON.stringify(audit.calls));
      assert.equal(requests, 0, "Inventory caused a new browser network request");
    });
  } finally { await context.close(); await browser.close(); }
  console.log(`${passed}/${passed + failed} renderer asset inventory groups passed.`);
  console.log("These verify bounded inventory behavior, not a native lifecycle entry or memory benefit.");
  if (failed) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
