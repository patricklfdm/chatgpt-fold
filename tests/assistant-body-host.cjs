#!/usr/bin/env node
"use strict";

// The page explicitly removes/recreates synthetic nodes; no React or ChatGPT
// controller is loaded. Old-node references are for identity checks, not GC.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const url = "https://chatgpt.com/c/synthetic-body-host";
const control = "#target [data-cgf-control]";

function findChromium() {
  const names = [process.env.CGF_PLAYWRIGHT_MODULE, "playwright", "playwright-core"];
  if (process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES) {
    for (const name of ["playwright", "playwright-core"]) names.push(path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, name));
  }
  for (const name of names.filter(Boolean)) {
    try { const { chromium } = require(name); if (chromium) return chromium; }
    catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }
  }
}

function fixture(mode) {
  const body = '[data-markdown-text-style="assistant-message"]', button = "[data-cgf-control]";
  let generation = 0, clicked = 0, original;
  function makeBody(key) {
    const el = document.createElement("div");
    el.dataset.markdownTextStyle = "assistant-message";
    const para = document.createElement("p"), action = document.createElement("button");
    para.textContent = "First line of synthetic " + key;
    action.textContent = "Synthetic action";
    const born = key === "target" ? ++generation : 0;
    action.addEventListener("click", () => { clicked = born; });
    el.append(para, action);
    return el;
  }
  function makeUnit(key) {
    const unit = document.createElement("div");
    unit.id = key;
    unit.dataset.chatgptSearchMessageIds = "synthetic-message-" + key;
    if (mode !== "id-carrier-only" || key !== "target") unit.dataset.chatgptSearchUnitKey = key + ":assistant";
    unit.append(makeBody(key));
    return unit;
  }
  for (const key of ["target", "neighbor"]) {
    const turn = document.createElement("section"), question = document.createElement("p");
    turn.id = key + "-turn"; turn.dataset.turnKey = key; turn.dataset.talvtTurnState = "complete";
    question.id = key + "-question"; question.dataset.userMessageBubble = "true";
    question.textContent = "Independent question " + key;
    turn.append(question, makeUnit(key)); document.querySelector("main").append(turn);
  }
  function current() {
    const unit = document.querySelector("#target"), child = unit?.querySelector(body), neighbor = document.querySelector("#neighbor");
    return { row: document.querySelector("#target-turn"), question: document.querySelector("#target-question"),
      unit, child, action: child?.querySelector("button"), control: unit?.querySelector(button),
      neighbor, neighborBody: neighbor.querySelector(body), neighborControl: neighbor.querySelector(button) };
  }
  window.fixture = {
    remember() { original = current(); },
    remove() { const t = current(); (mode === "whole-unit" ? t.unit : t.child).remove(); },
    restore() { const t = current(); if (mode === "whole-unit") t.row.append(makeUnit("target")); else t.unit.append(makeBody("target")); },
    state() {
      const t = current();
      return { unitPresent: !!t.unit, sameUnit: t.unit === original.unit, registered: !!t.unit?.hasAttribute("data-cgf-message"),
        bodyPresent: !!t.child, originalBodyConnected: original.child.isConnected,
        headerCount: t.unit?.querySelectorAll(button).length || 0, originalHeaderConnected: original.control.isConnected,
        sameHeader: t.control === original.control, headerUsable: !!(t.control && !t.control.disabled && t.control.getClientRects().length),
        firstLineShown: t.control?.querySelector(".cgf-label")?.textContent.includes("First line of synthetic target") || false,
        expanded: t.unit?.getAttribute("data-cgf-collapsed") === "false", contentHasLayout: !!t.child?.getClientRects().length,
        freshAction: !!(t.action && t.action !== original.action), originalActionConnected: original.action.isConnected,
        generation, clicked,
        sameRowAndQuestion: t.row === original.row && t.question === original.question && !!t.question.getClientRects().length,
        neighborIntact: t.neighbor === original.neighbor && t.neighborBody === original.neighborBody &&
          t.neighborControl === original.neighborControl && !!t.neighborBody.getClientRects().length &&
          t.neighbor.getAttribute("data-cgf-collapsed") === "false" };
    }
  };
}

