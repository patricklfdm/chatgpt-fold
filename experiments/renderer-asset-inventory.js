// Paste once in the ChatGPT page's top DevTools Console; no element selection.
// Exports public static script URLs only. No fetch, DOM writes, timers or hooks.
(() => {
  "use strict";
  const limits = { scriptElements: 512, resourceEntries: 4096, assets: 256,
    inputUrlLength: 4096, urlLength: 1024 };
  const report = {
    schemaVersion: 1, probeVersion: "0.2.0-assets.1", outcome: "completed", reason: null,
    limits, counts: { scriptElements: 0, resourceEntries: 0,
      inspectedScriptElements: 0, inspectedResourceEntries: 0, includedAssets: 0 },
    truncated: false, sourceWarnings: [], scripts: [],
    coverage: "current-records-only", nativeEntry: "not-tested"
  };
  const assets = new Map();

  function publish() {
    report.scripts = Array.from(assets, ([url, sources]) => ({ url, sources: [...sources].sort() }))
      .sort((a, b) => a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
    report.counts.includedAssets = report.scripts.length;
    const json = JSON.stringify(report, null, 2);
    globalThis.__CGF_ASSET_REPORT_V1__ = json;
    console.log(json);
    console.info("CGF 文件清单已生成。复制结果：copy(__CGF_ASSET_REPORT_V1__)");
  }

  function add(raw, source) {
    if (typeof raw !== "string" || !raw) return;
    if (raw.length > limits.inputUrlLength) { report.truncated = true; return; }
    let url;
    try { url = new URL(raw); } catch { return; }
    if (url.username || url.password) return;
    const path = url.pathname;
    const allowed =
      (url.origin === "https://chatgpt.com" && /^\/(?:cdn\/assets|_next\/static)\//.test(path)) ||
      (url.origin === "https://cdn.oaistatic.com" && path.startsWith("/assets/"));
    if (!allowed || !/^\/[A-Za-z0-9_./-]+\.m?js$/.test(path)) return;
    const clean = url.origin + path;
    if (clean.length > limits.urlLength) { report.truncated = true; return; }
    if (assets.has(clean)) { assets.get(clean).add(source); return; }
    if (assets.size >= limits.assets) { report.truncated = true; return; }
    assets.set(clean, new Set([source]));
  }

  try {
    if (location.origin !== "https://chatgpt.com" ||
        !/^\/(?:c\/[^/]+|g\/[^/]+\/c\/[^/]+)\/?$/.test(location.pathname)) {
      report.outcome = "rejected"; report.reason = "wrong_page";
    } else if (window.top !== window) {
      report.outcome = "rejected"; report.reason = "not_top_frame";
    } else {
      try {
        const scripts = document.scripts;
        const count = scripts.length;
        report.counts.scriptElements = count;
        const start = Math.max(0, count - limits.scriptElements);
        if (start) report.truncated = true;
        for (let i = start; i < count; i += 1) {
          report.counts.inspectedScriptElements += 1;
          add(scripts[i].src, "script-element");
        }
      } catch { report.sourceWarnings.push("script-elements-unavailable"); }

      try {
        const entries = performance.getEntriesByType("resource");
        const count = entries.length;
        report.counts.resourceEntries = count;
        const start = Math.max(0, count - limits.resourceEntries);
        if (start) report.truncated = true;
        for (let i = start; i < count; i += 1) {
          report.counts.inspectedResourceEntries += 1;
          add(entries[i].name, "resource-timing");
        }
      } catch { report.sourceWarnings.push("resource-timing-unavailable"); }
    }
  } catch {
    report.outcome = "rejected"; report.reason = "inventory_error";
  }
  publish();
})();
