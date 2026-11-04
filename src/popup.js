(() => {
  "use strict";

  const shared = globalThis.CGFShared;
  const ui = {
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
    const canAct = ready && connected && settings.enabled && status?.enabled !== false;
    ui.collapse.disabled = !canAct || status?.paused === true;
    ui.recent.disabled = !canAct || status?.paused === true;
    ui.pause.disabled = !canAct;
    ui.pause.textContent = status?.paused ? "继续自动折叠" : "临时恢复本页全部回答";
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
    } else if (!settings?.enabled || status?.enabled === false) {
      ui.state.textContent = "已关闭";
      ui.state.dataset.state = "disabled";
      ui.note.textContent = "自动折叠已关闭，页面恢复正常显示。";
    } else if (status.paused) {
      ui.state.textContent = "本页已暂停";
      ui.state.dataset.state = "paused";
      ui.note.textContent = "本页回答已恢复。点击下方按钮继续自动折叠。";
    } else {
      ui.state.textContent = "已启用";
      ui.state.dataset.state = "active";
      const notes = [];
      if (status.protected > 0) notes.push(`${count(status.protected)} 条回答暂受保护，可能超出展开上限。`);
      if (status.unsupported > 0) notes.push(`${count(status.unsupported)} 条内容结构暂不支持，已保留原样。`);
      if (!notes.length) {
        notes.push(status.total > 0 ? "点击回答首行可展开，再次点击可收起。" : "尚未识别到回答，发送消息后会自动处理。");
      }
      ui.note.textContent = notes.join(" ");
    }
    renderControls();
  }

  async function message(payload) {
    if (!Number.isInteger(tabId)) throw new Error("No active tab");
    const result = await chrome.tabs.sendMessage(tabId, payload);
    if (!result || result.ok !== true) throw new Error("Content script unavailable");
    status = result;
    connected = true;
    renderStatus();
  }

  async function getStatus() {
    try {
      await message({ type: "CGF_GET_STATUS" });
    } catch {
      connected = false;
      status = null;
      renderStatus();
    }
  }

  async function saveSettings(key, value) {
    if (busy || !settings) return;
    busy = true;
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
    if (busy || !connected || !settings?.enabled) return;
    busy = true;
    renderControls();
    try {
      // Commands already return the updated status; no second request needed.
      await message({ type: "CGF_COMMAND", command });
      const labels = {
        "collapse-all": "已收起可折叠的回答，受保护的内容保留展开。",
        recent: `已按最近 ${settings.keepRecent} 条的设置整理回答。`,
        restore: "本页已临时恢复；这不会修改其他标签页的设置。",
        resume: "本页已继续自动折叠。",
      };
      feedback(labels[command] || "操作完成。");
    } catch {
      connected = false;
      status = null;
      renderStatus();
      feedback("未能操作当前页面，请刷新对话页面后重试。", true);
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
  initialize();
})();
