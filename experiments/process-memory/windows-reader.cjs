"use strict";

const { spawn } = require("node:child_process");
const { win32 } = require("node:path");

// Windows PowerShell, in memory, with a constant command. Input is one numeric
// PID via the environment and one-letter read/quit commands via stdin. The
// helper has no file/network/clipboard operations. Do not forward stderr.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
function Stop-Cgf([string]$why) {
  [Console]::Out.WriteLine('E ' + $why)
  [Console]::Out.Flush()
  exit 1
}
function Find-CgfProcess([int]$id) {
  try { return [System.Diagnostics.Process]::GetProcessById($id) }
  catch {
    $inner = $_.Exception.GetBaseException()
    if ($inner -is [ArgumentException]) { Stop-Cgf 'target-exited' }
    throw
  }
}
try {
  $number = [int]::Parse($env:CGF_MEMORY_TARGET_ID, [Globalization.CultureInfo]::InvariantCulture)
  $first = Find-CgfProcess $number
  try {
    $first.Refresh()
    if ($first.HasExited) { Stop-Cgf 'target-exited' }
    if ($first.ProcessName -notin @('chrome', 'chromium')) { Stop-Cgf 'not-chrome' }
    $born = $first.StartTime.ToUniversalTime().Ticks
  } finally { $first.Dispose() }
  [Console]::Out.WriteLine('READY')
  [Console]::Out.Flush()
  while ($null -ne ($command = [Console]::In.ReadLine())) {
    if ($command -eq 'Q') { break }
    if ($command -ne 'R') { Stop-Cgf 'reader-failed' }
    $current = Find-CgfProcess $number
    try {
      $current.Refresh()
      if ($current.HasExited) { Stop-Cgf 'target-exited' }
      if ($current.StartTime.ToUniversalTime().Ticks -ne $born) { Stop-Cgf 'identity-changed' }
      $privateBytes = $current.PrivateMemorySize64
      $workingBytes = $current.WorkingSet64
      # Recheck using a fresh Process object: a PID could be recycled while
      # querying process counters. Never resume the run for the new identity.
      $check = Find-CgfProcess $number
      try {
        if ($check.StartTime.ToUniversalTime().Ticks -ne $born) { Stop-Cgf 'identity-changed' }
        if ($current.HasExited -or $check.HasExited) { Stop-Cgf 'target-exited' }
      } finally { $check.Dispose() }
      $culture = [Globalization.CultureInfo]::InvariantCulture
      [Console]::Out.WriteLine('S ' + $privateBytes.ToString($culture) + ' ' + $workingBytes.ToString($culture))
      [Console]::Out.Flush()
    } finally { $current.Dispose() }
  }
} catch {
  $err = $_.Exception.GetBaseException()
  if ($err -is [UnauthorizedAccessException] -or ($err -is [ComponentModel.Win32Exception] -and $err.NativeErrorCode -eq 5)) {
    Stop-Cgf 'access-denied'
  }
  if ($err -is [InvalidOperationException]) { Stop-Cgf 'target-exited' }
  Stop-Cgf 'reader-failed'
}
`;

function problem(code) { return Object.assign(new Error(code), { code }); }
const allowed = /^E (target-exited|identity-changed|not-chrome|access-denied|reader-failed)$/;

async function openWindowsReader(pid) {
  if (process.platform !== "win32") throw problem("reader-unavailable");
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fffffff) throw problem("invalid-pid");
  const exe = win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  let child;
  try {
    child = spawn(exe, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", SCRIPT], {
      shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, CGF_MEMORY_TARGET_ID: String(pid) }
    });
  } catch { throw problem("reader-unavailable"); }

  let terminal = null, ended = false, closing = false, closeTask = null;
  let pending = null, buf = "", notifyEnd;
  const closed = new Promise(resolve => { notifyEnd = resolve; });
  function fail(code) {
    terminal ??= code;
    if (pending) {
      clearTimeout(pending.timer);
      const { reject } = pending; pending = null;
      reject(problem(terminal));
    }
    if (!ended && !closing) child.kill();
  }
  function startWait(kind, timeout) {
    return new Promise((resolve, reject) => {
      pending = { kind, resolve, reject, timer: setTimeout(() => fail("reader-failed"), timeout) };
    });
  }
  function line(value) {
    if (closing || terminal) return;
    const err = allowed.exec(value);
    if (err) return fail(err[1]);
    if (!pending) return fail("reader-failed");
    let result;
    if (pending.kind === "ready") {
      if (value !== "READY") return fail("reader-failed");
    } else {
      const match = /^S ([0-9]{1,16}) ([0-9]{1,16})$/.exec(value);
      if (!match) return fail("reader-failed");
      const primaryBytes = Number(match[1]), workingSetBytes = Number(match[2]);
      if (![primaryBytes, workingSetBytes].every(Number.isSafeInteger)) return fail("reader-failed");
      result = { primaryBytes, workingSetBytes };
    }
    const req = pending; pending = null; clearTimeout(req.timer); req.resolve(result);
  }
  child.stdout.on("data", chunk => {
    if (closing || terminal) return;
    if (buf.length + chunk.length > 256) return fail("reader-failed");
    buf += chunk.toString("latin1");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const value = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1);
      line(value);
    }
  });
  child.stdin.on("error", () => { if (!closing) fail("reader-failed"); });
  child.stdout.on("error", () => { if (!closing) fail("reader-failed"); });
  child.once("error", () => { if (!closing) fail("reader-unavailable"); });
  child.once("close", () => {
    ended = true;
    if (!closing) fail(terminal || "reader-failed");
    notifyEnd();
  });
  async function waitForEnd(ms) {
    if (ended) return true;
    let timer;
    try {
      return await Promise.race([closed.then(() => true), new Promise(resolve => {
        timer = setTimeout(() => resolve(false), ms);
      })]);
    } finally { clearTimeout(timer); }
  }
  function close() {
    if (closeTask) return closeTask;
    closing = true;
    if (pending) fail("reader-failed");
    closeTask = (async () => {
      if (ended) return;
      child.stdin.end("Q\n");
      if (await waitForEnd(1000)) return;
      child.kill();
      if (!(await waitForEnd(2500))) throw problem("reader-failed");
    })();
    return closeTask;
  }
  try { await startWait("ready", 12000); }
  catch (err) { await close(); throw err; }
  return {
    metric: "windows-private-bytes",
    read() {
      if (closing || ended || terminal || pending) return Promise.reject(problem(terminal || "reader-failed"));
      const sample = startWait("read", 4000);
      child.stdin.write("R\n");
      return sample;
    },
    close
  };
}

module.exports = { openWindowsReader };
