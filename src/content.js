/* global CGFShared, CGFAdapter, chrome */
(function () {
  "use strict";
  const shared = globalThis.CGFShared;
  const adapter = globalThis.CGFAdapter;
  if (!shared || !adapter || !globalThis.chrome?.storage?.local) return;

  const SINGLETON = "__chatGPTFoldControllerV1";
  globalThis[SINGLETON]?.destroy();
  const BATCH_MS = 120;
  const QUEUE_LIMIT = 80;
  const DISCOVERY_NODES = [adapter.CANDIDATE, adapter.USER, adapter.STREAMING, adapter.STOP].join(",");
  // Neutral markup must not silently change a message identity, suppress a
  // fallback root, or introduce/remove a generation or visibility boundary.
  // Match attributes regardless of their value, including non-assistant roles.
  const SEMANTIC_NODES = [DISCOVERY_NODES, "style", "link", "script", "[data-cgf-message]", "[data-cgf-control]",
    ...["data-message-id", "data-turn-id", "data-message-author-role", "data-message-role", "data-turn",
      "data-chatgpt-search-unit-key", "data-content-search-unit-key", "data-chatgpt-search-message-ids",
      "data-chatgpt-selection-message-id", "data-markdown-text-style", "data-user-message-bubble",
      "data-turn-key", "data-content-search-turn-key", "data-talvt-turn-state", "data-chatgpt-composer",
      "data-app-action-timeline-scroll", "data-is-streaming", "aria-busy", "aria-label"].map(name => `[${name}]`)
  ].join(",");

  class FoldController {
    constructor() {
      this.settings = { ...shared.DEFAULT_SETTINGS };
      this.paused = false;
      this.pageSuspended = false;
      this.destroyed = false;
      this.active = false;
      this.knownLatest = null;
      this.stopVisible = false;
      this.stopTarget = null;
      this.openIntents = new Map();
      this.records = new Map();
      this.order = [];
      this.nextId = 0;
      this.rank = 0;
      this.path = location.pathname;
      this.scanRoots = new Set();
      this.dirtyRecords = new Set();
      this.fullScan = false;
      this.pruneNeeded = false;
      this.policyNeeded = false;
      this.timer = null;
      this.observedBody = null;
      this.bodyObserverConnected = false;
      this.lastZeroRescanAt = 0;
      this.mutationBatches = 0;
      // Fixed-size scalar counters, never a sample history or a node log.
      this.workCounts = { fullFlushCount: 0, incrementalFlushCount: 0, previewRefreshCount: 0,
        bodyReplacementCount: 0, releasedRecordCount: 0 };
      this.onMutation = this.onMutation.bind(this);
      this.onClick = this.onClick.bind(this);
      this.onInteraction = () => {
        if (this.active) { this.policyNeeded = true; this.schedule(); }
      };
      this.onNavigation = () => { this.policyNeeded = true; this.schedule(); };
      this.onStorage = this.onStorage.bind(this);
      this.onMessage = this.onMessage.bind(this);
      this.onPageHide = () => { this.pageSuspended = true; this.stopActive(); };
      this.onPageShow = () => {
        this.pageSuspended = false;
        if (!this.destroyed && this.settings.enabled && !this.paused) this.startActive();
      };
      this.observer = new MutationObserver(this.onMutation);
      this.bodyObserver = new MutationObserver(() => {
        if (!this.destroyed && !this.pageSuspended && this.settings.enabled && !this.paused &&
            (!this.active || this.observedBody !== document.body)) this.flush();
      });
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

    createRecord(element) {
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
        identityHint: adapter.identityHint(element),
        intentKey: null,
        control: button,
        chevron,
        label,
        badge,
        preview: adapter.preview(element),
        wantsOpen: false,
        protected: false,
        streaming: false,
        reason: "",
        unsupported: false,
        rank: 0,
        order: 0,
        dirty: false
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
      this.openIntents.clear();
      for (const record of this.order.slice(first)) this.rememberOpen(record);
      this.rememberLatest();
    }

    rememberLatest() {
      const last = this.order[this.order.length - 1];
      // One scalar token survives windowing, never a reference to detached DOM.
      this.knownLatest = last ? { id: last.id, identity: last.identity } : null;
    }

    observeStop() {
      const visible = adapter.hasVisibleStop(document);
      // Stop describes the request, not the last completed answer. A new
      // session starts without a target until an actual new tail is confirmed.
      if (!visible || !this.stopVisible) this.stopTarget = null;
      this.stopVisible = visible;
    }

    bindStopTarget(record) {
      // One scalar key; never retain a message node or a copy of its contents.
      if (this.stopVisible && record) this.stopTarget = record.intentKey;
    }

    rememberOpen(record) {
      if (!this.openIntents.has(record.intentKey)) this.openIntents.set(record.intentKey, ++this.rank);
      this.trimOpenIntents();
    }

    trimOpenIntents() {
      // Detached open replies still occupy a slot. Only scalar keys/ranks are
      // retained, bounded by the configured cap (currently at most five).
      const ranked = [...this.openIntents].sort((a, b) => b[1] - a[1]);
      for (const [key] of ranked.slice(this.settings.maxExpanded)) this.openIntents.delete(key);
    }

    syncIntentKeys() {
      const current = this.order.map(record => ({ record, identity: adapter.identity(record.element), hint: adapter.identityHint(record.element) }));
      const counts = new Map();
      for (const { identity } of current) {
        if (identity) counts.set(identity, (counts.get(identity) || 0) + 1);
      }
      for (const { record, identity, hint } of current) {
        const key = identity?.startsWith("message:") && counts.get(identity) === 1 ? identity : record.id;
        const oldKey = record.intentKey;
        const strongIdentity = record.identity?.startsWith("message:");
        const sameHint = hint !== null && hint === record.identityHint;
        const enriched = !strongIdentity && identity?.startsWith("message:") && sameHint;
        const sameMessage = (identity === record.identity && (strongIdentity || sameHint)) || enriched;
        if (oldKey !== null && this.stopTarget === oldKey) {
          if (sameMessage) this.stopTarget = key;
          else if (typeof oldKey === "number") this.stopTarget = null;
        }
        if (!sameMessage && typeof oldKey === "number") this.openIntents.delete(oldKey);
        if (oldKey !== null && oldKey !== key) {
          const rank = this.openIntents.get(oldKey);
          if (rank !== undefined && sameMessage) {
            this.openIntents.delete(oldKey);
            this.openIntents.set(key, Math.max(rank, this.openIntents.get(key) || 0));
          } else if (typeof oldKey === "number") this.openIntents.delete(oldKey);
        }
        if (this.knownLatest?.id === record.id && !sameMessage && !strongIdentity) {
          this.knownLatest.id = -1;
        }
        if (identity !== record.identity) {
          // Identity enrichment on the same previously unidentified root is
          // not a new answer; a different known ID must use its own open state.
          if (enriched && this.knownLatest?.id === record.id) this.knownLatest.identity = identity;
          record.identity = identity;
          record.dirty = true;
        }
        record.identityHint = hint;
        record.intentKey = key;
      }
      // Never restore one remembered identity into multiple mounted answers.
      for (const [identity, count] of counts) {
        if (count > 1) this.openIntents.delete(identity);
      }
      this.trimOpenIntents();
    }

    startActive(preserveChoices = false) {
      if (this.destroyed || !this.settings.enabled || this.paused || this.pageSuspended) return;
      // Observe only direct html children, not a second copy of the body subtree.
      // Keep this connected while body is absent so a later insertion recovers.
      if (!this.bodyObserverConnected && document.documentElement) {
        this.bodyObserver.observe(document.documentElement, { childList: true });
        this.bodyObserverConnected = true;
      }
      if (this.active || !document.body) return;
      this.path = location.pathname;
      this.active = true;
      document.documentElement.setAttribute("data-cgf-active", "true");
      for (const element of adapter.collect(document)) this.createRecord(element);
      this.reorder();
      this.syncIntentKeys();
      if (!preserveChoices || !this.knownLatest) this.setRecent();
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
      if (typeof record.intentKey === "number") {
        this.openIntents.delete(record.intentKey);
        if (this.stopTarget === record.intentKey) this.stopTarget = null;
      }
      this.dirtyRecords.delete(record);
      record.element.removeAttribute("data-cgf-collapsed");
      record.element.removeAttribute("data-cgf-message");
      record.control.remove();
      this.records.delete(record.element);
      this.countWork("releasedRecordCount");
    }

    stopActive(preserveChoices = false) {
      this.active = false;
      this.observer.disconnect();
      this.bodyObserver.disconnect();
      this.bodyObserverConnected = false;
      this.observedBody = null;
      clearTimeout(this.timer);
      this.timer = null;
      document.documentElement.removeAttribute("data-cgf-active");
      for (const record of this.records.values()) this.releaseRecord(record);
      this.records.clear();
      this.order = [];
      if (!preserveChoices) {
        this.knownLatest = null;
        this.stopVisible = false;
        this.stopTarget = null;
        this.openIntents.clear();
      }
      this.scanRoots.clear();
      this.dirtyRecords.clear();
      this.fullScan = false;
      this.pruneNeeded = false;
      this.policyNeeded = false;
    }

    countWork(name, amount = 1) {
      this.workCounts[name] = Math.min(Number.MAX_SAFE_INTEGER, this.workCounts[name] + amount);
    }

    markDirty(record) {
      record.dirty = true;
      if (this.policyNeeded) return;
      if (this.dirtyRecords.size >= QUEUE_LIMIT && !this.dirtyRecords.has(record)) {
        this.dirtyRecords.clear();
        this.policyNeeded = true;
      } else this.dirtyRecords.add(record);
    }

    schedule() {
      if (this.destroyed || this.pageSuspended || this.timer !== null) return;
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
      if (this.scanRoots.size >= QUEUE_LIMIT) {
        this.fullScan = true;
        this.scanRoots.clear();
      } else if (!this.fullScan) {
        this.scanRoots.add(element);
      }
    }

    neutralContentMutation(mutation, target, record) {
      if (!record || target === record.element || !record.element.isConnected || target.closest("style, script") ||
          ["操作中", "已选文字"].includes(record.reason)) return false;
      if (mutation.type === "characterData") return true;
      if (mutation.type !== "childList") return false;
      for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
        if (node.nodeType === 1 && (node.matches(SEMANTIC_NODES) || node.querySelector(SEMANTIC_NODES))) return false;
      }
      return true;
    }

    onMutation(mutations) {
      if (!this.active || this.destroyed) return;
      let relevant = location.pathname !== this.path;
      let beforePaint = relevant;
      if (relevant) this.policyNeeded = true;
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
            const containsStreaming = target.matches(adapter.STREAMING) || Boolean(target.querySelector(adapter.STREAMING));
            if (containsAnswers) { this.queueScan(target); this.pruneNeeded = true; }
            if (containsAnswers || containsStop || containsStreaming) {
              relevant = beforePaint = this.policyNeeded = true;
            }
            continue;
          }
        }
        if (mutation.type === "attributes" && mutation.attributeName === "aria-label") {
          const stopLabel = /^(Stop generating|Stop streaming|停止生成|停止生成回复|Stop|停止)$/;
          if (target.tagName !== "BUTTON" || (!stopLabel.test(mutation.oldValue || "") && !stopLabel.test(target.getAttribute("aria-label") || ""))) continue;
        }
        const owner = target.closest("[data-cgf-message]");
        const record = owner ? this.records.get(owner) : null;
        // Token and ordinary inner-markup changes cannot change identities,
        // open intentions, or known generation signals. Refresh their bounded
        // previews only; pending semantic/interaction work always takes priority.
        if (this.neutralContentMutation(mutation, target, record)) {
          this.markDirty(record);
          relevant = true;
          continue;
        }
        if (mutation.type === "childList") {
          const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
          const onlyControls = nodes.length && nodes.every(node => node.nodeType === 1 && node.hasAttribute("data-cgf-control"));
          if (onlyControls) {
            // Repair a toolbar that a page update removed, but ignore our own insertions.
            if (record && record.control.parentNode !== record.element) relevant = this.policyNeeded = true;
            continue;
          }
          for (const node of mutation.addedNodes) this.queueScan(node);
          // A deletion can make the surviving turn container eligible, even
          // when no element was added. Avoid rescanning an entire main/history
          // container for every streamed token: only revisit semantic answers.
          const affectedAnswer = target.closest(adapter.CANDIDATE);
          if (affectedAnswer) this.queueScan(affectedAnswer);
          this.pruneNeeded = true;
          // A mounted/reclassified answer must receive its fold state in this
          // observer microtask, before rendering. Plain text/markup updates
          // inside a known answer already inherit its CSS and stay batched.
          if ((affectedAnswer && !record) || target === record?.element || nodes.some(node =>
            node.nodeType === 1 && (node.matches(SEMANTIC_NODES) || node.querySelector(SEMANTIC_NODES)))) {
            beforePaint = true;
          }
        } else if (mutation.type === "attributes") {
          this.queueScan(target);
          this.pruneNeeded = true;
          beforePaint = true;
        } else if (target === record?.element) {
          // A direct text node may turn into unsupported bare answer text.
          beforePaint = true;
        }
        // Hydration and historical remounts are not generation signals. Keep
        // folded content hidden; explicit streaming/focus/selection can open it.
        if (record) this.markDirty(record);
        relevant = this.policyNeeded = true;
      }
      if (beforePaint) this.flush();
      else if (relevant) this.schedule();
    }

    flush() {
      if (this.destroyed) return;
      clearTimeout(this.timer);
      this.timer = null;
      try {
        if (!chrome.runtime.id) { this.destroy(); return; }
      } catch {
        this.destroy();
        return;
      }
      if (this.pageSuspended) return;
      if (location.pathname !== this.path) {
        this.stopActive();
        this.path = location.pathname;
        this.paused = false;
        if (this.settings.enabled) this.startActive();
        return;
      }
      // The direct-child body observer reaches this without an interaction or
      // a status request. Stop releases the detached tree before any restart.
      if (this.active && this.observedBody !== document.body) {
        this.countWork("bodyReplacementCount");
        this.stopActive(true);
        if (this.settings.enabled && !this.paused) this.startActive(true);
        return;
      }
      if (!this.active) {
        if (this.bodyObserverConnected) this.startActive(true);
        return;
      }
      if (!this.policyNeeded && !this.pruneNeeded && !this.fullScan && !this.scanRoots.size) {
        if (!this.dirtyRecords.size) return;
        if (this.refreshDirtyRecords()) {
          this.countWork("incrementalFlushCount");
          this.mutationBatches += 1;
          return;
        }
        this.pruneNeeded = true;
      }
      // Observe Stop before discovery advances knownLatest, including when
      // Stop and the first answer arrive in the same mutation batch.
      this.observeStop();
      this.countWork("fullFlushCount");
      this.mutationBatches += 1;
      const scanContext = adapter.createScanContext();
      const previousNextId = this.nextId;
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
      if (changed) this.reorder();
      this.syncIntentKeys();
      if (changed) {
        // Removing the real tail must not turn the remaining historical window
        // into "recent" answers. Match the known tail using current identities;
        // only a unique stable identity can reconnect it after a DOM remount.
        if (!this.knownLatest) {
          this.setRecent();
          const last = this.order[this.order.length - 1];
          if (last?.id > previousNextId) this.bindStopTarget(last);
        }
        else {
          const matches = this.order.filter(record => record.identity === this.knownLatest.identity &&
            (record.id === this.knownLatest.id || Boolean(record.identity)));
          if (matches.length === 1) {
            const last = this.order[this.order.length - 1];
            if (last !== matches[0] && last.id > previousNextId) {
              // New replies add intentions; they do not reset earlier choices.
              // Remounts restore an existing rank instead of becoming newest.
              const added = this.order.slice(matches[0].order + 1).filter(record => record.id > previousNextId);
              if (this.settings.keepRecent > 0) {
                for (const record of added.slice(-this.settings.keepRecent)) this.rememberOpen(record);
              }
              this.bindStopTarget(last);
              this.rememberLatest();
            }
            else this.knownLatest.id = matches[0].id;
          }
        }
      }
      this.applyPolicy(false);
    }

    refreshDirtyRecords() {
      for (const record of this.dirtyRecords) {
        if (!record.element.isConnected || this.records.get(record.element) !== record ||
            record.control.parentNode !== record.element) return false;
      }
      for (const record of this.dirtyRecords) {
        // Generation end runs the full policy and refreshes the final preview.
        // No retained node set or repeated preview extraction during streaming.
        if (record.dirty && !record.streaming) {
          record.preview = adapter.preview(record.element);
          record.dirty = false;
          this.countWork("previewRefreshCount");
          this.renderRecord(record, record.element.getAttribute("data-cgf-collapsed") === "false");
        }
      }
      this.dirtyRecords.clear();
      return true;
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

    applyPolicy(observeStop = true) {
      if (!this.active) return;
      if (observeStop) this.observeStop();
      const streaming = adapter.streamingElements(document, this.records);
      const stopTarget = this.stopTarget === null ? null : this.order.find(record => record.intentKey === this.stopTarget);
      if (stopTarget) streaming.add(stopTarget.element);
      const selection = document.getSelection();
      const focused = document.activeElement;
      for (const record of this.order) {
        record.wantsOpen = this.openIntents.has(record.intentKey);
        record.rank = this.openIntents.get(record.intentKey) || 0;
        record.unsupported = adapter.hasDirectText(record.element);
        record.streaming = streaming.has(record.element);
        record.reason = record.unsupported ? "保持原样" : record.streaming ? "生成中" :
          this.interactionReason(record, selection, focused);
        record.protected = Boolean(record.reason);
        if (record.dirty && !record.streaming) {
          record.preview = adapter.preview(record.element);
          record.dirty = false;
          this.countWork("previewRefreshCount");
        }
      }
      const expanded = shared.planExpanded(this.order, this.settings.maxExpanded);
      for (const record of this.order) this.renderRecord(record, expanded.has(record.id));
      this.dirtyRecords.clear();
      this.policyNeeded = false;
    }

    renderRecord(record, isOpen) {
      // A click/settings policy can run before the scheduled toolbar repair.
      // Every render path must finish that repair before clearing pending work.
      if (record.control.parentNode !== record.element) record.element.prepend(record.control);
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

    onClick(event) {
      if (!this.active || !(event.target instanceof Element)) return;
      const button = event.target.closest("[data-cgf-toggle]");
      if (!button || button.disabled) return;
      const record = this.records.get(button.closest("[data-cgf-message]"));
      if (!record || record.control !== button) return;
      event.preventDefault();
      event.stopPropagation();
      const before = button.getBoundingClientRect().top;
      if (record.element.getAttribute("data-cgf-collapsed") === "true") this.rememberOpen(record);
      else this.openIntents.delete(record.intentKey);
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
      const recentChanged = next.keepRecent !== this.settings.keepRecent;
      this.settings = next;
      if (!changed) return;
      if (!next.enabled) this.stopActive();
      else {
        if (!wasEnabled) this.paused = false;
        if (!this.paused) {
          if (!this.active) this.startActive();
          else {
            if (recentChanged) this.setRecent();
            else this.trimOpenIntents();
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
        schemaVersion: 3,
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
        maintenance: {
          bodyObserverConnected: this.bodyObserverConnected,
          pageSuspended: this.pageSuspended,
          disconnectedRegisteredCount: this.records.size - connectedRegisteredCount,
          openIntentCount: this.openIntents.size,
          pendingScanRootCount: this.scanRoots.size,
          pendingDirtyRecordCount: this.dirtyRecords.size,
          fullScanPending: this.fullScan,
          policyPending: this.policyNeeded,
          timerPending: this.timer !== null,
          ...this.workCounts
        },
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
        this.openIntents.clear();
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
