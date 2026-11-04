/* Keep site-specific assumptions here. Unknown markup stays visible. */
(function (root) {
  "use strict";
  const ROLE = '[data-message-author-role="assistant"]';
  const FALLBACK = 'article[data-turn="assistant"]';
  const OWN = "[data-cgf-control]";
  const STOP = [
    'button[data-testid="stop-button"]',
    'button[data-testid="stop-generating-button"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="Stop streaming"]',
    'button[aria-label="停止生成"]',
    'button[aria-label="停止生成回复"]'
  ].join(",");
  const STREAMING = '[data-is-streaming="true"], [aria-busy="true"], .result-streaming';

  function collect(scope) {
    if (!scope || !scope.querySelectorAll) return [];
    const found = [];
    if (scope.nodeType === 1 && scope.matches(ROLE)) found.push(scope);
    found.push(...scope.querySelectorAll(ROLE));
    const fallback = [];
    if (scope.nodeType === 1 && scope.matches(FALLBACK)) fallback.push(scope);
    fallback.push(...scope.querySelectorAll(FALLBACK));
    for (const element of fallback) {
      if (!element.hasAttribute("data-message-author-role") && !element.querySelector("[data-message-author-role]")) found.push(element);
    }
    return [...new Set(found)].filter(isAssistant);
  }

  function identity(element) {
    return element.getAttribute("data-message-id") ||
      element.getAttribute("data-turn-id") ||
      element.closest("[data-turn-id]")?.getAttribute("data-turn-id") || null;
  }

  function isAssistant(element) {
    if (element.hasAttribute("data-message-author-role")) {
      if (!element.matches(ROLE)) return false;
    } else if (!element.matches(FALLBACK) || element.querySelector("[data-message-author-role]")) {
      return false;
    }
    if (element.parentElement?.closest("[data-message-author-role]")) return false;
    for (let parent = element.parentElement?.closest(FALLBACK); parent; parent = parent.parentElement?.closest(FALLBACK)) {
      if (!parent.hasAttribute("data-message-author-role") && !parent.querySelector("[data-message-author-role]")) return false;
    }
    return true;
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

  function streamingElements(doc, recordMap, ordered) {
    const active = new Set();
    if (doc.querySelector(STOP) && ordered.length) active.add(ordered[ordered.length - 1].element);
    for (const marker of doc.querySelectorAll(STREAMING)) {
      if (marker.closest(OWN)) continue;
      const owner = marker.closest("[data-cgf-message]");
      if (owner && recordMap.has(owner)) active.add(owner);
      else {
        // A global loading/busy container must never reopen the entire history.
        // An external marker is useful only when it identifies a single answer.
        const children = marker.querySelectorAll("[data-cgf-message]");
        if (children.length === 1 && recordMap.has(children[0])) active.add(children[0]);
      }
    }
    return active;
  }

  root.CGFAdapter = Object.freeze({ ROLE, FALLBACK, OWN, collect, identity, isAssistant, hasDirectText, preview, streamingElements });
})(globalThis);
