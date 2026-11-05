// Paste in the top ChatGPT DevTools Console after selecting one completed answer.
// Passive observation only. DevTools itself may retain $0: this is not a GC test.
(() => {
  "use strict";
  const API = "__CGF_NATIVE_PROBE_V1__", OUT = "__CGF_NATIVE_REPORT_V1__";
  if (globalThis[API]) { console.warn("CGF 探针已运行；请先调用 __CGF_NATIVE_PROBE_V1__.stop()。"); return; }
  const ROLE = '[data-message-author-role="assistant"], [data-message-role="assistant"], [data-turn="assistant"], [data-chatgpt-search-unit-key$=":assistant"], [data-content-search-unit-key$=":assistant"]';
  const USER = '[data-message-author-role="user"], [data-message-role="user"], [data-turn="user"], [data-user-message-bubble="true"], [data-chatgpt-search-unit-key$=":user"], [data-content-search-unit-key$=":user"]';
  const BODY = '[data-markdown-text-style="assistant-message"]';
  const IDS = '[data-message-id], [data-chatgpt-selection-message-id], [data-chatgpt-search-message-ids]';
  const TURN = '[data-turn-key], [data-content-search-turn-key], [data-talvt-turn-state]';
  const STOP = 'button[data-testid="stop-button"], button[data-testid="stop-generating-button"], button[aria-label="Stop generating"], button[aria-label="Stop streaming"], button[aria-label="停止生成"], button[aria-label="停止生成回复"], form button[aria-label="Stop"], form button[aria-label="停止"]';
  const GENERATING = '[data-is-streaming="true"], [aria-busy="true"], .result-streaming, [data-talvt-turn-state="in_progress"]';
  const phases = new Set(["baseline", "folded", "unfolded", "away", "returned"]);
  const limits = { durationMs: 90000, snapshots: 120, ancestorRefs: 6, identityLength: 160, matchCandidates: 64 };
  const report = { schemaVersion: 1, probeVersion: "0.2.0-probe.1", outcome: "running", reason: null,
    limits, truncated: false, observations: [],
    summary: { detachedObserved: false, reappearedWithNewRoot: false, stableAncestorObserved: false,
      nativeMountEntry: "not-tested", reactUnmount: "not-proven", memoryBenefit: "not-measured", devtoolsMayRetainSelection: true } };
  const counts = { mutationBatches: 0, scrollEvents: 0, trustedWheelEvents: 0, trustedTouchEvents: 0 };
  let running = false, finalJSON = null, identityKey = null, route = null;
  let originalRef = null, originalBodyRef = null, bodyRef = null, ancestors = [];
  let observer = null, timer = null, deadline = null, pendingPhase = "mutation", lastSample = -Infinity;
  const started = performance.now(), listeners = [];

  function visible(node) {
    if (!node?.isConnected) return false;
    for (let depth = 0; node && depth < 64; depth += 1, node = node.parentElement) {
      if (node.hidden || node.getAttribute("aria-hidden") === "true" ||
          node.matches('[data-app-action-timeline-scroll][role="presentation"]')) return false;
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    }
    return !node;
  }

  function identity(root) {
    let id = null;
    const carriers = root.querySelectorAll(IDS);
    if (carriers.length > limits.matchCandidates) return null;
    for (const node of [root, ...carriers]) {
      if (node.closest("[data-cgf-control]")) continue;
      for (const name of ["data-message-id", "data-chatgpt-selection-message-id", "data-chatgpt-search-message-ids"]) {
        const value = node.getAttribute(name);
        if (!value) continue;
        if (value.length > 512) return null;
        const values = name === "data-chatgpt-search-message-ids" ? value.trim().split(/\s+/) : [value];
        for (const item of values) {
          if (!item || item.length > limits.identityLength || /\s/.test(item) || (id !== null && id !== item)) return null;
          id = item;
        }
      }
    }
    return id;
  }

  function resolve(node, allowEmpty = false) {
    if (!(node instanceof Element) || node.closest(USER)) return null;
    let root = node.closest(ROLE);
    const explicitRole = Boolean(root);
    if (!root) {
      root = node.matches(IDS) && (node.matches(BODY) || node.querySelector(BODY)) ? node : node.closest(BODY)?.closest(IDS) || null;
      // Do not promote an ID carrier around separately identified answers.
      if (root?.querySelector(ROLE)) return null;
    }
    if (!root || root.closest(USER) || root.querySelector(USER)) return null;
    // Use native author boundaries, not a position, an extension record, or prose.
    for (let depth = 0; depth < 12; depth += 1) {
      const parent = root.parentElement?.closest(ROLE);
      if (!parent || parent.closest(USER) || parent.querySelector(USER) || !identity(parent)) break;
      root = parent;
    }
    if (!(allowEmpty && explicitRole) && !root.matches(BODY) && !root.querySelector(BODY)) return null;
    return root;
  }

  function state(root) {
    const value = root?.closest("[data-talvt-turn-state]")?.getAttribute("data-talvt-turn-state");
    return value === "complete" || value === "in_progress" ? value : "unknown";
  }

  function generating() {
    const signals = document.querySelectorAll(STOP + "," + GENERATING);
    if (signals.length > limits.matchCandidates) return true;
    return Array.from(signals).some(visible);
  }

  function findCurrent() {
    const escaped = CSS.escape(identityKey);
    const matches = document.querySelectorAll(`[data-message-id="${escaped}"], [data-chatgpt-selection-message-id="${escaped}"], [data-chatgpt-search-message-ids~="${escaped}"]`);
    if (matches.length > limits.matchCandidates) throw new Error("identity_ambiguous");
    let found = null;
    for (const node of matches) {
      let root = resolve(node, true);
      const original = originalRef?.deref();
      // A known native carrier can keep its identity after only its body is
      // removed. An unfamiliar empty ID carrier is not evidence of an author.
      if (!root && original?.isConnected && original.contains(node) &&
          !original.closest(USER) && !original.querySelector(USER) && identity(original) === identityKey) root = original;
      if (!root || !visible(root) || identity(root) !== identityKey) continue;
      if (found && found !== root) throw new Error("identity_ambiguous");
      found = root;
    }
    return found;
  }

  function finish(outcome, reason) {
    if (finalJSON !== null) return finalJSON;
    running = false;
    observer?.disconnect(); observer = null;
    clearTimeout(timer); clearTimeout(deadline); timer = deadline = null;
    for (const [target, type, listener, capture] of listeners) target.removeEventListener(type, listener, capture);
    listeners.length = 0;
    identityKey = route = null;
    originalRef = originalBodyRef = bodyRef = null;
    ancestors.length = 0;
    report.outcome = outcome; report.reason = reason;
    report.eventCounts = { ...counts };
    finalJSON = JSON.stringify(report, null, 2);
    globalThis[OUT] = finalJSON;
    delete globalThis[API];
    console.info("CGF 观察结束；复制报告：copy(__CGF_NATIVE_REPORT_V1__)");
    console.log(finalJSON);
    return finalJSON;
  }

  function guard() {
    if (location.pathname !== route) return "route_changed";
    if (bodyRef.deref() !== document.body) return "body_changed";
    if (document.visibilityState !== "visible") return "page_hidden";
    if (generating()) return "generation_active";
    const original = originalRef.deref();
    if (original?.isConnected) {
      const id = identity(original);
      if (id !== null && id !== identityKey) return "identity_changed";
    }
    return null;
  }

  function sample(phase) {
    if (!running) return finalJSON;
    try {
      const reason = guard();
      if (reason) return finish("aborted", reason);
      if (report.observations.length >= limits.snapshots) {
        report.truncated = true; return finish("stopped", "snapshot_limit");
      }
      const root = findCurrent(), original = originalRef.deref(), originalBody = originalBodyRef.deref();
      if (root && state(root) !== "complete") return finish("aborted", "completion_unconfirmed");
      const body = root?.matches(BODY) ? root : root?.querySelector(BODY);
      const rect = root?.getBoundingClientRect();
      const fold = root?.closest("[data-cgf-message]") || root?.querySelector("[data-cgf-message]");
      const ancestorStates = ancestors.map((item, index) => {
        const node = item.ref.deref();
        if (original && !original.isConnected && node?.isConnected) item.survivedDetach = true;
        const contains = Boolean(node?.isConnected && root && node.contains(root));
        if (contains && item.survivedDetach) report.summary.stableAncestorObserved = true;
        return { level: index + 1, kind: item.kind, connected: node ? node.isConnected : null, containsCurrentAnswer: contains };
      });
      const observation = { phase, elapsedMs: Math.round(performance.now() - started), targetPresent: Boolean(root),
        sameAnswerNode: root && original ? root === original : null,
        originalAnswerConnected: original ? original.isConnected : null,
        originalBodyConnected: originalBody ? originalBody.isConnected : null,
        bodyPresent: Boolean(body), bodyConnected: Boolean(body?.isConnected),
        extensionFolded: fold ? fold.getAttribute("data-cgf-collapsed") === "true" : false,
        inViewport: rect ? rect.height > 0 && rect.width > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth : false,
        generationState: state(root), ancestorStates, eventCounts: { ...counts } };
      if (original && !original.isConnected) report.summary.detachedObserved = true;
      if (root && original && root !== original && report.summary.detachedObserved) report.summary.reappearedWithNewRoot = true;
      report.observations.push(observation); lastSample = performance.now();
      if (report.observations.length >= limits.snapshots) {
        report.truncated = true; return finish("stopped", "snapshot_limit");
      }
      return JSON.stringify(observation);
    } catch (error) {
      return finish("aborted", error.message === "identity_ambiguous" ? "identity_ambiguous" : "probe_error");
    }
  }

  function schedule(phase) {
    if (!running) return;
    // No MutationRecord, removedNodes list, event, or DOM root crosses this timer.
    pendingPhase = phase;
    if (timer !== null) return;
    timer = setTimeout(() => { timer = null; sample(pendingPhase); }, Math.max(0, 250 - (performance.now() - lastSample)));
  }

  function listen(target, type, callback, options = false) {
    target.addEventListener(type, callback, options);
    listeners.push([target, type, callback, typeof options === "object" ? Boolean(options.capture) : options]);
  }

  try {
    if (location.protocol !== "https:" || location.hostname !== "chatgpt.com" ||
        !/^\/(?:c\/[^/]+|g\/[^/]+\/c\/[^/]+)\/?$/.test(location.pathname)) return finish("rejected", "wrong_page");
    if (window.top !== window) return finish("rejected", "not_top_frame");
    if (typeof WeakRef !== "function" || typeof CSS?.escape !== "function" || !document.body) return finish("rejected", "unsupported_environment");
    let selected = typeof $0 === "undefined" ? null : $0;
    if (!selected) return finish("rejected", "no_selection");
    let root = resolve(selected.nodeType === 1 ? selected : selected.parentElement);
    selected = null;
    if (!root?.isConnected) return finish("rejected", "not_assistant");
    if (!visible(root)) return finish("rejected", "inactive_selection");
    identityKey = identity(root);
    if (!identityKey) return finish("rejected", "identity_unavailable");
    if (generating()) return finish("rejected", "generation_active");
    if (state(root) !== "complete") return finish("rejected", "completion_unconfirmed");
    originalRef = new WeakRef(root);
    let body = root.matches(BODY) ? root : root.querySelector(BODY);
    originalBodyRef = new WeakRef(body); body = null;
    let parent = root.parentElement;
    while (parent && parent !== document.body && parent !== document.documentElement && ancestors.length < limits.ancestorRefs) {
      ancestors.push({ ref: new WeakRef(parent), kind: parent.matches(TURN) ? "turn" : parent.matches(IDS) ? "message" : "generic", survivedDetach: false });
      parent = parent.parentElement;
    }
    parent = root = null;
    bodyRef = new WeakRef(document.body); route = location.pathname;
    if (!findCurrent()) return finish("rejected", "not_assistant");
    running = true;
    globalThis[API] = {
      mark(phase) {
        if (!phases.has(phase)) throw new RangeError("Unknown probe phase");
        return sample(phase);
      },
      stop() { return finish("stopped", "manual_stop"); }
    };
    observer = new MutationObserver(() => {
      if (!running) return;
      counts.mutationBatches += 1;
      if (location.pathname !== route) { finish("aborted", "route_changed"); return; }
      if (bodyRef.deref() !== document.body) { finish("aborted", "body_changed"); return; }
      schedule("mutation");
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
      attributeFilter: ["data-message-id", "data-chatgpt-selection-message-id", "data-chatgpt-search-message-ids",
        "data-talvt-turn-state", "data-is-streaming", "aria-label", "hidden", "aria-hidden", "data-cgf-collapsed",
        "class", "style", "role", "data-testid", "aria-busy"] });
    listen(document, "scroll", () => { counts.scrollEvents += 1; schedule("scroll"); }, { capture: true, passive: true });
    listen(document, "wheel", event => { if (event.isTrusted) counts.trustedWheelEvents += 1; }, { capture: true, passive: true });
    listen(document, "touchmove", event => { if (event.isTrusted) counts.trustedTouchEvents += 1; }, { capture: true, passive: true });
    const navigationChanged = () => { if (running && location.pathname !== route) finish("aborted", "route_changed"); };
    listen(window, "popstate", navigationChanged); listen(window, "hashchange", navigationChanged);
    if (window.navigation) listen(window.navigation, "navigatesuccess", navigationChanged);
    listen(window, "pagehide", () => finish("aborted", "pagehide"));
    listen(document, "visibilitychange", () => { if (document.visibilityState !== "visible") finish("aborted", "page_hidden"); });
    deadline = setTimeout(() => finish("stopped", "deadline"), limits.durationMs);
    sample("initial");
    if (running) console.info("CGF 被动观察已开始。手动滚动；可 mark('away') / mark('returned')，结束调用 __CGF_NATIVE_PROBE_V1__.stop()。不测 GC，也不调用原生挂载入口。");
  } catch (error) {
    finish(running ? "aborted" : "rejected", error.message === "identity_ambiguous" ? "identity_ambiguous" : "probe_error");
  }
})();
