"use strict";

// Windows integration smoke. CreateProcessW(CREATE_SUSPENDED) creates an actual
// process with an OS PID/counters; its application entry point is NEVER run.
// Thus even an installed chrome.exe cannot open a profile, network or tabs.
// If Chrome is not installed use a disposable, explicitly labelled copy of
// Node named chromium.exe to test the same OS counter path. Neither is a test
// of renderer-specific access on a signed-in user's Chrome.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { openWindowsReader } = require("../experiments/process-memory/windows-reader.cjs");

const fixture = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CgfSuspendedImage {
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint cb;
    public IntPtr reserved, desktop, title;
    public uint x, y, cx, cy, cols, rows, fill, flags;
    public ushort show, reservedBytes;
    public IntPtr extra, input, output, error;
  }
  [StructLayout(LayoutKind.Sequential)] struct Created {
    public IntPtr process, thread;
    public uint pid, tid;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  static extern bool CreateProcessW(string app, IntPtr cmd, IntPtr procAttr,
    IntPtr threadAttr, bool inherit, uint flags, IntPtr env, string cwd,
    ref Info startup, out Created result);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  public static void Run(string image) {
    Info si = new Info(); si.cb = (uint)Marshal.SizeOf(typeof(Info));
    Created proc;
    if (!CreateProcessW(image, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, false,
        4, IntPtr.Zero, null, ref si, out proc)) throw new Exception("fixture-create");
    try {
      Console.Out.WriteLine(proc.pid); Console.Out.Flush();
      Console.In.ReadLine();
    } finally {
      bool killed = TerminateProcess(proc.process, 0);
      uint wait = WaitForSingleObject(proc.process, 5000);
      CloseHandle(proc.thread); CloseHandle(proc.process);
      if (!killed || wait != 0) throw new Exception("fixture-stop");
    }
  }
}
'@
[CgfSuspendedImage]::Run($env:CGF_TEST_IMAGE)
`;

async function bounded(promise, ms, why) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(why)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function startFixture(image) {
  const exe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const child = spawn(exe, ["-NoProfile", "-NonInteractive", "-NoLogo", "-Command", fixture],
    { windowsHide: true, stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, CGF_TEST_IMAGE: image } });
  const closed = once(child, "close");
  // Attach a handler immediately in case spawn fails before stdout is read.
  closed.catch(() => {});
  child.stdin.on("error", () => {});
  async function stop() {
    child.stdin.end();
    const [code] = await bounded(closed, 10000, "Fixture did not close");
    assert.equal(code, 0, "Suspended image fixture creation or cleanup failed");
  }
  try {
    let output = "";
    const id = await bounded(new Promise((resolve, reject) => {
      child.stdout.on("data", chunk => {
        output += chunk.toString("ascii");
        if (output.length > 32) return reject(new Error("Invalid fixture reply"));
        if (output.includes("\n")) {
          if (!/^[1-9][0-9]{0,9}\r?\n$/.test(output)) return reject(new Error("Invalid fixture PID"));
          resolve(Number(output.trim()));
        }
      });
      closed.then(() => reject(new Error("Fixture exited before PID")), reject);
    }), 30000, "Fixture startup timed out");
    return { id, stop };
  } catch (err) {
    child.stdin.end(); // EOF also terminates a child created just after timeout.
    throw err;
  }
}

async function main() {
  if (process.platform !== "win32") {
    console.log("NOT RUN: requires real Windows process counters."); process.exitCode = 2; return;
  }
  if (/^node$/i.test(path.parse(process.execPath).name)) {
    await assert.rejects(openWindowsReader(process.pid), { code: "not-chrome" });
  }
  await assert.rejects(openWindowsReader(-1), { code: "invalid-pid" });
  const candidates = [process.env.CHROME_PATH, ...[process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]
    .filter(Boolean).map(dir => path.join(dir, "Google", "Chrome", "Application", "chrome.exe"))];
  let image = candidates.find(file => file && /^(?:chrome|chromium)\.exe$/i.test(path.basename(file)) && fs.existsSync(file));
  let temp;
  const kind = image ? "installed Chrome image (suspended)" : "surrogate Node image named chromium.exe (suspended)";
  if (!image) {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), "cgf-counter-smoke-"));
    image = path.join(temp, "chromium.exe"); fs.copyFileSync(process.execPath, image);
  }
  let target, reader;
  try {
    target = await startFixture(image);
    reader = await openWindowsReader(target.id);
    assert.equal(reader.metric, "windows-private-bytes");
    for (let i = 0; i < 2; i++) {
      const sample = await reader.read();
      assert.deepEqual(Object.keys(sample).sort(), ["primaryBytes", "workingSetBytes"]);
      for (const value of Object.values(sample)) assert.ok(Number.isSafeInteger(value) && value >= 0);
      assert.ok(sample.primaryBytes > 0, "Expected the controlled process to have private commit");
    }
    await target.stop(); target = null;
    // A terminated PID is not a zero-valued sample or an automatic rebind.
    await assert.rejects(reader.read(), err => ["target-exited", "identity-changed"].includes(err.code));
    await reader.close(); await reader.close();
    console.log("PASS: Windows counter protocol, " + kind + ", two samples, process exit, cleanup.");
  } finally {
    try { if (target) await target.stop(); }
    finally {
      try { if (reader) await reader.close(); }
      finally { if (temp) fs.rmSync(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
    }
  }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
