"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeSettings, planExpanded, compactPreview } = require("../src/shared.js");

test("corrupt or excessive persisted settings cannot remove the expansion cap", () => {
  assert.deepEqual(normalizeSettings(null), { enabled: true, keepRecent: 1, maxExpanded: 1 });
  assert.deepEqual(normalizeSettings({ enabled: false, keepRecent: 900, maxExpanded: Infinity }),
    { enabled: false, keepRecent: 5, maxExpanded: 5 });
  assert.deepEqual(normalizeSettings({ enabled: "false", keepRecent: -8, maxExpanded: 0 }),
    { enabled: true, keepRecent: 0, maxExpanded: 1 });
});

test("opening an older answer can replace a newer one without raising the cap", () => {
  const records = [
    { id: "old", order: 1, wantsOpen: true, rank: 20, protected: false },
    { id: "new", order: 2, wantsOpen: true, rank: 10, protected: false }
  ];
  assert.deepEqual([...planExpanded(records, 1)], ["old"]);
});

test("streaming and selected answers are temporary exceptions, not evictions", () => {
  const records = [
    { id: "selected", order: 1, wantsOpen: false, rank: 0, protected: true },
    { id: "opened", order: 2, wantsOpen: true, rank: 50, protected: false },
    { id: "streaming", order: 3, wantsOpen: true, rank: 60, protected: true }
  ];
  assert.deepEqual([...planExpanded(records, 1)], ["selected", "streaming", "opened"]);
  records[2].protected = false;
  assert.deepEqual([...planExpanded(records, 1)], ["selected", "streaming"]);
});

test("an explicit collapse remains collapsed after a temporary protection ends", () => {
  const record = { id: "a", order: 1, wantsOpen: false, rank: 1, protected: true };
  assert.ok(planExpanded([record], 1).has("a"));
  record.protected = false;
  assert.equal(planExpanded([record], 1).size, 0);
});

test("preview shortening preserves whole emoji and never interprets markup", () => {
  assert.equal(compactPreview("  第一行\n 第二行 "), "第一行 第二行");
  assert.equal(compactPreview("😀😀😀", 2), "😀😀…");
  assert.equal(compactPreview("<script>alert(1)</script>"), "<script>alert(1)</script>");
});
