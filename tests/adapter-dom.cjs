#!/usr/bin/env node
"use strict";

/*
 * Exercise the real adapter against linkedom's DOM and selector implementation.
 * This is not a browser, a layout/CSS test, or a controller/MutationObserver test.
 * The optional test dependency is never shipped as an extension dependency.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

if (process.argv.includes("--help")) {
  console.log(`ChatGPT Fold adapter DOM regressions

  npm install --no-save --package-lock=false linkedom@0.18.15
  npm run test:dom

An existing external installation can be selected without changing this project:
  CGF_DOM_MODULE=/absolute/path/to/node_modules/linkedom node tests/adapter-dom.cjs

The tests use actual DOM parsing/selectors from linkedom, not hand-written mocks.
Missing linkedom produces exit code 2 (NOT RUN). Browser behavior, layout, live
ChatGPT compatibility and memory savings still require separate validation.`);
  process.exit(0);
}

function findDOM() {
  const choices = [process.env.CGF_DOM_MODULE, "linkedom"];
  if (process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES) {
    choices.push(path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, "linkedom"));
  }
  for (const candidate of choices.filter(Boolean)) {
    try {
      const library = require(candidate);
      if (typeof library.parseHTML === "function") return library;
    } catch (error) {
      if (error.code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  return null;
}

const dom = findDOM();
if (!dom) {
  console.error("NOT RUN: optional linkedom dependency was not found. See node tests/adapter-dom.cjs --help. No DOM assertions ran.");
  process.exit(2);
}

const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "adapter.js"), "utf8"), context, { filename: "src/adapter.js" });
const adapter = context.CGFAdapter;
const tests = [];
const test = (name, action) => tests.push({ name, action });
const fixture = body => dom.parseHTML(`<!doctype html><html><head><title>synthetic adapter fixture</title></head><body>${body}</body></html>`).document;
const ids = scope => Array.from(adapter.collect(scope), element => element.id);
const plain = value => JSON.parse(JSON.stringify(value));

test("canonical assistant role takes precedence over its outer turn marker", () => {
  const doc = fixture('<article id="outer" data-turn="assistant"><div id="answer" data-message-author-role="assistant"><p>Body</p></div></article>');
  assert.deepEqual(ids(doc), ["answer"]);
  assert.deepEqual(ids(doc.getElementById("answer")), ["answer"], "Scope itself must be considered");
  assert.equal(adapter.isAssistant(doc.getElementById("outer")), false);
});

test("explicit assistant turns can be div, section, or article", () => {
  const doc = fixture('<div id="div" data-turn="assistant"><p>One</p></div><section id="section" data-turn="assistant"><p>Two</p></section><article id="article" data-turn="assistant"><p>Three</p></article>');
  assert.deepEqual(ids(doc), ["div", "section", "article"]);
  assert.equal(adapter.diagnostics(doc).nonArticleAssistantTurnCount, 2);
});

test("generic prose, articles and conversation test IDs never imply assistant", () => {
  const doc = fixture('<article id="article"><div class="markdown">Body</div></article><div id="turn" data-testid="conversation-turn-123"><p>Body</p></div><div id="heading"><h2>ChatGPT said:</h2><p>Body</p></div>');
  assert.deepEqual(ids(doc), []);
});

test("explicit user roles defeat conflicting assistant-turn markers", () => {
  const doc = fixture('<div id="direct" data-turn="assistant" data-message-author-role="user"><p>User</p></div><div id="descendant" data-turn="assistant"><div data-message-author-role="user"><p>User</p></div></div>');
  assert.deepEqual(ids(doc), []);
  assert.equal(adapter.isAssistant(doc.getElementById("direct")), false);
  assert.equal(adapter.isAssistant(doc.getElementById("descendant")), false);
});

test("user ancestors and unknown role ancestors remain visible", () => {
  const doc = fixture('<section data-message-author-role="user"><div id="role-child" data-message-author-role="assistant"><p>User</p></div><div id="turn-child" data-turn="assistant"><p>User</p></div></section><section data-turn="user"><div id="under-user-turn" data-message-author-role="assistant"><p>User</p></div></section><div data-message-author-role=""><div id="under-empty-role" data-message-author-role="assistant"><p>Unknown</p></div></div><div data-message-author-role="unrecognized"><div id="under-unknown-role" data-turn="assistant"><p>Unknown</p></div></div>');
  assert.deepEqual(ids(doc), []);
});

test("mixed user content is never hidden by an assistant ancestor", () => {
  const doc = fixture('<div id="mixed-role" data-message-author-role="assistant"><p>Assistant</p><div data-message-author-role="user"><p>User</p></div></div><div id="mixed-turn" data-turn="assistant"><p>Assistant</p><section data-turn="user"><p>User</p></section></div>');
  assert.deepEqual(ids(doc), []);
});

test("nested semantic wrappers create exactly one answer record", () => {
  const doc = fixture('<div id="outer-role" data-message-author-role="assistant"><div id="inner-role" data-message-author-role="assistant"><p>Body</p></div></div><section id="outer-turn" data-turn="assistant"><div id="inner-turn" data-turn="assistant"><p>Body</p></div></section><section data-turn="assistant"><div data-turn="assistant"><div id="preferred-role" data-message-author-role="assistant"><p>Body</p></div></div></section><section id="mixed-outer" data-turn="assistant"><div id="mixed-valid" data-turn="assistant"><p>Assistant</p></div><div id="mixed-user" data-turn="user"><p>User</p></div></section>');
  assert.deepEqual(ids(doc), ["outer-role", "outer-turn", "preferred-role", "mixed-valid"]);
  assert.equal(adapter.isAssistant(doc.getElementById("mixed-outer")), false, "Invalid mixed parent must not suppress a valid child");
  assert.equal(adapter.isAssistant(doc.getElementById("mixed-user")), false);
});

test("removing an inner role changes eligibility to its surviving turn ancestor", () => {
  const doc = fixture('<article id="outer" data-turn="assistant"><div id="inner" data-message-author-role="assistant"><div id="body"><p>Preserved body</p></div></div></article>');
  const inner = doc.getElementById("inner");
  const body = doc.getElementById("body");
  assert.deepEqual(ids(doc), ["inner"]);
  inner.removeAttribute("data-message-author-role");
  assert.deepEqual(ids(inner), [], "Scanning only the changed inner subtree reproduces the old miss");
  assert.equal(adapter.scanRoot(inner), doc.getElementById("outer"));
  assert.deepEqual(ids(adapter.scanRoot(inner)), ["outer"]);
  assert.equal(doc.getElementById("body"), body);
  assert.equal(body.parentElement, inner);
});

test("removal-only updates can discover a newly eligible surviving ancestor", () => {
  const doc = fixture('<section id="outer" data-turn="assistant"><div id="target"><div id="removed" data-message-author-role="assistant"><p>Old</p></div><p id="survivor">Preserved</p></div></section>');
  assert.deepEqual(ids(doc), ["removed"]);
  doc.getElementById("removed").remove();
  const target = doc.getElementById("target");
  assert.deepEqual(ids(target), []);
  assert.equal(adapter.scanRoot(target), doc.getElementById("outer"));
  assert.deepEqual(ids(adapter.scanRoot(target)), ["outer"]);
  assert.equal(doc.getElementById("survivor").parentElement, target);
});

test("scanRoot revisits outer semantic ancestors while preserving canonical preference", () => {
  const doc = fixture('<article id="outer" data-turn="assistant"><div id="middle" data-message-author-role="assistant"><div><p id="changed">New paragraph</p></div></div></article>');
  const scope = adapter.scanRoot(doc.getElementById("changed"));
  assert.equal(scope, doc.getElementById("outer"));
  assert.deepEqual(ids(scope), ["middle"]);
});

test("bare direct text is detected for the controller's fail-open protection", () => {
  const doc = fixture('<div id="bare" data-turn="assistant">Unwrapped text<p>Body</p></div><div id="wrapped" data-turn="assistant"> \n <p>Body</p> </div>');
  assert.equal(adapter.hasDirectText(doc.getElementById("bare")), true);
  assert.equal(adapter.hasDirectText(doc.getElementById("wrapped")), false);
});

test("rollout assistant units are separate from the prompt sharing their turn", () => {
  const doc = fixture(`
    <div id="mixed-turn" data-turn-key="turn-one" data-talvt-turn-state="complete">
      <div id="question" data-chatgpt-search-unit-key="fallback-turn-0:0:user" data-chatgpt-search-message-ids="question-one">
        <div data-user-message-bubble="true"><p>Question stays visible.</p></div>
      </div>
      <div id="answer" data-chatgpt-search-unit-key="fallback-turn-0:0:assistant" data-chatgpt-search-message-ids="answer-one">
        <div data-markdown-text-style="assistant-message"><p>Answer body.</p></div>
      </div>
    </div>
    <div data-turn-key="turn-two" data-talvt-turn-state="complete">
      <div id="content-answer" data-content-search-unit-key="fallback-turn-1:0:assistant">
        <div data-markdown-text-style="assistant-message"><p>Alternate unit marker.</p></div>
      </div>
    </div>
    <li id="message-role-answer" data-message-role="assistant"><div data-markdown-text-style="assistant-message"><p>Explicit message-role alias.</p></div></li>
  `);
  assert.deepEqual(ids(doc), ["answer", "content-answer", "message-role-answer"]);
  assert.equal(adapter.isAssistant(doc.getElementById("mixed-turn")), false, "Turn state/key must not fold a prompt together with its reply");
  assert.equal(adapter.isAssistant(doc.getElementById("question")), false);
  assert.equal(doc.querySelectorAll('[data-message-author-role], [data-turn], .markdown, article').length, 0, "The fixture must not accidentally rely on legacy markup");
});

test("turn keys, message IDs and completion state alone never imply assistant", () => {
  const doc = fixture(`
    <div id="state-only" data-talvt-turn-state="complete"><p>Unknown content.</p></div>
    <div id="turn-only" data-turn-key="unclassified-turn"><p>Unknown content.</p></div>
    <div id="ids-only" data-chatgpt-search-message-ids="unclassified-message"><p>Unknown content.</p></div>
    <div id="selection-only" data-chatgpt-selection-message-id="unclassified-selection"><p>Unknown content.</p></div>
    <div id="user-markdown" data-markdown-text-style="user-message"><p>Question.</p></div>
  `);
  assert.deepEqual(ids(doc), []);
  const guarded = fixture(`
    <div id="conflicting-identities" data-chatgpt-search-message-ids="message-a message-b" data-chatgpt-selection-message-id="message-a">
      <div id="conflict-body" data-markdown-text-style="assistant-message"><p>Conflicting carrier identities.</p></div>
    </div>
    <div id="different-outer" data-chatgpt-search-message-ids="outer-id">
      <div id="different-inner" data-chatgpt-search-message-ids="inner-id"><div data-markdown-text-style="assistant-message"><p>Only the inner answer owns this body.</p></div></div>
    </div>
    <div data-turn-key="multiple-bare-parts">
      <div data-markdown-text-style="assistant-message"><p>First ungrouped body.</p></div>
      <div data-markdown-text-style="assistant-message"><p>Second ungrouped body.</p></div>
    </div>
    <div id="combined" data-chatgpt-search-message-ids="same-id same-id" data-chatgpt-selection-message-id="same-id" data-markdown-text-style="assistant-message"><p>Body and carrier on one element.</p></div>
  `);
  assert.equal(adapter.isAssistant(guarded.getElementById("conflicting-identities")), false);
  assert.equal(adapter.isAssistant(guarded.getElementById("different-outer")), false);
  assert.deepEqual(ids(guarded), ["conflict-body", "different-inner", "combined"], "Ambiguous outer carriers and ungrouped body fragments must not be registered; a single explicit body remains a narrow fallback");
});

test("rollout user markers defeat conflicting keys, legacy roles and markdown hints", () => {
  const doc = fixture(`
    <div data-chatgpt-search-unit-key="turn:0:user"><div data-markdown-text-style="assistant-message"><p>User content with a misleading inner style.</p></div></div>
    <div data-content-search-unit-key="turn:1:user"><div data-message-author-role="assistant"><p>User content with a misleading inner role.</p></div></div>
    <li data-message-role="user"><div data-chatgpt-search-unit-key="turn:1:assistant"><div data-markdown-text-style="assistant-message"><p>User alias wins.</p></div></div></li>
    <div data-user-message-bubble="true"><div data-chatgpt-search-unit-key="turn:2:assistant"><div data-markdown-text-style="assistant-message"><p>User content with a misleading inner key.</p></div></div></div>
    <div data-message-author-role="user" data-chatgpt-search-unit-key="turn:3:assistant"><div data-markdown-text-style="assistant-message"><p>Explicit user wins.</p></div></div>
    <div data-chatgpt-search-unit-key="turn:4:assistant" data-content-search-unit-key="turn:4:user"><div data-markdown-text-style="assistant-message"><p>Conflicting keys stay visible.</p></div></div>
    <div data-chatgpt-search-unit-key="turn:5:assistant"><div data-user-message-bubble="true"><p>Mixed content stays visible.</p></div></div>
  `);
  assert.deepEqual(ids(doc), []);
});

test("nested rollout and legacy markers produce a single answer record", () => {
  const doc = fixture(`
    <div id="unit" data-chatgpt-search-unit-key="turn:0:assistant" data-content-search-unit-key="turn:0:assistant" data-chatgpt-search-message-ids="answer-id">
      <div id="role" data-message-author-role="assistant"><div id="body" data-markdown-text-style="assistant-message"><p>One logical answer.</p></div></div>
    </div>
  `);
  const found = Array.from(adapter.collect(doc));
  assert.equal(found.length, 1, "Multiple renderer hints must not create duplicate answer controls");
  assert.equal(found[0].contains(doc.getElementById("body")), true);
  const grouped = fixture(`
    <div data-turn-key="unit-group">
      <div id="aggregate-body" data-markdown-text-style="assistant-message">
        <div id="first-unit" data-chatgpt-search-unit-key="first:assistant"><div data-markdown-text-style="assistant-message"><p>First answer.</p></div></div>
        <div id="second-unit" data-content-search-unit-key="second:assistant"><div data-markdown-text-style="assistant-message"><p>Second answer.</p></div></div>
      </div>
    </div>
    <div data-turn-key="carrier-group">
      <div id="aggregate-carrier-body" data-markdown-text-style="assistant-message">
        <div id="first-carrier" data-chatgpt-search-message-ids="first-id"><div data-markdown-text-style="assistant-message"><p>First carrier.</p></div></div>
        <div id="second-carrier" data-chatgpt-search-message-ids="second-id"><div data-markdown-text-style="assistant-message"><p>Second carrier.</p></div></div>
      </div>
    </div>
  `);
  assert.deepEqual(ids(grouped), ["first-unit", "second-unit", "first-carrier", "second-carrier"], "A broader body wrapper must yield to separate explicit units or consistent carriers");
  assert.equal(adapter.isAssistant(grouped.getElementById("aggregate-body")), false);
  assert.equal(adapter.isAssistant(grouped.getElementById("aggregate-carrier-body")), false);
});

test("assistant markdown promotes a single-message carrier without folding its shared turn", () => {
  const doc = fixture(`
    <div id="shared-turn" data-turn-key="shared-question-and-answer" data-talvt-turn-state="complete">
      <div id="prompt" data-user-message-bubble="true"><p>Prompt.</p></div>
      <div id="carrier" data-chatgpt-search-message-ids="same-answer-id same-answer-id">
        <div data-markdown-text-style="assistant-message"><p>First part.</p></div>
        <div data-markdown-text-style="assistant-message"><p>Second part of the same answer.</p></div>
      </div>
      <div id="selection-carrier" data-chatgpt-selection-message-id="selection-answer-id">
        <div data-markdown-text-style="assistant-message"><p>Selection carrier.</p></div>
      </div>
      <div id="body-only" data-markdown-text-style="assistant-message"><p>Explicit answer body in a known turn.</p></div>
    </div>
  `);
  assert.deepEqual(ids(doc), ["carrier", "selection-carrier", "body-only"]);
  assert.equal(adapter.isAssistant(doc.getElementById("shared-turn")), false);
  for (const element of adapter.collect(doc)) {
    assert.equal(element.contains(doc.getElementById("prompt")), false, "Fallback answer root contains the prompt");
  }
  const ambiguous = doc.createElement("div");
  ambiguous.setAttribute("data-chatgpt-search-message-ids", "different-id-one different-id-two");
  ambiguous.innerHTML = '<div data-markdown-text-style="assistant-message"><p>Ambiguous carrier.</p></div>';
  doc.body.append(ambiguous);
  assert.equal(adapter.isAssistant(ambiguous), false, "Multiple unique IDs cannot justify promoting a whole container");
});

test("role removal and rollout key changes re-evaluate the surviving modern carrier", () => {
  const doc = fixture('<div id="carrier" data-chatgpt-search-message-ids="answer-id"><div id="inner" data-message-author-role="assistant"><div id="body" data-markdown-text-style="assistant-message"><p>Preserved body.</p></div></div></div>');
  const inner = doc.getElementById("inner"), body = doc.getElementById("body");
  assert.deepEqual(ids(doc), ["inner"]);
  inner.removeAttribute("data-message-author-role");
  assert.deepEqual(ids(adapter.scanRoot(inner)), ["carrier"], "Changing an inner marker must revisit its modern carrier");
  assert.equal(body.parentElement, inner);
  const carrier = doc.getElementById("carrier");
  carrier.setAttribute("data-chatgpt-search-unit-key", "same-turn:user");
  assert.deepEqual(ids(doc), [], "User role in a new unit key must prevent the markdown fallback");
  carrier.setAttribute("data-chatgpt-search-unit-key", "same-turn:assistant");
  assert.deepEqual(ids(doc), ["carrier"]);
});

test("actual message identities survive wrapper and positional unit changes", () => {
  const doc = fixture(`
    <div id="legacy-id" data-message-author-role="assistant" data-message-id="answer-a"><p>Legacy.</p></div>
    <div id="modern-id" data-chatgpt-search-unit-key="fallback-turn-7:0:assistant">
      <div data-chatgpt-search-message-ids="answer-a answer-a" data-chatgpt-selection-message-id="answer-a">
        <div data-markdown-text-style="assistant-message"><p>Modern nested identity.</p></div>
      </div>
    </div>
    <div data-chatgpt-search-message-ids="answer-a"><div id="in-carrier" data-message-role="assistant"><p>Wrapper identity.</p></div></div>
    <div id="positional" data-content-search-unit-key="fallback-turn-0:0:assistant"><p>No message ID.</p></div>
  `);
  const modern = doc.getElementById("modern-id");
  assert.equal(adapter.identity(doc.getElementById("legacy-id")), "message:answer-a");
  assert.equal(adapter.identity(modern), "message:answer-a");
  const previousHint = adapter.identityHint(modern);
  modern.setAttribute("data-chatgpt-search-unit-key", "fallback-turn-0:0:assistant");
  assert.notEqual(adapter.identityHint(modern), previousHint, "A live-node reuse hint must notice a unit change");
  assert.equal(adapter.identity(modern), "message:answer-a", "Positions must not replace actual message identity");
  assert.equal(adapter.identity(doc.getElementById("in-carrier")), "message:answer-a");
  assert.equal(adapter.identity(doc.getElementById("positional")), null, "Positional units are not durable message IDs");
});

test("ambiguous and excessive message identities do not fall back to weaker keys", () => {
  const doc = fixture(`
    <div id="different-ids" data-message-role="assistant" data-message-id="answer-a"><div data-chatgpt-search-message-ids="answer-b"><p>Conflict.</p></div></div>
    <div id="multiple-ids" data-chatgpt-search-unit-key="fallback-turn-0:0:assistant" data-chatgpt-search-message-ids="answer-a answer-b"><p>Ambiguous.</p></div>
    <div id="selection-conflict" data-message-role="assistant" data-chatgpt-search-message-ids="answer-a" data-chatgpt-selection-message-id="answer-b"><p>Conflict.</p></div>
    <div data-chatgpt-search-message-ids="question-id"><div data-user-message-bubble="true"><p>Question.</p></div><div id="shared-parent" data-message-role="assistant"><p>Unidentified answer.</p></div></div>
    <div id="turn-fallback" data-turn="assistant" data-turn-id="same-value"><p>Legacy turn.</p></div>
  `);
  for (const id of ["different-ids", "multiple-ids", "selection-conflict", "shared-parent"]) {
    assert.equal(adapter.identity(doc.getElementById(id)), null, `${id} must not supply a persistent identity`);
  }
  const turn = doc.getElementById("turn-fallback");
  assert.equal(adapter.identity(turn), "turn:same-value", "A legacy append anchor is separate from message identity");
  turn.setAttribute("data-message-id", "x".repeat(161));
  assert.equal(adapter.identity(turn), null, "Invalid explicit message evidence must not fall back to its turn");
  turn.setAttribute("data-message-id", "same-value");
  assert.equal(adapter.identity(turn), "message:same-value");
});

test("diagnostics have an exact count schema and never include text or identifier values", () => {
  const doc = fixture('<main><article data-testid="conversation-turn-PRIVATE_CONVERSATION"><div id="PRIVATE_ELEMENT_ID" data-message-author-role="assistant" data-message-id="PRIVATE_MESSAGE_ID"><p>PRIVATE_BODY_TEXT</p></div></article><div data-turn="assistant"><p>Fallback</p></div><div data-message-author-role="user"></div><div data-message-author-role=""></div><div title="PRIVATE_TITLE" data-message-author-role="PRIVATE_ROLE" data-turn="PRIVATE_TURN"></div><iframe></iframe></main>');
  const report = plain(adapter.diagnostics(doc));
  const roleCounts = { assistant: 1, user: 1, system: 0, tool: 0, developer: 0, empty: 1, other: 1 };
  const turnCounts = { assistant: 1, user: 0, system: 0, tool: 0, developer: 0, empty: 0, other: 1 };
  assert.deepEqual(report, {
    rawAssistantRoleCount: 1, rawAssistantTurnCount: 1, nonArticleAssistantTurnCount: 1,
    eligibleAnswerCount: 2, nestedRejectedCount: 0, fallbackSuppressedCount: 0, conflictingRoleCount: 0,
    roleCounts, turnCounts, conversationTurnCount: 1, messageIdElementCount: 1,
    articleCount: 1, mainCount: 1, iframeCount: 1,
    modern: {
      messageRoleAssistantCount: 0, searchUnitAssistantCount: 0,
      contentUnitAssistantCount: 0, assistantBodyCount: 0,
      searchMessageContainerCount: 0, selectionMessageContainerCount: 0,
      userBubbleCount: 0, turnContainerCount: 0, inactiveCandidateCount: 0
    }
  });
  assert.equal(JSON.stringify(report).includes("PRIVATE_"), false);
});

test("diagnostic rejection counts distinguish suppression, nesting and role conflicts", () => {
  const doc = fixture('<article data-turn="assistant"><div data-message-author-role="assistant"><p>Valid</p></div></article><div data-turn="assistant" data-message-author-role="user"><p>Conflict</p></div><div data-message-author-role=""><div data-message-author-role="assistant"><p>Nested unknown</p></div></div><section data-turn="assistant"><div data-turn="assistant"><p>Nested fallback</p></div></section><div data-message-author-role="assistant" data-turn="user"><p>Conflict</p></div><div data-message-author-role="assistant"><div data-message-author-role="user"><p>Conflict</p></div></div>');
  const report = adapter.diagnostics(doc);
  assert.equal(report.eligibleAnswerCount, 2);
  assert.equal(report.fallbackSuppressedCount, 1);
  assert.equal(report.nestedRejectedCount, 2);
  assert.equal(report.conflictingRoleCount, 3);
  assert.equal(report.eligibleAnswerCount, adapter.collect(doc).length);
});

test("modern diagnostics report counts without exporting role keys, IDs or state values", () => {
  const doc = fixture(`
    <main>
      <div data-message-role="assistant"><p>PRIVATE_BODY</p></div>
      <div data-chatgpt-search-unit-key="PRIVATE_SEARCH_KEY:assistant" data-chatgpt-search-message-ids="PRIVATE_SEARCH_ID">
        <div data-markdown-text-style="assistant-message"><p>PRIVATE_BODY</p></div>
      </div>
      <div data-content-search-unit-key="PRIVATE_CONTENT_KEY:assistant" data-chatgpt-selection-message-id="PRIVATE_SELECTION_ID">
        <div data-markdown-text-style="assistant-message"><p>PRIVATE_BODY</p></div>
      </div>
      <div data-user-message-bubble="true"><p>PRIVATE_QUESTION</p></div>
      <div data-turn-key="PRIVATE_TURN_KEY" data-talvt-turn-state="PRIVATE_STATE"><p>Unclassified turn.</p></div>
    </main>
  `);
  const report = plain(adapter.diagnostics(doc));
  assert.deepEqual(report.modern, {
    messageRoleAssistantCount: 1, searchUnitAssistantCount: 1,
    contentUnitAssistantCount: 1, assistantBodyCount: 2,
    searchMessageContainerCount: 1, selectionMessageContainerCount: 1,
    userBubbleCount: 1, turnContainerCount: 1, inactiveCandidateCount: 0
  });
  assert.equal(JSON.stringify(report).includes("PRIVATE_"), false);
});

let passed = 0;
for (const { name, action } of tests) {
  try {
    action();
    passed += 1;
    console.log(`PASS ${String(passed).padStart(2, "0")} ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}: ${error.stack || error}`);
    process.exitCode = 1;
    break;
  }
}
console.log(`\n${passed}/${tests.length} adapter DOM regressions passed (linkedom; synthetic markup).`);
console.log("No browser/CSS/controller or live ChatGPT compatibility result is implied.");
