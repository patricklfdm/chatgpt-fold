(() => {
  "use strict";

  const shared = globalThis.CGFShared;
  const ui = {
    version: document.getElementById("extension-version"),
    enabled: document.getElementById("enabled"),
    keepRecent: document.getElementById("keep-recent"),
    maxExpanded: document.getElementById("max-expanded"),
    state: document.getElementById("page-state"),
    total: document.getElementById("stat-total"),
    collapsed: document.getElementById("stat-collapsed"),
    expanded: document.getElementById("stat-expanded"),
    note: document.getElementById("page-note"),
    collapse: document.getElementById("collapse-all"),
    recent: document.getElementById("expand-recent"),
    pause: document.getElementById("pause-resume"),
    rescan: document.getElementById("rescan"),
    diagnosticsToggle: document.getElementById("show-diagnostics"),
    diagnosticsPanel: document.getElementById("diagnostics-panel"),
    diagnosticsReport: document.getElementById("diagnostics-report"),
    diagnosticsCopy: document.getElementById("copy-diagnostics"),
    feedback: document.getElementById("feedback"),
  };
  let settings = null;
  let status = null;
  let tabId = null;
  let busy = false;
  let connected = false;

  function feedback(message, isError = false) {
    ui.feedback.textContent = message;
    ui.feedback.dataset.error = String(isError);
  }

  function setSelectValue(select, value) {
    // A future version or manually edited preference may contain 4.
    // Preserve valid saved values without displaying an empty selection.
    const match = Array.from(select.options).some((option) => Number(option.value) === value);
    if (!match) {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = `${value} 条`;
      const next = Array.from(select.options).find((item) => Number(item.value) > value);
      select.insertBefore(option, next || null);
    }
    select.value = String(value);
  }

  function renderSettings() {
    if (!settings) return;
    ui.enabled.checked = settings.enabled;
    setSelectValue(ui.keepRecent, settings.keepRecent);
    setSelectValue(ui.maxExpanded, settings.maxExpanded);
  }

  function renderControls() {
    const ready = Boolean(settings) && !busy;
    ui.enabled.disabled = !ready;
    ui.keepRecent.disabled = !ready;
    ui.maxExpanded.disabled = !ready;
    const compatible = scriptCompatible();
    const canAct = ready && connected && compatible && settings.enabled && status?.enabled !== false;
    ui.collapse.disabled = !canAct || status?.paused === true || status?.active === false || !(status?.total > 0);
    ui.recent.disabled = !canAct || status?.paused === true || status?.active === false || !(status?.total > 0);
    ui.pause.disabled = !canAct;
    ui.pause.textContent = status?.paused ? "继续自动折叠" : "临时恢复本页全部回答";
    // Rescanning does not enable folding or resume a deliberately paused page.
    ui.rescan.disabled = !ready || (connected && !compatible);
    ui.diagnosticsToggle.disabled = !ready || !connected || !compatible;
    ui.diagnosticsCopy.disabled = busy || !ui.diagnosticsReport.value;
  }

  function scriptCompatible() {
    return Boolean(shared && status?.version === shared.VERSION);
  }

  function clearDiagnostics() {
    ui.diagnosticsReport.value = "";
    ui.diagnosticsPanel.hidden = true;
    ui.diagnosticsToggle.setAttribute("aria-expanded", "false");
    ui.diagnosticsToggle.textContent = "查看诊断";
  }

  function count(value) {
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value).toLocaleString("zh-CN") : "—";
  }

  function renderStatus() {
    ui.total.textContent = count(status?.total);
    ui.collapsed.textContent = count(status?.collapsed);
    ui.expanded.textContent = count(status?.expanded);
    if (!connected) {
      ui.state.textContent = "未连接";
      ui.state.dataset.state = "disconnected";
      ui.note.textContent = "请打开 chatgpt.com 的对话页面并刷新，再打开此面板。";
    } else if (!scriptCompatible()) {
      ui.state.textContent = "请刷新页面";
      ui.state.dataset.state = "stale";
      ui.note.textContent = `扩展已更新为 ${shared.VERSION}，当前页面仍在使用旧版脚本。请刷新 ChatGPT 页面，再打开此面板。`;
    } else if (!settings?.enabled || status?.enabled === false) {
      ui.state.textContent = "已关闭";
      ui.state.dataset.state = "disabled";
      ui.note.textContent = "自动折叠已关闭，页面恢复正常显示。";
    } else if (status.paused) {
      ui.state.textContent = "本页已暂停";
      ui.state.dataset.state = "paused";
      ui.note.textContent = "本页回答已恢复。点击下方按钮继续自动折叠。";
    } else if (status.active === false) {
      ui.state.textContent = "扫描未启动";
      ui.state.dataset.state = "inactive";
      ui.note.textContent = "设置已开启，但页面扫描尚未启动。请点“重新扫描”；若仍未恢复，请刷新页面。";
    } else if (!(status.total > 0)) {
      ui.state.textContent = "未识别到回答";
      ui.state.dataset.state = "empty";
      ui.note.textContent = "当前没有匹配到回答。先点“重新扫描”；若页面已有回答仍为 0，请查看并复制诊断。";
    } else {
      ui.state.textContent = "已启用";
      ui.state.dataset.state = "active";
      const notes = [];
      if (status.protected > 0) notes.push(`${count(status.protected)} 条回答暂受保护，可能超出展开上限。`);
      if (status.unsupported > 0) notes.push(`${count(status.unsupported)} 条内容结构暂不支持，已保留原样。`);
      if (!notes.length) {
        notes.push("点击回答首行可展开，再次点击可收起。");
      }
      ui.note.textContent = notes.join(" ");
    }
    renderControls();
  }

  async function request(payload) {
    if (!Number.isInteger(tabId)) throw new Error("No active tab");
    const result = await chrome.tabs.sendMessage(tabId, payload);
    if (!result || result.ok !== true) throw new Error("Content script unavailable");
    return result;
  }

  async function message(payload) {
    const result = await request(payload);
    status = result;
    connected = true;
    renderStatus();
  }

  async function getStatus() {
    try {
      await message({ type: "CGF_GET_STATUS" });
      return true;
    } catch {
      connected = false;
      status = null;
      clearDiagnostics();
      renderStatus();
      return false;
    }
  }

  async function saveSettings(key, value) {
    if (busy || !settings) return;
    busy = true;
    clearDiagnostics();
    renderControls();
    const previous = settings;
    let note = "设置已保存。";
    try {
      // Read the latest stored object before updating one field, so another
      // popup's changes are not overwritten with an old local snapshot.
      const saved = await chrome.storage.local.get(shared.SETTINGS_KEY);
      const latest = shared.normalizeSettings(saved[shared.SETTINGS_KEY]);
      const draft = { ...latest, [key]: value };
      if (key === "maxExpanded" && draft.keepRecent > value) {
        draft.keepRecent = value;
        note = `默认展开数量已同步为 ${value} 条。`;
      }
      const normalized = shared.normalizeSettings(draft);
      if (key === "keepRecent" && normalized.maxExpanded > latest.maxExpanded) {
        note = `同时展开上限已同步为 ${normalized.maxExpanded} 条。`;
      }
      await chrome.storage.local.set({ [shared.SETTINGS_KEY]: normalized });
      settings = normalized;
      renderSettings();
      feedback(note);
      // Exactly one refresh per settings change; no interval or polling.
      await getStatus();
    } catch {
      settings = previous;
      renderSettings();
      feedback("设置保存失败，请关闭面板后重试。", true);
    } finally {
      busy = false;
      renderControls();
    }
  }

  async function runCommand(command) {
    if (busy || !settings) return;
    if (command !== "rescan" && (!connected || !settings.enabled || !scriptCompatible())) return;
    busy = true;
    clearDiagnostics();
    renderControls();
    try {
      if (!connected) await getStatus();
      if (!connected) {
        feedback("未能连接当前页面，请刷新 ChatGPT 对话页面后重试。", true);
        return;
      }
      if (!scriptCompatible()) {
        feedback("请刷新 ChatGPT 页面，让新版脚本生效。", true);
        return;
      }
      // Commands already return the updated status; no second request needed.
      await message({ type: "CGF_COMMAND", command });
      const labels = {
        "collapse-all": "已收起可折叠的回答，受保护的内容保留展开。",
        recent: `已按最近 ${settings.keepRecent} 条的设置整理回答。`,
        restore: "本页已临时恢复；这不会修改其他标签页的设置。",
        resume: "本页已继续自动折叠。",
        rescan: status.total > 0
          ? `已重新扫描，识别到 ${count(status.total)} 条回答。`
          : "重新扫描后仍未识别到回答。请查看诊断报告。",
      };
      feedback(labels[command] || "操作完成。");
    } catch {
      connected = false;
      status = null;
      clearDiagnostics();
      renderStatus();
      feedback("未能操作当前页面，请刷新对话页面后重试。", true);
    } finally {
      busy = false;
      renderControls();
    }
  }

  async function toggleDiagnostics() {
    if (busy || !connected || !scriptCompatible()) return;
    if (!ui.diagnosticsPanel.hidden) {
      clearDiagnostics();
      renderControls();
      return;
    }
    busy = true;
    renderControls();
    try {
      const result = await request({ type: "CGF_GET_DIAGNOSTICS" });
      if (!result.diagnostics || typeof result.diagnostics !== "object" || Array.isArray(result.diagnostics)) {
        throw new Error("Diagnostics unavailable");
      }
      // The content script exports only an explicit whitelist of status fields
      // and selector counts. Keep the report in this popup; never persist it.
      ui.diagnosticsReport.value = JSON.stringify(result.diagnostics, null, 2);
      ui.diagnosticsPanel.hidden = false;
      ui.diagnosticsToggle.setAttribute("aria-expanded", "true");
      ui.diagnosticsToggle.textContent = "收起诊断";
      feedback("诊断已生成。点击“复制报告”即可用于反馈问题。");
    } catch {
      clearDiagnostics();
      feedback("诊断读取失败，请刷新 ChatGPT 页面后重试。", true);
    } finally {
      busy = false;
      renderControls();
    }
  }

  async function copyDiagnostics() {
    if (busy || !ui.diagnosticsReport.value) return;
    busy = true;
    renderControls();
    try {
      // This separate click preserves clipboard user activation. No clipboard
      // permission or background copy operation is needed.
      await navigator.clipboard.writeText(ui.diagnosticsReport.value);
      feedback("诊断报告已复制，不含对话正文。");
    } catch {
      ui.diagnosticsReport.focus();
      ui.diagnosticsReport.select();
      feedback("自动复制不可用，报告已选中。请按 Ctrl+C（Mac 用 ⌘C）复制。", true);
    } finally {
      busy = false;
      renderControls();
    }
  }

  async function initialize() {
    if (!shared) {
      ui.state.textContent = "加载失败";
      ui.state.dataset.state = "disconnected";
      ui.note.textContent = "扩展文件不完整，请重新加载扩展。";
      feedback("无法读取扩展配置。", true);
      return;
    }
    ui.version.textContent = shared.VERSION;
    try {
      const saved = await chrome.storage.local.get(shared.SETTINGS_KEY);
      settings = shared.normalizeSettings(saved[shared.SETTINGS_KEY]);
      renderSettings();
      renderControls();
    } catch {
      ui.state.textContent = "加载失败";
      ui.state.dataset.state = "disconnected";
      ui.note.textContent = "无法读取本机设置，请重新加载扩展。";
      feedback("设置读取失败。", true);
      return;
    }
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = tabs[0]?.id ?? null;
      await getStatus();
    } catch {
      connected = false;
      status = null;
      renderStatus();
    }
  }

  ui.enabled.addEventListener("change", () => saveSettings("enabled", ui.enabled.checked));
  ui.keepRecent.addEventListener("change", () => saveSettings("keepRecent", Number(ui.keepRecent.value)));
  ui.maxExpanded.addEventListener("change", () => saveSettings("maxExpanded", Number(ui.maxExpanded.value)));
  ui.collapse.addEventListener("click", () => runCommand("collapse-all"));
  ui.recent.addEventListener("click", () => runCommand("recent"));
  ui.pause.addEventListener("click", () => runCommand(status?.paused ? "resume" : "restore"));
  ui.rescan.addEventListener("click", () => runCommand("rescan"));
  ui.diagnosticsToggle.addEventListener("click", toggleDiagnostics);
  ui.diagnosticsCopy.addEventListener("click", copyDiagnostics);
  initialize();
})();
