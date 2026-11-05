#!/usr/bin/env node
"use strict";

/*
 * Manual native-lifecycle probe regressions on an intercepted synthetic page.
 * Uses real Chromium DOM/CSS/MutationObserver, without Chrome API mocks or
 * loading the extension. The fixture simulates page-owned removal/remounting;
 * a pass proves probe behavior, not a live ChatGPT control entry or RAM saving.
 * The test selection deliberately emulates DevTools $0, so no GC is inferred.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PROBE = path.join(ROOT, "experiments", "native-lifecycle-probe.js");
const TEST_URL = "https://chatgpt.com/c/synthetic-private-route-96cf?private=synthetic-private-query-96cf";
const OTHER_URL = "https://example.invalid/c/synthetic-private-route-96cf";
const PRIVATE = {
  text: "SYNTHETIC_PRIVATE_CHAT_TEXT_96cf",
  message: "synthetic-private-message-id-96cf",
  user: "synthetic-private-user-id-96cf",
  turn: "synthetic-private-turn-key-96cf",
  title: "SYNTHETIC_PRIVATE_TITLE_96cf",
  label: "SYNTHETIC_PRIVATE_MARK_LABEL_96cf"
};
const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <title>Synthetic lifecycle test</title><style>
    body { margin: 20px; font: 16px/1.5 system-ui; }
    main { width: 650px; min-height: 2400px; }
    [data-turn-key] { margin: 20px 0; }
    [data-cgf-control] { display: block; }
    [data-cgf-collapsed="true"] > :not([data-cgf-control]) { display: none; }
  </style></head><body><main id="thread"></main>
  <form data-chatgpt-composer id="composer"><textarea></textarea></form>
  </body></html>`;

if (process.argv.includes("--help")) {
  console.log(`ChatGPT Fold native-lifecycle observation probe regressions

  node tests/native-lifecycle-probe.cjs
  node tests/native-lifecycle-probe.cjs --headed

Uses a synthetic page with all network requests intercepted; no live chat.
Optional: CGF_PLAYWRIGHT_MODULE, CODEX_PRIMARY_RUNTIME_NODE_MODULES, CHROME_PATH.
Missing Playwright/Chromium exits 2 (NOT RUN), never a pass.
Does not prove native component unmounting, callable entries, or memory savings.`);
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

function fixtureRuntime(values) {
  document.title = values.title;
  const turn = document.createElement("div");
  turn.id = "target-turn";
  turn.setAttribute("data-turn-key", values.turn);
  turn.setAttribute("data-talvt-turn-state", "complete");
  const user = document.createElement("div");
  user.id = "target-question";
  user.setAttribute("data-user-message-bubble", "true");
  user.setAttribute("data-chatgpt-search-message-ids", values.user);
  user.textContent = values.text + " question";
  const answer = document.createElement("div");
  answer.id = "target-answer";
  answer.setAttribute("data-chatgpt-search-unit-key", values.turn + ":assistant");
  answer.setAttribute("data-chatgpt-search-message-ids", values.message);
  answer.setAttribute("data-chatgpt-selection-message-id", values.message);
  answer.setAttribute("data-cgf-message", "1");
  answer.setAttribute("data-cgf-collapsed", "false");
  const control = document.createElement("button");
  control.type = "button";
  control.setAttribute("data-cgf-control", "true");
  control.textContent = "Synthetic fold control";
  const body = document.createElement("div");
  body.id = "target-body";
  body.setAttribute("data-markdown-text-style", "assistant-message");
  const paragraph = document.createElement("p");
  paragraph.id = "selected-content";
  paragraph.textContent = values.text;
  body.append(paragraph);
  answer.append(control, body);
  turn.append(user, answer);
  document.getElementById("thread").append(turn);
  // The probe reads $0 only when it is pasted. DevTools itself can retain this
  // selection; this harness intentionally does not claim a GC experiment.
  globalThis.$0 = paragraph;
}

function installResourceAudit() {
  const observers = new Set();
  const timers = new Set();
  const intervals = new Set();
  const listeners = [];
  const NativeObserver = globalThis.MutationObserver;
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  const set = globalThis.setTimeout.bind(globalThis);
  const clear = globalThis.clearTimeout.bind(globalThis);
  const setEvery = globalThis.setInterval.bind(globalThis);
  const clearEvery = globalThis.clearInterval.bind(globalThis);
  const capture = options => typeof options === "boolean" ? options : Boolean(options?.capture);
  globalThis.MutationObserver = class extends NativeObserver {
    observe(...args) { super.observe(...args); observers.add(this); }
    disconnect() { super.disconnect(); observers.delete(this); }
  };
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    add.call(this, type, listener, options);
    if (listener && !listeners.some(item => item.target === this && item.type === type &&
      item.listener === listener && item.capture === capture(options))) {
      listeners.push({ target: this, type, listener, capture: capture(options) });
    }
  };
  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    remove.call(this, type, listener, options);
    const index = listeners.findIndex(item => item.target === this && item.type === type &&
      item.listener === listener && item.capture === capture(options));
    if (index !== -1) listeners.splice(index, 1);
  };
  globalThis.setTimeout = (callback, delay, ...args) => {
    const handle = set(() => { timers.delete(handle); callback(...args); }, delay);
    timers.add(handle);
    return handle;
  };
  globalThis.clearTimeout = handle => { timers.delete(handle); clear(handle); };
  globalThis.setInterval = (callback, delay, ...args) => {
    const handle = setEvery(callback, delay, ...args);
    intervals.add(handle);
    return handle;
  };
  globalThis.clearInterval = handle => { intervals.delete(handle); clearEvery(handle); };
  globalThis.nativeProbeAudit = {
    counts: () => ({ observers: observers.size, timers: timers.size,
      intervals: intervals.size, listeners: listeners.length })
  };
}

function checkReport(report) {
  assert.equal(typeof report, "object");
  assert.equal(typeof report.probeVersion, "string");
  assert.equal(typeof report.schemaVersion, "number");
  assert.ok(Array.isArray(report.observations), "A report needs bounded observations");
  assert.ok(report.observations.length <= 120, "Snapshot count exceeded the documented cap");
  const text = JSON.stringify(report);
  for (const secret of [...Object.values(PRIVATE), TEST_URL, "synthetic-private-route-96cf", "synthetic-private-query-96cf"]) {
    assert.ok(!text.includes(secret), "A report exported synthetic private fixture data");
  }
  const claims = report.summary || report;
  assert.equal(report.nativeMountEntry ?? claims.nativeMountEntry, "not-tested");
  assert.equal(report.reactUnmount ?? claims.reactUnmount, "not-proven");
  assert.equal(report.memoryBenefit ?? claims.memoryBenefit, "not-measured");
  return report;
}

function lastPhase(report, phase) {
  const sample = report.observations.findLast(item => item.phase === phase);
  assert.ok(sample, `Missing ${phase} observation`);
  return sample;
}

async function readReport(page) {
  const raw = await page.evaluate(() => globalThis.__CGF_NATIVE_REPORT_V1__);
  assert.equal(typeof raw, "string", "The final report must be a serializable string");
  return checkReport(JSON.parse(raw));
}

async function assertClean(page) {
  const state = await page.evaluate(() => ({ active: Boolean(globalThis.__CGF_NATIVE_PROBE_V1__),
    resources: globalThis.nativeProbeAudit.counts() }));
  assert.equal(state.active, false, "The active probe global survived stopping");
  assert.deepEqual(state.resources, { observers: 0, timers: 0, intervals: 0, listeners: 0 },
    `The probe left asynchronous resources active after stopping: ${JSON.stringify(state.resources)}`);
}

async function finish(page) {
  await page.evaluate(() => globalThis.__CGF_NATIVE_PROBE_V1__?.stop());
  const report = await readReport(page);
  await assertClean(page);
  return report;
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
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await context.route("**/*", route => [TEST_URL, OTHER_URL].includes(route.request().url())
    ? route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: HTML }) : route.abort());
  let passed = 0;
  let failed = 0;

  async function setup(page, url = TEST_URL) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.evaluate(fixtureRuntime, PRIVATE);
    await page.evaluate(installResourceAudit);
  }
  async function start(page) {
    await page.evaluate(source);
    assert.equal(await page.evaluate(() => Boolean(globalThis.__CGF_NATIVE_PROBE_V1__)), true,
      "A supported, completed, unambiguous selected answer was rejected");
  }
  async function waitStopped(page) {
    // Poll from Node: browser-side waitForFunction registers its own resources,
    // which would contaminate the probe-only observer/timer/listener audit.
    const end = Date.now() + 3000;
    let stopped = false;
    do {
      stopped = await page.evaluate(() => typeof globalThis.__CGF_NATIVE_REPORT_V1__ === "string" &&
        !globalThis.__CGF_NATIVE_PROBE_V1__);
      if (!stopped) await new Promise(resolve => setTimeout(resolve, 25));
    } while (!stopped && Date.now() < end);
    assert.equal(stopped, true, "The probe did not stop automatically");
    const report = await readReport(page);
    await assertClean(page);
    return report;
  }
  async function test(name, action, autoStart = true) {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      await setup(page);
      if (autoStart) await start(page);
      await action(page);
      assert.deepEqual(errors, [], "Unexpected browser error");
      passed += 1;
      console.log(`PASS ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${name}\n  ${error.message.split("\n")[0]}`);
    } finally { await page.close(); }
  }

  console.log("MODE: standalone manual probe; intercepted synthetic Chromium DOM; no live ChatGPT or GC claim");
  try {
    await test("CSS folding remains connected and probing does not mutate the page", async page => {
      const before = await page.evaluate(() => document.documentElement.outerHTML);
      await start(page);
      assert.equal(await page.evaluate(() => document.documentElement.outerHTML), before,
        "Installing the passive probe changed page HTML");
      await page.evaluate(() => {
        __CGF_NATIVE_PROBE_V1__.mark("baseline");
        document.getElementById("target-answer").setAttribute("data-cgf-collapsed", "true");
        __CGF_NATIVE_PROBE_V1__.mark("folded");
        document.getElementById("target-answer").setAttribute("data-cgf-collapsed", "false");
        __CGF_NATIVE_PROBE_V1__.mark("unfolded");
      });
      const report = await finish(page);
      const folded = lastPhase(report, "folded");
      assert.equal(folded.targetPresent, true);
      assert.equal(folded.originalAnswerConnected, true);
      assert.equal(folded.bodyConnected, true);
      assert.equal(folded.extensionFolded, true);
      assert.equal(lastPhase(report, "unfolded").extensionFolded, false);
      assert.equal(report.summary.detachedObserved, false, "CSS hiding was mislabeled as DOM detachment");
    }, false);

    await test("unit and consistent-carrier answers remount under a surviving original shell", async page => {
      for (const unit of [true, false]) {
        await setup(page);
        if (!unit) await page.evaluate(() => {
          document.getElementById("target-answer").removeAttribute("data-chatgpt-search-unit-key");
        });
        await start(page);
        await page.evaluate(() => {
          document.getElementById("target-answer").remove();
          __CGF_NATIVE_PROBE_V1__.mark("away");
        });
        await page.evaluate(({ values, unit }) => {
          const answer = document.createElement("div");
          answer.id = "replacement-answer";
          if (unit) answer.setAttribute("data-chatgpt-search-unit-key", values.turn + ":assistant");
          answer.setAttribute("data-chatgpt-search-message-ids", values.message);
          answer.setAttribute("data-chatgpt-selection-message-id", values.message);
          answer.setAttribute("data-cgf-message", "2");
          const body = document.createElement("div");
          body.setAttribute("data-markdown-text-style", "assistant-message");
          body.textContent = values.text + " synthetic remount";
          answer.append(body);
          document.getElementById("target-turn").append(answer);
          __CGF_NATIVE_PROBE_V1__.mark("returned");
        }, { values: PRIVATE, unit });
        const report = await finish(page);
        const away = lastPhase(report, "away");
        const returned = lastPhase(report, "returned");
        assert.equal(away.targetPresent, false);
        assert.equal(away.originalAnswerConnected, false);
        assert.equal(returned.targetPresent, true, `A ${unit ? "unit" : "carrier"} root was not recovered`);
        assert.equal(returned.sameAnswerNode, false);
        assert.ok(returned.ancestorStates.some(item => item.kind === "turn" && item.connected && item.containsCurrentAnswer),
          "A retained turn containing the remounted answer was not reported");
        assert.equal(report.summary.detachedObserved, true);
        assert.equal(report.summary.reappearedWithNewRoot, true);
        assert.equal(report.summary.stableAncestorObserved, true);
      }
    }, false);

    await test("body-only removal is distinct from removal of the answer root", async page => {
      await page.evaluate(() => {
        document.getElementById("target-body").remove();
        __CGF_NATIVE_PROBE_V1__.mark("away");
        const body = document.createElement("div");
        body.setAttribute("data-markdown-text-style", "assistant-message");
        body.textContent = "Synthetic replacement body";
        document.getElementById("target-answer").append(body);
        __CGF_NATIVE_PROBE_V1__.mark("returned");
      });
      const report = await finish(page);
      const away = lastPhase(report, "away");
      const returned = lastPhase(report, "returned");
      assert.equal(away.targetPresent, true, "A confirmed, still-connected answer shell was treated as absent");
      assert.equal(away.originalAnswerConnected, true);
      assert.equal(away.bodyPresent, false);
      assert.equal(away.originalBodyConnected, false);
      assert.equal(returned.sameAnswerNode, true);
      assert.equal(returned.bodyConnected, true);
      assert.equal(returned.originalBodyConnected, false);
      assert.equal(report.summary.detachedObserved, false, "Removing only the body was reported as answer-root detachment");
      assert.equal(report.summary.reappearedWithNewRoot, false);

      await setup(page);
      await start(page);
      await page.evaluate(values => {
        document.getElementById("target-answer").remove();
        const stranger = document.createElement("div");
        stranger.setAttribute("data-chatgpt-search-message-ids", values.message);
        stranger.setAttribute("data-cgf-message", "2");
        document.getElementById("target-turn").append(stranger);
        __CGF_NATIVE_PROBE_V1__.mark("away");
      }, PRIVATE);
      const stranger = await finish(page);
      assert.equal(lastPhase(stranger, "away").targetPresent, false,
        "A new ID-only shell was guessed to be an assistant answer");
      assert.equal(stranger.summary.reappearedWithNewRoot, false);
    });

    await test("unsupported pages and invalid selections are rejected without resources", async page => {
      const cases = [
        ["wrong_page", () => history.replaceState(null, "", "/")],
        ["no_selection", () => { delete globalThis.$0; }],
        ["not_assistant", () => { globalThis.$0 = document.getElementById("target-question"); }],
        ["identity_unavailable", () => {
          const answer = document.getElementById("target-answer");
          answer.removeAttribute("data-chatgpt-search-message-ids");
          answer.removeAttribute("data-chatgpt-selection-message-id");
        }],
        ["completion_unconfirmed", () => document.getElementById("target-turn").removeAttribute("data-talvt-turn-state")],
        ["inactive_selection", () => { document.getElementById("target-turn").hidden = true; }],
        ["generation_active", () => document.getElementById("target-turn").setAttribute("data-talvt-turn-state", "in_progress")]
      ];
      for (const [reason, mutate] of cases) {
        await setup(page);
        await page.evaluate(mutate);
        await page.evaluate(source);
        const report = await readReport(page);
        assert.equal(report.outcome, "rejected");
        assert.equal(report.reason, reason);
        await assertClean(page);
      }
      await setup(page, OTHER_URL);
      await page.evaluate(source);
      assert.equal((await readReport(page)).reason, "wrong_page");
      await assertClean(page);
    }, false);

    await test("ambiguous identity or duplicate initial roots never selects an arbitrary answer", async page => {
      for (const mode of ["conflicting-identities", "duplicate-roots"]) {
        await setup(page);
        await page.evaluate(mode => {
          const answer = document.getElementById("target-answer");
          if (mode === "conflicting-identities") {
            answer.setAttribute("data-chatgpt-selection-message-id", "conflicting-synthetic-message");
          } else {
            const other = document.getElementById("target-turn").cloneNode(true);
            document.getElementById("thread").append(other);
          }
        }, mode);
        await page.evaluate(source);
        const report = await readReport(page);
        assert.equal(report.outcome, "rejected");
        assert.equal(report.reason, mode === "conflicting-identities" ? "identity_unavailable" : "identity_ambiguous");
        await assertClean(page);
      }
      await setup(page);
      await page.evaluate(() => {
        const hiddenCopy = document.getElementById("target-turn").cloneNode(true);
        hiddenCopy.hidden = true;
        document.getElementById("thread").append(hiddenCopy);
      });
      await start(page);
      assert.equal((await finish(page)).reason, "manual_stop", "A hidden duplicate caused false ambiguity");
    }, false);

    await test("a recycled identity or duplicate later target stops tracking rather than guessing", async page => {
      for (const mode of ["recycled-root", "duplicate-root"]) {
        await setup(page);
        await start(page);
        await page.evaluate(mode => {
          const answer = document.getElementById("target-answer");
          if (mode === "recycled-root") {
            answer.setAttribute("data-chatgpt-search-message-ids", "a-different-synthetic-message");
            answer.setAttribute("data-chatgpt-selection-message-id", "a-different-synthetic-message");
          } else document.getElementById("target-turn").append(answer.cloneNode(true));
        }, mode);
        const report = await waitStopped(page);
        assert.equal(report.outcome, "aborted");
        assert.equal(report.reason, mode === "recycled-root" ? "identity_changed" : "identity_ambiguous");
      }
    }, false);

    await test("generation markers and newly visible Stop controls abort without a manual sample", async page => {
      for (const mode of ["turn-state", "streaming-class", "aria-busy", "stop-testid", "stop-style", "stop-role"]) {
        await setup(page);
        if (mode.startsWith("stop-")) await page.evaluate(mode => {
          const button = document.createElement("button");
          button.id = "test-stop";
          button.type = "button";
          if (mode !== "stop-testid") button.setAttribute("aria-label", "Stop");
          if (mode === "stop-style") button.style.display = "none";
          if (mode === "stop-role") {
            const composer = document.getElementById("composer");
            composer.setAttribute("data-app-action-timeline-scroll", "");
            composer.setAttribute("role", "presentation");
          }
          document.getElementById("composer").append(button);
        }, mode);
        await start(page);
        await page.evaluate(mode => {
          if (mode === "turn-state") document.getElementById("target-turn").setAttribute("data-talvt-turn-state", "in_progress");
          if (mode === "streaming-class") document.getElementById("target-body").classList.add("result-streaming");
          if (mode === "aria-busy") document.getElementById("target-body").setAttribute("aria-busy", "true");
          if (mode === "stop-testid") document.getElementById("test-stop").setAttribute("data-testid", "stop-button");
          if (mode === "stop-style") document.getElementById("test-stop").style.display = "";
          if (mode === "stop-role") document.getElementById("composer").setAttribute("role", "region");
        }, mode);
        const report = await waitStopped(page);
        assert.equal(report.outcome, "aborted", `${mode} did not abort`);
        assert.equal(report.reason, "generation_active", `${mode} missed a generation signal`);
      }
    }, false);

    await test("route replacement, body replacement and pagehide stop all observation resources", async page => {
      const mutations = [
        ["route_changed", () => {
          history.pushState(null, "", "/c/a-different-synthetic-conversation");
          document.getElementById("thread").append(document.createElement("span"));
        }],
        ["body_changed", () => document.body.replaceWith(document.createElement("body"))],
        ["pagehide", () => window.dispatchEvent(new PageTransitionEvent("pagehide"))]
      ];
      for (const [reason, mutate] of mutations) {
        await setup(page);
        await start(page);
        await page.evaluate(mutate);
        const report = await waitStopped(page);
        assert.equal(report.outcome, "aborted");
        assert.equal(report.reason, reason);
      }
    }, false);

    await test("manual stop is idempotent and later activity cannot update the completed report", async page => {
      const raw = await page.evaluate(() => {
        const api = __CGF_NATIVE_PROBE_V1__;
        const first = api.stop();
        const second = api.stop();
        return { first, second, exported: __CGF_NATIVE_REPORT_V1__ };
      });
      assert.equal(raw.first, raw.second);
      assert.equal(raw.first, raw.exported);
      const report = checkReport(JSON.parse(raw.first));
      assert.equal(report.outcome, "stopped");
      assert.equal(report.reason, "manual_stop");
      await assertClean(page);
      await page.evaluate(async () => {
        document.getElementById("target-answer").remove();
        window.dispatchEvent(new Event("scroll"));
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
      });
      assert.equal(await page.evaluate(() => __CGF_NATIVE_REPORT_V1__), raw.first);
      await assertClean(page);
    });

    await test("report fields exclude private content and arbitrary phase labels", async page => {
      const rejected = await page.evaluate(label => {
        try { __CGF_NATIVE_PROBE_V1__.mark(label); return null; }
        catch (error) { return error.name; }
      }, PRIVATE.label);
      assert.equal(rejected, "RangeError");
      const report = await finish(page);
      assert.ok(report.observations.every(item => !Object.values(item).includes(PRIVATE.label)));
      assert.equal(report.reason, "manual_stop", "An unsupported label unexpectedly ended a valid observation");
    });

    await test("snapshot limits end the session without retaining active resources", async page => {
      await page.evaluate(() => {
        for (let i = 0; i < 200 && globalThis.__CGF_NATIVE_PROBE_V1__; i += 1) {
          globalThis.__CGF_NATIVE_PROBE_V1__.mark(i % 2 ? "folded" : "unfolded");
        }
      });
      const report = await waitStopped(page);
      assert.equal(report.outcome, "stopped");
      assert.equal(report.reason, "snapshot_limit");
      assert.equal(report.observations.length, 120);
      assert.equal(report.truncated, true);
    });

    await test("re-pasting the probe does not duplicate an active observation session", async page => {
      const resources = await page.evaluate(() => nativeProbeAudit.counts());
      await page.evaluate(() => { globalThis.nativeProbePreviousApiForTest = __CGF_NATIVE_PROBE_V1__; });
      await page.evaluate(source);
      const comparison = await page.evaluate(() => {
        const same = __CGF_NATIVE_PROBE_V1__ === nativeProbePreviousApiForTest;
        delete globalThis.nativeProbePreviousApiForTest;
        return same;
      });
      assert.equal(comparison, true, "Re-pasting silently replaced the active probe");
      assert.deepEqual(await page.evaluate(() => nativeProbeAudit.counts()), resources,
        "Re-pasting left duplicate asynchronous resources");
      await finish(page);
    });
  } finally { await context.close(); await browser.close(); }
  console.log(`${passed}/${passed + failed} native-lifecycle probe groups passed.`);
  console.log("These are probe validation results, not native lifecycle integration or memory measurements.");
  if (failed) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
