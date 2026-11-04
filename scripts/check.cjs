"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, pkg.version);
assert.deepEqual(manifest.permissions, ["storage"]);
assert.deepEqual(manifest.content_scripts[0].matches, ["https://chatgpt.com/*"]);
assert.equal(manifest.background, undefined, "A persistent background component is unnecessary.");
const referenced = [manifest.action.default_popup, ...Object.values(manifest.icons),
  ...manifest.content_scripts.flatMap(item => [...item.js, ...item.css])];
for (const file of referenced) assert.ok(fs.existsSync(path.join(root, file)), `Missing manifest file: ${file}`);
for (const name of fs.readdirSync(path.join(root, "src"))) {
  if (!name.endsWith(".js")) continue;
  const source = fs.readFileSync(path.join(root, "src", name), "utf8");
  new vm.Script(source, { filename: name });
  assert.ok(!/\beval\s*\(|new\s+Function\s*\(/.test(source), `${name}: dynamic code is forbidden`);
  assert.ok(!/\b(?:fetch|XMLHttpRequest|WebSocket)\b/.test(source), `${name}: extension has no network calls`);
}
const html = fs.readFileSync(path.join(root, manifest.action.default_popup), "utf8");
assert.ok(!/\bon\w+\s*=/i.test(html), "Inline event handlers are not allowed in the popup.");
console.log("Manifest, permissions, referenced files, and JavaScript syntax: OK");
