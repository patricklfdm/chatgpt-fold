/* Shared by the content script, popup, and dependency-free Node tests. */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CGFShared = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  const VERSION = "0.1.7";
  const SETTINGS_KEY = "cgf.settings.v1";
  const DEFAULT_SETTINGS = Object.freeze({ enabled: true, keepRecent: 1, maxExpanded: 1 });

  function integer(value, fallback, min, max) {
    if (value === "" || value === null || typeof value === "boolean") return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback;
  }

  function normalizeSettings(value) {
    const input = value && typeof value === "object" ? value : {};
    const keepRecent = integer(input.keepRecent, DEFAULT_SETTINGS.keepRecent, 0, 5);
    const maxExpanded = Math.max(keepRecent, integer(input.maxExpanded, DEFAULT_SETTINGS.maxExpanded, 1, 5));
    return {
      enabled: typeof input.enabled === "boolean" ? input.enabled : DEFAULT_SETTINGS.enabled,
      keepRecent,
      maxExpanded
    };
  }

  function compactPreview(text, limit = 86) {
    const clean = String(text || "").replace(/[\u0000-\u001f\u007f\s]+/gu, " ").trim();
    const characters = Array.from(clean);
    return characters.length > limit ? characters.slice(0, limit).join("") + "…" : clean;
  }

  // The cap applies to ordinary answers. Streaming / selection / editing are
  // temporary exceptions, so an interaction is never cut off to meet the cap.
  function planExpanded(records, maxExpanded) {
    const protectedRecords = records.filter(record => record.protected);
    const ordinary = records
      .filter(record => !record.protected && record.wantsOpen)
      .sort((a, b) => (b.rank - a.rank) || (b.order - a.order));
    return new Set([
      ...protectedRecords.map(record => record.id),
      ...ordinary.slice(0, integer(maxExpanded, 1, 1, 5)).map(record => record.id)
    ]);
  }

  return Object.freeze({ VERSION, SETTINGS_KEY, DEFAULT_SETTINGS, normalizeSettings, compactPreview, planExpanded });
});