async function runCase(browser, mode, sources) {
  const context = await browser.newContext({ viewport: { width: 960, height: 800 } });
  try {
    await context.route("**/*", route => route.request().url() === url
      ? route.fulfill({ contentType: "text/html", body: '<!doctype html><link rel="icon" href="data:,"><main></main>' }) : route.abort());
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(4000);
    page.on("pageerror", err => errors.push(err.message));
    await page.goto(url);
    await page.evaluate(fixture, mode);
    await page.addStyleTag({ content: sources.css });
    const cdp = await context.newCDPSession(page);
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const { executionContextId } = await cdp.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "cgf.synthetic.host" });
    // Inject the real local scripts into an actual isolated world. Only the
    // Chrome extension API is mocked; no instrumentation calls rescan/flush.
    const mock = `globalThis.chrome = {storage:{local:{get:async()=>({"cgf.settings.v1":{enabled:true,keepRecent:1,maxExpanded:2}})},onChanged:{addListener(){},removeListener(){}}},
      runtime:{id:"synthetic",getManifest:()=>({version:"0.1.7"}),onMessage:{addListener(){},removeListener(){}}}};`;
    for (const expression of [mock, ...sources.js]) {
      const result = await cdp.send("Runtime.evaluate", { contextId: executionContextId, expression, awaitPromise: true });
      assert.equal(result.exceptionDetails, undefined, "Isolated-world installation failed");
    }
    assert.equal(await page.evaluate(() => typeof window.__chatGPTFoldControllerV1), "undefined");
    await page.waitForFunction(() => document.querySelector("#target")?.dataset.cgfCollapsed === "true" &&
      document.querySelector("#neighbor")?.dataset.cgfCollapsed === "false");
    await page.evaluate(() => fixture.remember());

    async function state() {
      // Include ordinary batched maintenance (120 ms) and subsequent paint.
      await page.evaluate(() => new Promise(done => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(done)), 220)));
      const value = await page.evaluate(() => fixture.state());
      assert.ok(value.sameRowAndQuestion && value.neighborIntact, "Question or neighbor changed");
      return value;
    }
    const explicit = mode === "body-under-explicit-unit";
    const before = await state();
    assert.ok(before.firstLineShown && before.headerUsable && !before.expanded);
    if (!explicit) {
      // Only a remembered manual choice can open this older reply on remount.
      await page.locator(control).click();
      assert.ok((await state()).expanded);
    }
    await page.evaluate(() => fixture.remove());
    const empty = await state();
    assert.equal(empty.originalBodyConnected, false);
    assert.equal(empty.originalActionConnected, false);
    assert.equal(empty.bodyPresent, false);
    assert.equal(empty.unitPresent, mode !== "whole-unit");
    assert.equal(empty.registered, explicit);
    assert.equal(empty.originalHeaderConnected, explicit);
    assert.equal(empty.headerCount, Number(explicit));
    assert.equal(empty.headerUsable, explicit);
    let clickRestoredBody = null;
    if (explicit) {
      assert.ok(empty.sameHeader && empty.sameUnit);
      await page.locator(control).click();
      const requested = await state();
      assert.ok(requested.expanded && requested.headerUsable);
      clickRestoredBody = requested.bodyPresent;
      assert.equal(clickRestoredBody, false, "A Fold click unexpectedly recreated page content");
      assert.equal(requested.generation, 1);
    }
    // Deliberately separate host action: the test page itself creates the new
    // subtree. Nothing connects this action to a Fold click or private API.
    await page.evaluate(() => fixture.restore());
    const back = await state();
    assert.ok(back.registered && back.bodyPresent && back.contentHasLayout && back.expanded && back.firstLineShown);
    assert.equal(back.headerCount, 1); assert.equal(back.sameHeader, explicit);
    assert.equal(back.sameUnit, mode !== "whole-unit");
    assert.ok(!back.originalBodyConnected && !back.originalActionConnected && back.freshAction);
    await page.locator('#target [data-markdown-text-style] button').click();
    assert.equal((await state()).clicked, 2, "Fresh page button did not run its own listener");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ mode, headerWhileBodyAbsent: empty.headerUsable, oldPreviewWhileBodyAbsent: empty.firstLineShown,
      clickRestoredBody, originalHeaderAfterHostRestored: back.sameHeader, openPreferenceAfterHostRestored: back.expanded,
      questionAndNeighborUnaffected: true, recreatedPageActionWorked: true }));
  } finally { await context.close(); }
}

(async () => {
  const chromium = findChromium();
  const executablePath = [process.env.CHROME_PATH, process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    chromium?.executablePath(), "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(p => p && fs.existsSync(p));
  if (!chromium || !executablePath) { console.error("NOT RUN: Playwright and Chromium are required; set CHROME_PATH."); process.exitCode = 2; return; }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const read = file => fs.readFileSync(path.join(root, file), "utf8");
  const scripts = manifest.content_scripts[0];
  const sources = { css: scripts.css.map(read).join("\n"), js: scripts.js.map(read) };
  const browser = await chromium.launch({ executablePath, args: process.getuid?.() === 0 ? ["--no-sandbox"] : [] });
  try {
    console.log(`Synthetic host, Chromium ${browser.version()}, Node ${process.version}, extension ${manifest.version}; mocked Chrome API; no live ChatGPT, React lifecycle or memory measurement.`);
    for (const mode of ["body-under-explicit-unit", "whole-unit", "id-carrier-only"]) await runCase(browser, mode, sources);
    console.log("3/3 host compatibility scenarios passed.");
  } finally { await browser.close(); }
})().catch(err => { console.error(err); process.exitCode = 1; });
