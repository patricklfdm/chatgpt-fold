"use strict";
const { open, readFile, readlink } = require("node:fs/promises");
const { constants } = require("node:fs");
const { basename } = require("node:path");

// Per-kernel definitions: https://docs.kernel.org/filesystems/proc.html
// These are process-level counters, not private commit, V8 heap, or total tab RAM.
const metric = "linux-anon-rss-plus-swap";
const names = new Set(["chrome", "chromium", "chromium-browser", "chrome-headless-shell", "headless_shell"]);
const codes = new Set(["target-exited", "identity-changed", "not-chrome", "access-denied", "reader-unavailable", "reader-failed"]);
function failure(code) { return Object.assign(new Error(code), { code }); }
function normalize(error) {
  if (codes.has(error?.code)) return error;
  if (["ENOENT", "ESRCH"].includes(error?.code)) return failure("target-exited");
  if (["EACCES", "EPERM"].includes(error?.code)) return failure("access-denied");
  return failure("reader-failed");
}

function identity(text, pid) {
  // Field 2 (comm) may itself include ')' and spaces. Field 22 is starttime.
  const close = text.lastIndexOf(")"), start = String(pid) + " (";
  if (!text.startsWith(start) || close < start.length) throw failure("identity-changed");
  const fields = text.slice(close + 1).trim().split(/\s+/);
  if (["Z", "X", "x"].includes(fields[0])) throw failure("target-exited");
  if (!/^\d+$/.test(fields[19] || "")) throw failure("reader-failed");
  return { birth: fields[19], comm: text.slice(start.length, close) };
}

function bytes(status, field) {
  const match = status.match(new RegExp("^" + field + ":\\s*([0-9]+) kB$", "m"));
  const value = match ? Number(match[1]) * 1024 : NaN;
  if (!Number.isSafeInteger(value)) throw failure("reader-failed");
  return value;
}

// Accepts IDs in the namespace that mounted /proc. The test-only CDP harness
// can obtain one through pidfd in nested test containers, without enumerating.
async function openProcfsChromeReader(pid) {
  if (process.platform !== "linux") throw failure("reader-unavailable");
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) throw failure("reader-failed");
  let directory;
  try {
    // Pin this proc directory. A dead process's procfd cannot follow its PID
    // into a new process. Also check the start time around each status sample.
    directory = await open("/proc/" + pid, constants.O_RDONLY | constants.O_DIRECTORY);
    const dir = "/proc/self/fd/" + directory.fd;
    const stat = async () => identity(await readFile(dir + "/stat", "utf8"), pid);
    const original = await stat();
    let executable;
    try { executable = basename(await readlink(dir + "/exe")).replace(/ \(deleted\)$/, ""); }
    catch (error) {
      // Non-dumpable sandbox renderers may hide exe from an otherwise-readable
      // proc; allow only a recognized kernel comm. Neither verifies a tab ID.
      if (!["EACCES", "EPERM"].includes(error.code)) throw error;
      executable = original.comm;
    }
    if (!names.has(executable)) throw failure("not-chrome");
    let closing = false, pending = Promise.resolve(), closed;
    function check(current) {
      if (current.birth !== original.birth || current.comm !== original.comm) throw failure("identity-changed");
    }
    async function sample() {
      try {
        check(await stat());
        const status = await readFile(dir + "/status", "utf8");
        check(await stat());
        const workingSetBytes = bytes(status, "VmRSS");
        const primaryBytes = bytes(status, "RssAnon") + bytes(status, "VmSwap");
        if (!Number.isSafeInteger(primaryBytes)) throw failure("reader-failed");
        return { primaryBytes, workingSetBytes };
      } catch (error) { throw normalize(error); }
    }
    return {
      metric,
      read() {
        if (closing) return Promise.reject(failure("reader-failed"));
        const next = pending.then(sample);
        pending = next.catch(() => {});
        return next;
      },
      close() {
        if (!closed) { closing = true; closed = pending.then(() => directory.close()); }
        return closed;
      }
    };
  } catch (error) {
    if (directory) await directory.close();
    throw normalize(error);
  }
}
async function openLinuxReader(pid) {
  if (process.platform !== "linux") throw failure("reader-unavailable");
  let current;
  try { current = await readlink("/proc/self"); } catch { throw failure("reader-unavailable"); }
  // The user supplied a PID from the browser's task manager. Never guess an
  // equivalent ID when the recorder's /proc mount uses a different namespace.
  if (current !== String(process.pid)) throw failure("reader-unavailable");
  return openProcfsChromeReader(pid);
}
module.exports = { openLinuxReader, openProcfsChromeReader };
