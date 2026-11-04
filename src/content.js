/* global CGFShared, CGFAdapter, chrome */
(function () {
  "use strict";
  const shared = globalThis.CGFShared;
  const adapter = globalThis.CGFAdapter;
  if (!shared || !adapter || !globalThis.chrome?.storage?.local) return;

  const SINGLETON = "__chatGPTFoldControllerV1";
  globalThis[SINGLETON]?.destroy();
  const QUIET_MS = 1200;
  const BATCH_MS = 120;

  class FoldController {
    constructor() {
      this.settings = { ...shared.DEFAULT_SETTINGS };
      this.paused = false;
      this.destroyed = false;
      this.active = false;
      this.records = new Map();
      this.order = [];
      this.nextId = 0;
      this.rank = 0;
      this.path = location.pathname;
      this.scanRoots = new Set();
      this.fullScan = false;
      this.pruneNeeded = false;
      this.timer = null;
      this.settleTimer = null;
      this.observedBody = null;
      this.lastZeroRescanAt = 0;
      this.mutationBatches = 0;
      this.onMutation = this.onMutation.bind(this);
      this.onClick = this.onClick.bind(this);
      this.onInteraction = () => this.schedule();
      this.onNavigation = () => this.schedule();
      this.onStorage = this.onStorage.bind(this);
      this.onMessage = this.onMessage.bind(this);
      this.onPageHide = () => this.stopActive();
      this.onPageShow = () => {
        if (!this.destroyed && this.settings.enabled && !this.paused) this.startActive();
      };
      this.observer = new MutationObserver(this.onMutation);
    }

    async start() {
      try {
        const stored = await chrome.storage.local.get(shared.SETTINGS_KEY);
        this.settings = shared.normalizeSettings(stored[shared.SETTINGS_KEY]);
      } catch {
        // The default is usable even if preferences are temporarily unavailable.
      }
      if (this.destroyed) return;
      chrome.runtime.onMessage.addListener(this.onMessage);
      chrome.storage.onChanged.addListener(this.onStorage);
      document.addEventListener("click", this.onClick, true);
      document.addEventListener("selectionchange", this.onInteraction);
      document.addEventListener("focusin", this.onInteraction);
      document.addEventListener("focusout", this.onInteraction);
      window.addEventListener("popstate", this.onNavigation);
      window.addEventListener("hashchange", this.onNavigation);
      window.addEventListener("pagehide", this.onPageHide);
      window.addEventListener("pageshow", this.onPageShow);
      if (window.navigation) window.navigation.addEventListener("navigatesuccess", this.onNavigation);
      if (this.settings.enabled) this.startActive();
    }

    createRecord(element, initial = false) {
      if (!element.isConnected || this.records.has(element)) return false;
      // A previous interrupted instance must not leave duplicate controls behind.
      for (const child of [...element.children]) {
        if (child.hasAttribute("data-cgf-control")) child.remove();
      }
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("data-cgf-control", "true");
      button.setAttribute("data-cgf-toggle", "true");
      const chevron = document.createElement("span");
      chevron.className = "cgf-chevron";
      chevron.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.className = "cgf-label";
      const badge = document.createElement("span");
      badge.className = "cgf-badge";
      button.append(chevron, label, badge);
      const record = {
        id: ++this.nextId,
        element,
        identity: adapter.identity(element),
        control: button,
        chevron,
        label,
        badge,
        preview: adapter.preview(element),
        wantsOpen: false,
        protected: false,
        reason: "",
        unsupported: false,
        rank: 0,
        order: 0,
        dirty: !initial,
        busyUntil: initial ? 0 : Date.now() + QUIET_MS
      };
      this.records.set(element, record);
      element.setAttribute("data-cgf-message", String(record.id));
      element.prepend(button);
      return true;
    }

    reorder() {
      this.order = [...this.records.values()].sort((a, b) => {
        if (a.element === b.element) return 0;
        return a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });
      this.order.forEach((record, index) => { record.order = index; });
    }

    setRecent() {
      const first = Math.max(0, this.order.length - this.settings.keepRecent);
      this.order.forEach((record, index) => {
        record.wantsOpen = index >= first;
        if (record.wantsOpen) record.rank = ++this.rank;
      });
    }

    startActive() {
      if (this.destroyed || this.active || !this.settings.enabled || this.paused || !document.body) return;
      this.path = location.pathname;
      this.active = true;
      document.documentElement.setAttribute("data-cgf-active", "true");
      for (const element of adapter.collect(document)) this.createRecord(element, true);
      this.reorder();
      this.setRecent();
      this.applyPolicy();
      this.observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeOldValue: true,
        attributeFilter: ["data-message-id", "data-turn-id", "data-message-author-role", "data-message-role", "data-turn", "data-testid",
          "data-chatgpt-search-unit-key", "data-content-search-unit-key", "data-chatgpt-search-message-ids", "data-chatgpt-selection-message-id",
          "data-markdown-text-style", "data-user-message-bubble", "data-turn-key", "data-content-search-turn-key", "data-talvt-turn-state",
          "data-chatgpt-composer", "data-app-action-timeline-scroll",
          "data-is-streaming", "aria-busy", "class", "style", "hidden", "aria-hidden", "role", "aria-label"]
      });
      this.observedBody = document.body;
    }

    releaseRecord(record) {
      record.element.removeAttribute("data-cgf-collapsed");
      record.element.removeAttribute("data-cgf-message");
      record.control.remove();
      this.records.delete(record.element);
    }

    stopActive() {
      this.active = false;
      this.observer.disconnect();
      this.observedBody = null;
      clearTimeout(this.timer);
      clearTimeout(this.settleTimer);
      this.timer = null;
      this.settleTimer = null;
      document.documentElement.removeAttribute("data-cgf-active");
      for (const record of this.records.values()) this.releaseRecord(record);
      this.records.clear();
      this.order = [];
      this.scanRoots.clear();
      this.fullScan = false;
      this.pruneNeeded = false;
    }

    schedule() {
      if (this.destroyed || this.timer !== null) return;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, BATCH_MS);
    }

    queueScan(element) {
      if (!element || element.nodeType !== 1 || element.closest(adapter.OWN)) return;
      element = adapter.scanRoot(element);
      // Keep the batch small when several mutations affect the same answer.
      for (const scope of this.scanRoots) {
        if (scope.contains(element)) return;
        if (element.contains(scope)) this.scanRoots.delete(scope);
      }
      if (this.scanRoots.size >= 80) {
        this.fullScan = true;
        this.scanRoots.clear();
      } else if (!this.fullScan) {
        this.scanRoots.add(element);
      }
    }

    onMutation(mutations) {
      if (!this.active || this.destroyed) return;
      let relevant = location.pathname !== this.path;
      for (const mutation of mutations) {
        const target = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
        if (!target || target.closest(adapter.OWN)) continue;
        if (mutation.type === "attributes") {
          const attribute = mutation.attributeName;
          const streamClassChanged = attribute === "class" &&
            (mutation.oldValue || "").split(/\s+/).includes("result-streaming") !== target.classList.contains("result-streaming");
          if (["class", "style", "hidden", "aria-hidden", "role"].includes(attribute) && !streamClassChanged) {
            // Cached timelines can become active without adding any messages.
            // Style-only updates must not mark an answer dirty or reopen it.
            const containsAnswers = target.matches(adapter.CANDIDATE) || Boolean(target.querySelector(adapter.CANDIDATE));
            const containsStop = target.matches(adapter.STOP) || Boolean(target.querySelector(adapter.STOP));
            if (containsAnswers) { this.queueScan(target); this.pruneNeeded = true; }
            if (containsAnswers || containsStop) relevant = true;
            continue;
          }
        }
        if (mutation.type === "attributes" && mutation.attributeName === "aria-label") {
          const stopLabel = /^(Stop generating|Stop streaming|停止生成|停止生成回复|Stop|停止)$/;
          if (target.tagName !== "BUTTON" || (!stopLabel.test(mutation.oldValue || "") && !stopLabel.test(target.getAttribute("aria-label") || ""))) continue;
        }
        const owner = target.closest("[data-cgf-message]");
        const record = owner ? this.records.get(owner) : null;
        if (mutation.type === "childList") {
          const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
          const onlyControls = nodes.length && nodes.every(node => node.nodeType === 1 && node.hasAttribute("data-cgf-control"));
          if (onlyControls) {
            // Repair a toolbar that a page update removed, but ignore our own insertions.
            if (record && !record.control.isConnected) relevant = true;
            continue;
          }
          for (const node of mutation.addedNodes) this.queueScan(node);
          // A deletion can make the surviving turn container eligible, even
          // when no element was added. Avoid rescanning an entire main/history
          // container for every streamed token: only revisit semantic answers.
          const affectedAnswer = target.closest(adapter.CANDIDATE);
          if (affectedAnswer) this.queueScan(affectedAnswer);
          this.pruneNeeded = true;
        } else if (mutation.type === "attributes") {
          this.queueScan(target);
          this.pruneNeeded = true;
        }
        if (record) {
          record.dirty = true;
          record.busyUntil = Date.now() + QUIET_MS;
          // A regenerated / streaming answer should become visible immediately.
          if (record.element.getAttribute("data-cgf-collapsed") === "true") {
            record.element.setAttribute("data-cgf-collapsed", "false");
          }
        }
        relevant = true;
      }
      if (relevant) this.schedule();
    }

    flush() {
      if (this.destroyed) return;
      try {
        if (!chrome.runtime.id) { this.destroy(); return; }
      } catch {
        this.destroy();
        return;
      }
      if (location.pathname !== this.path) {
        this.stopActive();
        this.path = location.pathname;
        this.paused = false;
        if (this.settings.enabled) this.startActive();
        return;
      }
      // Rescan/status or the next document interaction can recover a replaced
      // body; do not keep records or an observer attached to its detached tree.
      if (this.active && this.observedBody !== document.body) {
        this.stopActive();
        if (this.settings.enabled && !this.paused) this.startActive();
        return;
      }
      if (!this.active) return;
      this.mutationBatches += 1;
      const scanContext = adapter.createScanContext();
      const previousLast = this.order[this.order.length - 1];
      let changed = false;
      if (this.pruneNeeded) {
        for (const record of this.records.values()) {
          if (!record.element.isConnected || !adapter.isAssistant(record.element, scanContext)) {
            this.releaseRecord(record);
            changed = true;
          }
        }
        this.pruneNeeded = false;
      }
      const scopes = this.fullScan ? [document] : [...this.scanRoots];
      this.scanRoots.clear();
      this.fullScan = false;
      for (const scope of scopes) {
        if (scope !== document && !scope.isConnected) continue;
        for (const element of adapter.collect(scope, scanContext)) changed = this.createRecord(element) || changed;
      }
      if (changed) {
        this.reorder();
        // Lazy-loading older history must not steal the user's open answer.
        if (this.order[this.order.length - 1] !== previousLast) this.setRecent();
      }
      for (const record of this.order) {
        if (record.control.parentNode !== record.element) record.element.prepend(record.control);
        const nextIdentity = adapter.identity(record.element);
        if (nextIdentity !== record.identity) {
          record.identity = nextIdentity;
          record.dirty = true;
          record.busyUntil = Date.now() + QUIET_MS;
          record.wantsOpen = true;
          record.rank = ++this.rank;
        }
      }
      this.applyPolicy();
    }

    interactionReason(record, selection, focused) {
      if (focused && record.element.contains(focused) && !focused.closest(adapter.OWN)) return "操作中";
      if (selection && !selection.isCollapsed) {
        for (let i = 0; i < selection.rangeCount; i += 1) {
          try {
            if (selection.getRangeAt(i).intersectsNode(record.element)) return "已选文字";
          } catch { /* An asynchronously removed selection needs no protection. */ }
        }
      }
      return "";
    }

    applyPolicy() {
      if (!this.active) return;
      const now = Date.now();
      const streaming = adapter.streamingElements(document, this.records, this.order);
      const selection = document.getSelection();
      const focused = document.activeElement;
      let nextSettle = Infinity;
      for (const record of this.order) {
        record.unsupported = adapter.hasDirectText(record.element);
        const busy = record.busyUntil > now;
        record.reason = record.unsupported ? "保持原样" : streaming.has(record.element) ? "生成中" :
          this.interactionReason(record, selection, focused) || (busy ? "更新中" : "");
        record.protected = Boolean(record.reason);
        if (busy) nextSettle = Math.min(nextSettle, record.busyUntil - now);
        if (record.dirty && !busy && !streaming.has(record.element)) {
          record.preview = adapter.preview(record.element);
          record.dirty = false;
        }
      }
      const expanded = shared.planExpanded(this.order, this.settings.maxExpanded);
      for (const record of this.order) {
        const isOpen = expanded.has(record.id);
        // Once evicted by the cap, a normal answer stays closed until requested.
        if (!isOpen && !record.protected) record.wantsOpen = false;
        const value = isOpen ? "false" : "true";
        if (record.element.getAttribute("data-cgf-collapsed") !== value) record.element.setAttribute("data-cgf-collapsed", value);
        const label = `回答 ${record.order + 1} · ${record.preview}`;
        if (record.label.textContent !== label) record.label.textContent = label;
        const arrow = isOpen ? "▾" : "▸";
        if (record.chevron.textContent !== arrow) record.chevron.textContent = arrow;
        const badge = record.reason || (isOpen ? "收起" : "展开");
        if (record.badge.textContent !== badge) record.badge.textContent = badge;
        if (record.control.disabled !== record.protected) record.control.disabled = record.protected;
        const expandedValue = String(isOpen);
        if (record.control.getAttribute("aria-expanded") !== expandedValue) record.control.setAttribute("aria-expanded", expandedValue);
        const accessibleLabel = `${isOpen ? "收起" : "展开"}${label}`;
        if (record.control.getAttribute("aria-label") !== accessibleLabel) record.control.setAttribute("aria-label", accessibleLabel);
        const title = record.reason ? `${record.reason}：暂时保留完整回答` : `${isOpen ? "收起" : "展开"}这条回答`;
        if (record.control.title !== title) record.control.title = title;
      }
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
      if (Number.isFinite(nextSettle)) {
        this.settleTimer = setTimeout(() => {
          this.settleTimer = null;
          this.schedule();
        }, Math.max(20, nextSettle + 20));
      }
    }

    onClick(event) {
      if (!this.active || !(event.target instanceof Element)) return;
      const button = event.target.closest("[data-cgf-toggle]");
      if (!button || button.disabled) return;
      const record = this.records.get(button.closest("[data-cgf-message]"));
      if (!record || record.control !== button) return;
      event.preventDefault();
      event.stopPropagation();
      const before = button.getBoundingClientRect().top;
      record.wantsOpen = record.element.getAttribute("data-cgf-collapsed") === "true";
      record.rank = ++this.rank;
      this.applyPolicy();
      // One user-triggered measurement pair, never a whole-history scroll scan.
      const after = button.getBoundingClientRect().top;
      const delta = after - before;
      if (Math.abs(delta) > 1) {
        const scroller = this.scrollContainer(button);
        scroller.scrollTop += delta;
      }
    }

    scrollContainer(element) {
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const overflow = getComputedStyle(parent).overflowY;
        if (/(auto|scroll)/.test(overflow) && parent.scrollHeight > parent.clientHeight) return parent;
      }
      return document.scrollingElement || document.documentElement;
    }

    updateSettings(value) {
      const next = shared.normalizeSettings(value);
      const changed = JSON.stringify(next) !== JSON.stringify(this.settings);
      const wasEnabled = this.settings.enabled;
      this.settings = next;
      if (!changed) return;
      if (!next.enabled) this.stopActive();
      else {
        if (!wasEnabled) this.paused = false;
        if (!this.paused) {
          if (!this.active) this.startActive();
          else {
            this.setRecent();
            this.applyPolicy();
          }
        }
      }
    }

    onStorage(changes, area) {
      if (area === "local" && changes[shared.SETTINGS_KEY]) this.updateSettings(changes[shared.SETTINGS_KEY].newValue);
    }

    status() {
      if (!this.active) {
        const total = adapter.collect(document).length;
        return { ok: true, enabled: this.settings.enabled, active: false, paused: this.paused, total, collapsed: 0,
          expanded: total, protected: 0, unsupported: 0, version: shared.VERSION };
      }
      let collapsed = 0;
      let protectedCount = 0;
      let unsupported = 0;
      for (const record of this.order) {
        if (record.element.getAttribute("data-cgf-collapsed") === "true") collapsed += 1;
        if (record.protected) protectedCount += 1;
        if (record.unsupported) unsupported += 1;
      }
      return { ok: true, enabled: this.settings.enabled, active: true, paused: this.paused, total: this.records.size,
        collapsed, expanded: this.records.size - collapsed, protected: protectedCount, unsupported,
        version: shared.VERSION };
    }

    rescan() {
      this.lastZeroRescanAt = Date.now();
      if (!this.active && this.settings.enabled && !this.paused) this.startActive();
      if (this.active) {
        this.fullScan = true;
        this.pruneNeeded = true;
        this.flush();
      }
      // Paused/disabled scans report detected answers without restoring folding.
      return this.status();
    }

    diagnostics() {
      let connectedRegisteredCount = 0;
      for (const element of this.records.keys()) {
        if (element.isConnected) connectedRegisteredCount += 1;
      }
      return {
        schemaVersion: 2,
        scriptVersion: shared.VERSION,
        readyState: document.readyState,
        topFrame: window.top === window,
        hasBody: Boolean(document.body),
        enabled: this.settings.enabled,
        active: this.active,
        paused: this.paused,
        observerConnected: Boolean(this.active && this.observedBody?.isConnected && this.observedBody === document.body),
        registeredAnswerCount: this.records.size,
        connectedRegisteredCount,
        ...adapter.diagnostics(document)
      };
    }

    command(name) {
      if (name === "restore") {
        this.paused = true;
        this.stopActive();
      } else if (name === "resume") {
        this.paused = false;
        if (this.settings.enabled) this.startActive();
      } else if (name === "collapse-all" && this.active) {
        for (const record of this.order) record.wantsOpen = false;
        this.applyPolicy();
      } else if (name === "recent" && this.active) {
        this.setRecent();
        this.applyPolicy();
      } else if (name === "rescan") {
        return this.rescan();
      } else {
        return { ok: false, error: "当前页面未启用折叠，或命令不受支持。" };
      }
      return this.status();
    }

    onMessage(message, sender, sendResponse) {
      if (!message || !["CGF_GET_STATUS", "CGF_COMMAND", "CGF_GET_DIAGNOSTICS"].includes(message.type)) return false;
      if (sender?.id && sender.id !== chrome.runtime.id) return false;
      // Reconcile preferences before replying, avoiding storage-event races with
      // the popup's immediately-following status request.
      chrome.storage.local.get(shared.SETTINGS_KEY).then(stored => {
        if (this.destroyed) return sendResponse({ ok: false, error: "扩展已重新加载，请刷新页面。" });
        this.updateSettings(stored[shared.SETTINGS_KEY]);
        this.flush();
        if (message.type === "CGF_GET_DIAGNOSTICS") {
          sendResponse({ ok: true, diagnostics: this.diagnostics() });
        } else if (message.type === "CGF_COMMAND") {
          sendResponse(this.command(message.command));
        } else {
          // A popup request may recover a missed discovery. This is throttled
          // and request-driven, with no whole-document polling timer.
          if (this.settings.enabled && !this.paused && !this.records.size && Date.now() - this.lastZeroRescanAt >= 2000) this.rescan();
          sendResponse(this.status());
        }
      }).catch(() => {
        this.destroy();
        sendResponse({ ok: false, error: "扩展连接已失效，请刷新 ChatGPT 页面。" });
      });
      return true;
    }

    destroy() {
      this.destroyed = true;
      this.stopActive();
      document.removeEventListener("click", this.onClick, true);
      document.removeEventListener("selectionchange", this.onInteraction);
      document.removeEventListener("focusin", this.onInteraction);
      document.removeEventListener("focusout", this.onInteraction);
      window.removeEventListener("popstate", this.onNavigation);
      window.removeEventListener("hashchange", this.onNavigation);
      window.removeEventListener("pagehide", this.onPageHide);
      window.removeEventListener("pageshow", this.onPageShow);
      if (window.navigation) window.navigation.removeEventListener("navigatesuccess", this.onNavigation);
      try {
        chrome.storage.onChanged.removeListener(this.onStorage);
        chrome.runtime.onMessage.removeListener(this.onMessage);
      } catch { /* Invalid extension contexts still restore the page safely. */ }
      if (globalThis[SINGLETON] === this) delete globalThis[SINGLETON];
    }
  }

  const controller = new FoldController();
  globalThis[SINGLETON] = controller;
  controller.start().catch(() => controller.destroy());
})();
