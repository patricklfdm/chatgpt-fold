// Paste once into the top Console, with a completed folded answer in view.
// Temporarily bypasses only Fold's CSS gate; the extension keeps running.
// No native controller calls, chat text, network requests, storage, or forced GC.
(() => {
  "use strict";
  const API = "__CGF_FOLD_WINDOW_PROBE_V1__", OUT = "__CGF_FOLD_WINDOW_REPORT_V1__";
  if (globalThis[API]) { console.warn("CGF 对照正在运行；停止：__CGF_FOLD_WINDOW_PROBE_V1__.stop()"); return; }
  const GATE = "data-cgf-active", OWN = "[data-cgf-control]", ANSWER = "[data-cgf-message]";
  const TURN = "[data-turn-key]", BODY = '[data-markdown-text-style="assistant-message"]';
  const STOP = 'button[data-testid="stop-button"],button[data-testid="stop-generating-button"],button[aria-label="Stop generating"],button[aria-label="Stop streaming"],button[aria-label="停止生成"],button[aria-label="停止生成回复"],form button[aria-label="Stop"],form button[aria-label="停止"]';
  const GENERATING = '[data-talvt-turn-state="in_progress"],[data-is-streaming="true"],.result-streaming,[aria-busy="true"]';
  const LIMITS = { durationMs: 90000, elements: 50000, nativeElements: 30000,
    answers: 64, turns: 128, identityLength: 192, ancestorDepth: 64, phases: 3, samplesPerPhase: 3 };
  const TIMING = { settleMs: 6000, sampleMs: 1500, pollMs: 250, anchorWaitMs: 2500 };
  const PHASES = ["A_folded", "B_css_bypassed", "A_restored"];
  const report = { schemaVersion: 1, probeVersion: "0.2.0-fold-window.1", outcome: "running", reason: null,
    browser: navigator.userAgent.match(/(?:Chrome|Chromium)\/[\d.]+/)?.[0] || "unknown",
    extensionVersion: "not-observable-from-page-world", limits: LIMITS, timing: TIMING, phases: [],
    measurement: { comparison: "within-page-css-gate-switch", extensionController: "running-in-both-conditions",
      tabTotalMemory: "not-measured", jsHeap: "performance.memory estimate only; incomplete and possibly stale",
      gc: "not-forced", netMemoryBenefit: "not-established", nativeController: "not-called",
      data: "counts and geometry only; no text, identities, title or URL in report",
      caveat: "Same-page switch response; native range hysteresis and cache history are not reset." },
    cleanup: { gate: "not-modified", scroll: "not-modified", resourcesReleased: false } };
  const started = performance.now(), listeners = [];
  const sentinel = "cgf-window-probe-" + Math.random().toString(36).slice(2, 12);
  let running = false, finished = false, phaseName = null, expectedGate = "true", changedGate = false;
  let htmlRef = null, bodyRef = null, scrollerRef = null, anchorKey = null, route = null;
  let originalOffset = 0, originalScrollTop = 0, viewport = null;
  let observer = null, deadline = null, timer = null, wake = null;
  let mutationBatches = 0, alignments = 0, interacted = false;

  function fail(reason) { throw new Error(reason); }
  const reasons = new Set(["wrong_page", "not_top_frame", "unsupported_environment", "extension_not_active",
    "no_visible_folded_answer", "ambiguous_anchor", "anchor_lost", "anchor_fold_changed", "completion_unconfirmed",
    "alignment_failed", "generation_active", "route_changed", "body_changed", "scroller_changed", "page_hidden",
    "viewport_changed", "external_gate_change", "fold_policy_changed", "answer_content_changed", "element_limit",
    "answer_limit", "turn_limit", "native_element_limit", "css_exposure_unconfirmed", "user_interaction", "pagehide", "deadline", "manual_stop"]);

  function routeValue() { return location.pathname + location.search + location.hash; }
  function active(node) {
    if (!node?.isConnected) return false;
    let depth = 0;
    for (; node && depth < LIMITS.ancestorDepth; node = node.parentElement, depth += 1) {
      if (node.hidden || node.getAttribute("aria-hidden") === "true" ||
          node.matches('[data-app-action-timeline-scroll][role="presentation"]')) return false;
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    }
    return !node;
  }
  function generationActive() {
    const nodes = document.querySelectorAll(STOP + "," + GENERATING);
    if (nodes.length > LIMITS.turns) return true;
    return Array.from(nodes).some(active);
  }
  function scrollerFor(node) {
    for (let depth = 0; node && depth < LIMITS.ancestorDepth; node = node.parentElement, depth += 1) {
      if (node === document.body || node === document.documentElement) break;
      if (/^(auto|scroll)$/.test(getComputedStyle(node).overflowY) && node.clientHeight > 0 &&
          node.scrollHeight > node.clientHeight + 2) return node;
    }
    return document.scrollingElement;
  }
  function scrollBox(node) {
    if (node === document.scrollingElement) return { top: 0, left: 0, width: innerWidth, height: innerHeight };
    const r = node.getBoundingClientRect();
    return { top: r.top + node.clientTop, left: r.left + node.clientLeft, width: node.clientWidth, height: node.clientHeight };
  }
  function outerTurns(scope) {
    const nodes = scope.querySelectorAll(TURN);
    if (nodes.length > LIMITS.turns) fail("turn_limit");
    return Array.from(nodes).filter(node => {
      const parent = node.parentElement?.closest(TURN);
      return (!parent || !scope.contains(parent)) && active(node);
    });
  }
  function answerFor(turn) {
    const roots = turn.querySelectorAll(ANSWER);
    if (roots.length !== 1) fail("ambiguous_anchor");
    const root = roots[0];
    if (root.getAttribute("data-cgf-collapsed") !== "true") fail("anchor_fold_changed");
    const state = root.closest("[data-talvt-turn-state]")?.getAttribute("data-talvt-turn-state");
    if (state !== "complete") fail("completion_unconfirmed");
    if (!root.querySelector(BODY) || !root.querySelector(OWN)) fail("anchor_lost");
    return root;
  }
  function findAnchor() {
    const scope = scrollerRef?.deref();
    if (!scope?.isConnected) fail("scroller_changed");
    let found = null;
    for (const turn of outerTurns(scope)) {
      if (turn.getAttribute("data-turn-key") !== anchorKey) continue;
      if (found) fail("ambiguous_anchor");
      found = turn;
    }
    if (found) {
      if (scrollerFor(found.parentElement) !== scope) fail("scroller_changed");
      answerFor(found);
    }
    return found;
  }
  function chooseAnchor() {
    const roots = document.querySelectorAll(ANSWER);
    if (roots.length > LIMITS.answers) fail("answer_limit");
    let best = null, score = Infinity;
    for (const root of roots) {
      if (root.getAttribute("data-cgf-collapsed") !== "true" || !active(root)) continue;
      const turn = root.closest(TURN), control = root.querySelector(OWN);
      const key = turn?.getAttribute("data-turn-key");
      if (!key || key.length > LIMITS.identityLength || !control) continue;
      if (root.closest("[data-talvt-turn-state]")?.getAttribute("data-talvt-turn-state") !== "complete") continue;
      const scope = scrollerFor(turn.parentElement), box = scrollBox(scope), rect = control.getBoundingClientRect();
      const top = Math.max(0, box.top), bottom = Math.min(innerHeight, box.top + box.height);
      if (rect.width <= 0 || rect.height <= 0 || rect.top < top || rect.bottom > bottom ||
          rect.right <= 0 || rect.left >= innerWidth) continue;
      const distance = Math.abs(rect.top - top - 60);
      if (distance < score) { best = { turn, scope, key, box }; score = distance; }
    }
    if (!best) fail("no_visible_folded_answer");
    answerFor(best.turn);
    scrollerRef = new WeakRef(best.scope); anchorKey = best.key;
    originalOffset = best.turn.getBoundingClientRect().top - best.box.top;
    originalScrollTop = best.scope.scrollTop;
    viewport = { width: innerWidth, height: innerHeight, scopeWidth: best.box.width, scopeHeight: best.box.height };
    if (!findAnchor()) fail("anchor_lost");
  }
  function guard() {
    if (routeValue() !== route) fail("route_changed");
    if (htmlRef?.deref() !== document.documentElement || bodyRef?.deref() !== document.body) fail("body_changed");
    if (document.visibilityState !== "visible") fail("page_hidden");
    if (document.documentElement.getAttribute(GATE) !== expectedGate) fail("external_gate_change");
    const scope = scrollerRef?.deref();
    if (!scope?.isConnected) fail("scroller_changed");
    const box = scrollBox(scope);
    if (innerWidth !== viewport.width || innerHeight !== viewport.height ||
        Math.abs(box.width - viewport.scopeWidth) > 2 || Math.abs(box.height - viewport.scopeHeight) > 2) fail("viewport_changed");
    if (document.getElementsByTagName("*").length > LIMITS.elements) fail("element_limit");
    if (generationActive()) fail("generation_active");
  }
  function wait(ms) {
    if (!running) return Promise.resolve();
    return new Promise(resolve => {
      wake = resolve;
      timer = setTimeout(() => { timer = null; wake = null; resolve(); }, ms);
    });
  }
  function alignOnce() {
    const anchor = findAnchor();
    if (!anchor) return false;
    const scope = scrollerRef.deref(), error = anchor.getBoundingClientRect().top - scrollBox(scope).top - originalOffset;
    if (Math.abs(error) <= 2) return true;
    scope.scrollTo({ top: scope.scrollTop + error, behavior: "instant" });
    alignments += 1;
    return false;
  }
  async function align() {
    const end = performance.now() + TIMING.anchorWaitMs;
    while (running && performance.now() < end) {
      guard();
      if (alignOnce()) return;
      await wait(TIMING.pollMs);
    }
    if (running) fail(findAnchor() ? "alignment_failed" : "anchor_lost");
  }
  function heapEstimate() {
    try {
      const m = performance.memory;
      const number = v => Number.isFinite(v) && v >= 0 ? v : null;
      return m ? { usedBytes: number(m.usedJSHeapSize), allocatedBytes: number(m.totalJSHeapSize), limitBytes: number(m.jsHeapSizeLimit) } : null;
    } catch { return null; }
  }
  function snapshot() {
    guard();
    // Read the optional estimate before allocating the DOM-count sample.
    const jsHeapEstimate = heapEstimate(), scope = scrollerRef.deref(), anchor = findAnchor();
    if (!anchor) fail("anchor_lost");
    const box = scrollBox(scope), offset = anchor.getBoundingClientRect().top - box.top;
    if (Math.abs(offset - originalOffset) > 2) fail("alignment_failed");
    const answer = answerFor(anchor), body = answer.querySelector(BODY), bodyRect = body.getBoundingClientRect();
    let content = body;
    while (content.parentElement !== answer) content = content.parentElement;
    const contentDisplayHidden = getComputedStyle(content).display === "none";
    const bodyHasLayoutBox = bodyRect.width > 0 && bodyRect.height > 0;
    if (bodyHasLayoutBox !== (expectedGate === sentinel) || contentDisplayHidden !== (expectedGate === "true")) fail("css_exposure_unconfirmed");
    const rows = outerTurns(scope), roots = Array.from(scope.querySelectorAll(ANSWER)).filter(active);
    if (roots.length > LIMITS.answers) fail("answer_limit");
    let nativeTurnElements = 0, extensionElements = 0;
    for (const row of rows) {
      let controls = 0;
      for (const control of row.querySelectorAll(OWN)) {
        if (!control.parentElement?.closest(OWN)) controls += 1 + control.getElementsByTagName("*").length;
      }
      nativeTurnElements += 1 + row.getElementsByTagName("*").length - controls;
      extensionElements += controls;
    }
    if (nativeTurnElements > LIMITS.nativeElements) fail("native_element_limit");
    const counts = { documentElements: document.getElementsByTagName("*").length,
      scopeElements: scope.getElementsByTagName("*").length, nativeTurnElements, extensionElements,
      nativeTurnWrappers: rows.length, registeredAnswers: roots.length,
      assistantBodies: rows.reduce((sum, row) => sum + row.querySelectorAll(BODY).length, 0),
      markedCollapsedAnswers: roots.filter(root => root.getAttribute("data-cgf-collapsed") === "true").length,
      markedExpandedAnswers: roots.filter(root => root.getAttribute("data-cgf-collapsed") === "false").length };
    return { elapsedMs: Math.round(performance.now() - started), counts,
      anchor: { matched: true, offsetPx: Math.round(offset * 100) / 100, errorPx: Math.round((offset - originalOffset) * 100) / 100,
        turnHeightPx: Math.round(anchor.getBoundingClientRect().height), intendedCollapsed: true, bodyHasLayoutBox, contentDisplayHidden },
      scroll: { top: Math.round(scope.scrollTop), height: scope.scrollHeight, viewport: box.height }, jsHeapEstimate };
  }
  function median(values) { const a = [...values].sort((a, b) => a - b); return a[Math.floor(a.length / 2)]; }
  function summarizePhase(phase) {
    const items = phase.snapshots, keys = ["nativeTurnWrappers", "registeredAnswers", "nativeTurnElements", "assistantBodies"];
    phase.countsStable = items.length === LIMITS.samplesPerPhase && keys.every(key => items.every(s => s.counts[key] === items[0].counts[key]));
    phase.geometryStable = items.length === LIMITS.samplesPerPhase && items.every(s =>
      Math.abs(s.scroll.height - items[0].scroll.height) <= 2 && Math.abs(s.scroll.top - items[0].scroll.top) <= 2 &&
      Math.abs(s.anchor.turnHeightPx - items[0].anchor.turnHeightPx) <= 2 && Math.abs(s.anchor.errorPx) <= 2);
    phase.medianCounts = Object.fromEntries(keys.map(key => [key, median(items.map(s => s.counts[key]))]));
  }
  function finish(outcome, reason = null) {
    if (finished) return globalThis[OUT];
    finished = true; running = false;
    observer?.disconnect(); observer = null;
    clearTimeout(timer); clearTimeout(deadline); timer = deadline = null;
    const resolve = wake; wake = null; resolve?.();
    for (const [target, type, listener, capture] of listeners) target.removeEventListener(type, listener, capture);
    listeners.length = 0;
    const html = htmlRef?.deref();
    try {
      if (changedGate && html?.getAttribute(GATE) === sentinel) {
        html.setAttribute(GATE, "true"); report.cleanup.gate = "restored";
      } else if (changedGate) {
        report.cleanup.gate = html?.getAttribute(GATE) === "true" ? "already-original" : "external-change-respected";
      }
    } catch { report.cleanup.gate = "restore-failed"; }
    const sameContext = html === document.documentElement && bodyRef?.deref() === document.body && routeValue() === route;
    if (changedGate && interacted) report.cleanup.scroll = "skipped-user-interaction";
    else if (changedGate && (!sameContext || ["pagehide", "page_hidden", "generation_active", "viewport_changed", "external_gate_change"].includes(reason))) {
      report.cleanup.scroll = "skipped-context-change";
    } else if (changedGate) {
      try {
        const anchor = findAnchor(), scope = scrollerRef?.deref();
        if (anchor && scope?.isConnected) {
          const error = anchor.getBoundingClientRect().top - scrollBox(scope).top - originalOffset;
          if (Math.abs(error) <= 2) report.cleanup.scroll = "anchor-aligned-at-cleanup";
          else { scope.scrollTo({ top: scope.scrollTop + error, behavior: "instant" }); report.cleanup.scroll = "anchor-restoration-requested"; }
        } else if (scope?.isConnected) {
          scope.scrollTo({ top: originalScrollTop, behavior: "instant" }); report.cleanup.scroll = "numeric-fallback-requested";
        }
      } catch { report.cleanup.scroll = "anchor-unavailable"; }
    }
    report.cleanup.resourcesReleased = true;
    report.outcome = outcome; report.reason = reason;
    report.events = { mutationBatches, alignments };
    const complete = outcome === "completed" && report.phases.length === 3 && report.phases.every(p => p.snapshots.length === LIMITS.samplesPerPhase);
    const comparable = complete && report.phases.every(p => p.countsStable && p.geometryStable);
    report.summary = { allPhasesComplete: complete, comparisonValid: comparable,
      countsStableAll: complete && report.phases.every(p => p.countsStable), geometryStableAll: complete && report.phases.every(p => p.geometryStable),
      foldedCountsRecovered: null, restoredFoldedMinusBypassed: null, netMemoryBenefit: "not-established" };
    if (comparable) {
      const [a, b, c] = report.phases.map(p => p.medianCounts);
      report.summary.foldedCountsRecovered = Object.keys(a).every(key => a[key] === c[key]);
      report.summary.restoredFoldedMinusBypassed = Object.fromEntries(Object.keys(c).map(key => [key, c[key] - b[key]]));
    }
    htmlRef = bodyRef = scrollerRef = null; anchorKey = route = viewport = null;
    delete globalThis[API];
    globalThis[OUT] = JSON.stringify(report, null, 2);
    console.info("CGF 对照结束（" + outcome + (reason ? ": " + reason : "") + "）；复制：copy(__CGF_FOLD_WINDOW_REPORT_V1__)");
    return globalThis[OUT];
  }
  function handleFailure(error) { finish(running ? "aborted" : "rejected", reasons.has(error?.message) ? error.message : "probe_error"); }
  function listen(target, type, listener, options = false) {
    target.addEventListener(type, listener, options);
    listeners.push([target, type, listener, typeof options === "object" ? Boolean(options.capture) : options]);
  }
  async function run() {
    for (const name of PHASES) {
      if (!running) return;
      guard(); phaseName = name;
      if (name !== "A_folded") {
        expectedGate = name === "B_css_bypassed" ? sentinel : "true";
        changedGate = true;
        document.documentElement.setAttribute(GATE, expectedGate);
      }
      const phase = { phase: name, condition: name === "B_css_bypassed" ? "fold-css-bypassed" : "fold-css-enabled", snapshots: [] };
      report.phases.push(phase);
      console.info("CGF 对照 " + name + "：请保持页面不操作。");
      const until = performance.now() + TIMING.settleMs;
      while (running && performance.now() < until) { guard(); await align(); await wait(TIMING.pollMs); }
      for (let index = 0; running && index < LIMITS.samplesPerPhase; index += 1) {
        await align();
        if (!running) return;
        phase.snapshots.push(snapshot());
        if (index + 1 < LIMITS.samplesPerPhase) await wait(TIMING.sampleMs);
      }
      if (!running) return;
      summarizePhase(phase);
    }
    if (running) finish("completed");
  }

  try {
    if (location.origin !== "https://chatgpt.com" || !/^\/(?:c\/[^/]+|g\/[^/]+\/c\/[^/]+)\/?$/.test(location.pathname)) fail("wrong_page");
    if (window.top !== window) fail("not_top_frame");
    if (typeof WeakRef !== "function" || !document.body || routeValue().length > 4096) fail("unsupported_environment");
    if (document.documentElement.getAttribute(GATE) !== "true" || !document.querySelector(OWN)) fail("extension_not_active");
    htmlRef = new WeakRef(document.documentElement); bodyRef = new WeakRef(document.body); route = routeValue();
    chooseAnchor(); guard(); snapshot(); // Check all limits before changing anything.
    delete globalThis[OUT];
    running = true;
    globalThis[API] = Object.freeze({ stop: () => finish("stopped", "manual_stop"),
      status: () => ({ phase: phaseName, elapsedMs: Math.round(performance.now() - started) }) });
    const input = event => {
      if (event.isTrusted) { interacted = true; finish("aborted", "user_interaction"); }
    };
    for (const type of ["wheel", "touchstart", "pointerdown", "keydown", "beforeinput", "submit"]) {
      listen(document, type, input, { capture: true, passive: true });
    }
    const navigation = () => { if (routeValue() !== route) finish("aborted", "route_changed"); };
    listen(window, "popstate", navigation); listen(window, "hashchange", navigation);
    if (window.navigation) listen(window.navigation, "navigatesuccess", navigation);
    listen(window, "resize", () => finish("aborted", "viewport_changed"));
    listen(window, "pagehide", () => finish("aborted", "pagehide"));
    listen(document, "visibilitychange", () => { if (document.visibilityState !== "visible") finish("aborted", "page_hidden"); });
    observer = new MutationObserver(records => {
      if (!running) return;
      mutationBatches += 1;
      try {
        if (routeValue() !== route) fail("route_changed");
        if (bodyRef.deref() !== document.body || htmlRef.deref() !== document.documentElement) fail("body_changed");
        if (document.documentElement.getAttribute(GATE) !== expectedGate) fail("external_gate_change");
        for (const record of records) {
          const node = record.target.nodeType === 1 ? record.target : record.target.parentElement;
          if (!node?.isConnected || node.closest(OWN)) continue;
          if (record.attributeName === "data-cgf-collapsed" && record.oldValue !== null &&
              record.oldValue !== node.getAttribute("data-cgf-collapsed")) fail("fold_policy_changed");
          if ((record.type === "characterData" || record.type === "childList") && node.closest(BODY) &&
              scrollerRef.deref()?.contains(node)) fail("answer_content_changed");
          const pastGeneration = (record.attributeName === "data-talvt-turn-state" && record.oldValue === "in_progress") ||
            (record.attributeName === "data-is-streaming" && record.oldValue === "true") ||
            (record.attributeName === "aria-busy" && record.oldValue === "true") ||
            (record.attributeName === "class" && /(?:^|\s)result-streaming(?:\s|$)/.test(record.oldValue || ""));
          if (pastGeneration && active(node)) fail("generation_active");
        }
        if (generationActive()) fail("generation_active");
      } catch (error) { handleFailure(error); }
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true,
      attributes: true, attributeOldValue: true, attributeFilter: [GATE, "data-cgf-collapsed", "data-talvt-turn-state", "data-is-streaming", "aria-busy", "data-testid", "aria-label", "class"] });
    deadline = setTimeout(() => finish("aborted", "deadline"), LIMITS.durationMs);
    console.info("CGF 窗口对照已开始，约 30 秒。只临时旁路折叠样式；不测标签页总内存。");
    void run().catch(handleFailure);
  } catch (error) { handleFailure(error); }
})();
