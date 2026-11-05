/* Keep site-specific assumptions here. Unknown markup stays visible. */
(function (root) {
  "use strict";
  const ROLE = '[data-message-author-role="assistant"]';
  const FALLBACK = '[data-turn="assistant"]';
  const MESSAGE_ROLE = '[data-message-role="assistant"]';
  const UNIT_ATTRIBUTES = ["data-chatgpt-search-unit-key", "data-content-search-unit-key"];
  const UNIT = UNIT_ATTRIBUTES.map(name => `[${name}$=":assistant"]`).join(",");
  const BODY = '[data-markdown-text-style="assistant-message"]';
  const CARRIER = '[data-chatgpt-search-message-ids], [data-chatgpt-selection-message-id]';
  const TURN = '[data-turn-key], [data-content-search-turn-key], [data-talvt-turn-state]';
  const ROLE_CONTEXT = '[data-message-author-role], [data-message-role], [data-chatgpt-search-unit-key], [data-content-search-unit-key]';
  const USER = '[data-message-author-role="user"], [data-message-role="user"], [data-turn="user"], [data-user-message-bubble="true"], ' +
    UNIT_ATTRIBUTES.map(name => `[${name}$=":user"]`).join(",");
  const CANDIDATE = [ROLE, MESSAGE_ROLE, FALLBACK, UNIT, CARRIER, BODY].join(",");
  const OWN = "[data-cgf-control]";
  const STOP = [
    'button[data-testid="stop-button"]',
    'button[data-testid="stop-generating-button"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="Stop streaming"]',
    'button[aria-label="停止生成"]',
    'button[aria-label="停止生成回复"]',
    'form[data-chatgpt-composer] button[aria-label="Stop"]',
    'form[data-chatgpt-composer] button[aria-label="停止"]'
  ].join(",");
  // The modern turn can own the generation signal while its answer root/ID
  // changes. Match a known positive state, never every non-complete value.
  // streamingElements still requires an active, unambiguous answer owner.
  const STREAMING = '[data-is-streaming="true"], [aria-busy="true"], .result-streaming, [data-talvt-turn-state="in_progress"]';

  function createScanContext() {
    // A scan owns these caches. Never retain visibility decisions across updates.
    return { reasons: new WeakMap(), hidden: new WeakMap() };
  }

  function inactive(element, context = createScanContext()) {
    if (!element || element.nodeType !== 1) return false;
    if (context.hidden.has(element)) return context.hidden.get(element);
    let hidden = element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true" ||
      element.matches('[data-app-action-timeline-scroll][role="presentation"]') || inactive(element.parentElement, context);
    if (!hidden) {
      const view = element.ownerDocument?.defaultView;
      const style = typeof view?.getComputedStyle === "function" ? view.getComputedStyle(element) : element.style;
      hidden = style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse";
    }
    // display:contents and off-screen content are valid: do not measure boxes.
    context.hidden.set(element, hidden);
    return hidden;
  }

  function collect(scope, context = createScanContext()) {
    if (!scope || !scope.querySelectorAll) return [];
    const found = [];
    if (scope.nodeType === 1 && scope.matches(CANDIDATE)) found.push(scope);
    found.push(...scope.querySelectorAll(CANDIDATE));
    return found.filter(element => isAssistant(element, context));
  }

  function singleMessageIdentity(element) {
    const selectionId = element.getAttribute("data-chatgpt-selection-message-id");
    if (selectionId && (selectionId.length > 160 || /\s/.test(selectionId))) return null;
    const ids = element.getAttribute("data-chatgpt-search-message-ids");
    if (!ids || !ids.trim()) return selectionId || null;
    if (ids.length > 512) return null;
    const unique = new Set(ids.trim().split(/\s+/).filter(Boolean));
    if (unique.size !== 1) return null;
    const id = unique.values().next().value;
    return selectionId && selectionId !== id ? null : id;
  }

  function consistentCarrier(element) {
    const id = singleMessageIdentity(element);
    if (!id) return false;
    for (const child of element.querySelectorAll(CARRIER)) {
      const hasIdentity = child.getAttribute("data-chatgpt-selection-message-id")?.trim() ||
        child.getAttribute("data-chatgpt-search-message-ids")?.trim();
      if (hasIdentity && singleMessageIdentity(child) !== id) return false;
    }
    return true;
  }

  function unambiguousBody(element) {
    const boundary = [CARRIER, TURN, ROLE_CONTEXT].join(",");
    const owner = element.parentElement?.closest(boundary);
    if (!owner) return false;
    let fragments = 0;
    for (const body of owner.querySelectorAll(BODY)) {
      const outerBody = body.parentElement?.closest(BODY);
      if (outerBody && owner.contains(outerBody)) continue;
      if (body.parentElement?.closest(boundary) === owner) fragments += 1;
      if (fragments > 1) return false;
    }
    // Without an explicit unit or a consistent ID carrier, do not turn pieces
    // of one answer into separate records and hide all but its last fragment.
    return fragments === 1;
  }

  function identity(element) {
    // Message identities can live below the outer assistant unit. Repeated
    // copies of one ID agree; conflicts must not fall back to a positional key.
    const ids = new Set();
    function read(node) {
      const legacy = node.getAttribute("data-message-id");
      if (legacy) {
        if (legacy.length > 160 || /\s/.test(legacy)) return false;
        ids.add(legacy);
      }
      if (node.getAttribute("data-chatgpt-search-message-ids")?.trim() ||
          node.getAttribute("data-chatgpt-selection-message-id")?.trim()) {
        const id = singleMessageIdentity(node);
        if (!id || id.length > 160) return false;
        ids.add(id);
      }
      return ids.size <= 1;
    }
    if (!read(element)) return null;
    for (const child of element.querySelectorAll('[data-message-id], ' + CARRIER)) {
      if (!child.closest(OWN) && !read(child)) return null;
    }
    if (!ids.size) {
      const parent = element.parentElement?.closest(CARRIER);
      if (parent && !parent.closest(USER) && !parent.querySelector(USER) && !read(parent)) return null;
    }
    if (ids.size === 1) return `message:${ids.values().next().value}`;
    // A legacy turn ID can still anchor append discovery. It is deliberately
    // separate from a message identity and is not used for remembered openings.
    const turn = element.closest('[data-turn="assistant"][data-turn-id]');
    const turnId = turn?.getAttribute("data-turn-id");
    return turnId && turnId.length <= 160 && !/\s/.test(turnId) ? `turn:${turnId}` : null;
  }

  function identityHint(element) {
    // Volatile evidence for the SAME live node only, never a history key. Unit
    // positions may be reused for another answer when the page window changes.
    const values = UNIT_ATTRIBUTES.map(name => element.getAttribute(name) || "");
    values.push(element.closest('[data-turn="assistant"][data-turn-id]')?.getAttribute("data-turn-id") || "");
    values.push(element.closest("[data-turn-key]")?.getAttribute("data-turn-key") || "");
    return values.some(value => value.length > 512) ? null : JSON.stringify(values);
  }

  function ownRole(element) {
    let role = null;
    for (const name of ["data-message-author-role", "data-message-role"]) {
      if (!element.hasAttribute(name)) continue;
      if (element.getAttribute(name) !== "assistant") return "blocked";
      role = "assistant";
    }
    for (const name of UNIT_ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (!value) continue;
      if (/:(user|system|tool|developer)$/.test(value)) return "blocked";
      if (value.endsWith(":assistant")) role = "assistant";
    }
    return role;
  }

  function baseReason(element, context) {
    if (context.reasons.has(element)) return context.reasons.get(element);
    let reason = "";
    const role = ownRole(element);
    if (role === "blocked") reason = "conflicting-role";
    else if (role !== "assistant") {
      if (element.matches(FALLBACK)) {
        if (element.querySelector(ROLE_CONTEXT)) reason = "fallback-suppressed";
      } else if (element.matches(CARRIER)) {
        if (element.querySelector(ROLE_CONTEXT)) reason = "fallback-suppressed";
        else if (!consistentCarrier(element) || !(element.matches(BODY) || element.querySelector(BODY))) reason = "not-candidate";
      } else if (element.matches(BODY)) {
        const strongerChild = element.querySelector(ROLE_CONTEXT) ||
          Array.from(element.querySelectorAll(CARRIER)).some(child => !baseReason(child, context));
        if (strongerChild) reason = "fallback-suppressed";
        else if (!unambiguousBody(element)) reason = "not-candidate";
      } else reason = "not-candidate";
    }
    if (!reason && (element.closest(USER) || element.querySelector(USER))) reason = "conflicting-role";
    if (!reason) {
      for (let parent = element.parentElement?.closest(ROLE_CONTEXT); parent; parent = parent.parentElement?.closest(ROLE_CONTEXT)) {
        if (ownRole(parent) === "blocked") { reason = "nested"; break; }
      }
    }
    if (!reason && inactive(element, context)) reason = "inactive-context";
    context.reasons.set(element, reason);
    return reason;
  }

  function rejectionReason(element, context = createScanContext()) {
    const reason = baseReason(element, context);
    if (reason) return reason;
    for (let parent = element.parentElement?.closest(CANDIDATE); parent; parent = parent.parentElement?.closest(CANDIDATE)) {
      if (!baseReason(parent, context)) return "nested";
    }
    return "";
  }

  function isAssistant(element, context = createScanContext()) {
    return !rejectionReason(element, context);
  }

  function scanRoot(element) {
    // An ID carrier may take over when its explicit unit role disappears.
    // A shared modern turn is only a boundary, never an inferred answer root.
    let scope = element;
    for (let parent = element.parentElement?.closest(CANDIDATE); parent; parent = parent.parentElement?.closest(CANDIDATE)) {
      scope = parent;
    }
    return scope;
  }

  function diagnostics(doc) {
    // On-demand counts only. Do not export text, HTML, paths, IDs, class names,
    // unknown attribute values or other potentially user-controlled strings.
    const count = selector => doc.querySelectorAll(selector).length;
    function roleCounts(attribute) {
      const counts = { assistant: 0, user: 0, system: 0, tool: 0, developer: 0, empty: 0, other: 0 };
      for (const element of doc.querySelectorAll(`[${attribute}]`)) {
        const value = element.getAttribute(attribute);
        const key = value === "" ? "empty" : ["assistant", "user", "system", "tool", "developer"].includes(value) ? value : "other";
        counts[key] += 1;
      }
      return counts;
    }
    const result = {
      rawAssistantRoleCount: count(ROLE),
      rawAssistantTurnCount: count(FALLBACK),
      nonArticleAssistantTurnCount: count(FALLBACK + ":not(article)"),
      eligibleAnswerCount: 0,
      nestedRejectedCount: 0,
      fallbackSuppressedCount: 0,
      conflictingRoleCount: 0,
      roleCounts: roleCounts("data-message-author-role"),
      turnCounts: roleCounts("data-turn"),
      conversationTurnCount: count('[data-testid^="conversation-turn-"]'),
      messageIdElementCount: count("[data-message-id]"),
      articleCount: count("article"),
      mainCount: count('main, [role="main"]'),
      iframeCount: count("iframe")
    };
    result.modern = {
      messageRoleAssistantCount: count(MESSAGE_ROLE),
      searchUnitAssistantCount: count('[data-chatgpt-search-unit-key$=":assistant"]'),
      contentUnitAssistantCount: count('[data-content-search-unit-key$=":assistant"]'),
      assistantBodyCount: count(BODY),
      searchMessageContainerCount: count("[data-chatgpt-search-message-ids]"),
      selectionMessageContainerCount: count("[data-chatgpt-selection-message-id]"),
      userBubbleCount: count('[data-user-message-bubble="true"]'),
      turnContainerCount: count("[data-turn-key]"),
      inactiveCandidateCount: 0
    };
    const context = createScanContext();
    for (const element of doc.querySelectorAll(CANDIDATE)) {
      const reason = rejectionReason(element, context);
      if (!reason) result.eligibleAnswerCount += 1;
      else if (reason === "nested") result.nestedRejectedCount += 1;
      else if (reason === "fallback-suppressed") result.fallbackSuppressedCount += 1;
      else if (reason === "conflicting-role") result.conflictingRoleCount += 1;
      else if (reason === "inactive-context") result.modern.inactiveCandidateCount += 1;
    }
    return result;
  }

  function hasDirectText(element) {
    // CSS can hide element children without moving them. It cannot selectively
    // hide a bare text node, so that unfamiliar shape is intentionally fail-open.
    return Array.from(element.childNodes).some(node => node.nodeType === 3 && node.data.trim());
  }

  function preview(element) {
    const doc = element.ownerDocument;
    const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || parent.closest(OWN + ', script, style, button, svg, textarea, [aria-hidden="true"]')) {
          return NodeFilter.FILTER_REJECT;
        }
        return node.data.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    let text = "";
    let count = 0;
    let node;
    // Bounded extraction: never copy the full answer / HTML to make a preview.
    while (text.length < 180 && count < 40 && (node = walker.nextNode())) {
      text += " " + node.data.slice(0, 180 - text.length);
      count += 1;
    }
    return root.CGFShared.compactPreview(text) || "图片、附件或尚无文字的回答";
  }

  function hasVisibleStop(doc) {
    const context = createScanContext();
    return Array.from(doc.querySelectorAll(STOP)).some(button => !inactive(button, context));
  }

  function streamingElements(doc, recordMap) {
    const active = new Set();
    const context = createScanContext();
    const ownedMarkers = new Map();
    for (const marker of doc.querySelectorAll(STREAMING)) {
      if (marker.closest(OWN)) continue;
      const owner = marker.closest("[data-cgf-message]");
      if (owner && recordMap.has(owner)) {
        if (!ownedMarkers.has(owner)) ownedMarkers.set(owner, []);
        ownedMarkers.get(owner).push(marker);
      } else if (!inactive(marker, context)) {
        // A global loading/busy container must never reopen the entire history.
        // An external marker is useful only when it identifies a single answer.
        const children = marker.querySelectorAll("[data-cgf-message]");
        if (children.length === 1 && recordMap.has(children[0])) active.add(children[0]);
      }
    }
    for (const [owner, markers] of ownedMarkers) {
      if (inactive(owner, context)) continue;
      const folded = owner.getAttribute("data-cgf-collapsed") === "true";
      // Our display:none rule can hide a genuine generation marker. Probe only
      // this marked answer's native visibility, restoring the fold in the same
      // synchronous call (before any paint). A fresh context still respects the
      // site's own hidden/class/style/timeline rules, including on direct children.
      if (folded) owner.removeAttribute("data-cgf-collapsed");
      try {
        const visibleContext = folded ? createScanContext() : context;
        if (markers.some(marker => !inactive(marker, visibleContext))) active.add(owner);
      } finally {
        if (folded) owner.setAttribute("data-cgf-collapsed", "true");
      }
    }
    return active;
  }

  root.CGFAdapter = Object.freeze({ ROLE, FALLBACK, CANDIDATE, USER, OWN, STOP, STREAMING, collect, scanRoot, diagnostics, identity, identityHint, isAssistant, inactive, createScanContext, hasDirectText, preview, hasVisibleStop, streamingElements });
})(globalThis);
