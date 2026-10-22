// Subprocesses are always started with an argument array and no shell, so no flag can be lost or
// re-split by quoting. Output goes to a log file and a bounded in-memory tail.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, input?: string, logFile?: string, timeoutMs?: number, tailBytes?: number, onStdoutLine?: (line: string) => void }} [opts]
 * @returns {Promise<{ command: string, args: string[], exitCode: number | null, signal: string | null, timedOut: boolean, durationMs: number, stdout: string, stderr: string, spawnError?: string }>}
 */
export function run(command, args, opts = {}) {
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) throw new TypeError("run() takes an array of string arguments");
  const tailBytes = opts.tailBytes ?? 64 * 1024;
  const started = Date.now();
  return new Promise((resolve) => {
    const log = opts.logFile ? createWriteStream(opts.logFile) : null;
    log?.write(`$ ${[command, ...args].map(quoteForLog).join(" ")}\n`);
    let stdout = "";
    let stderr = "";
    let lineBuf = "";
    let timedOut = false;
    let settled = false;
    const keep = (buf, chunk) => (buf + chunk).slice(-tailBytes);

    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env ?? process.env, shell: false, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    trackChild(child);
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, opts.timeoutMs)
      : null;

    child.stdout.on("data", (d) => {
      const s = d.toString();
      stdout = keep(stdout, s);
      log?.write(s);
      if (opts.onStdoutLine) {
        lineBuf += s;
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop() ?? "";
        for (const l of lines) opts.onStdoutLine(l);
      }
    });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      stderr = keep(stderr, s);
      log?.write(s);
    });
    child.stdin.on("error", () => {});
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (lineBuf && opts.onStdoutLine) opts.onStdoutLine(lineBuf);
      const done = { command, args, stdout, stderr, timedOut, durationMs: Date.now() - started, ...result };
      if (log) log.end(`\n[exit ${done.exitCode ?? done.signal ?? done.spawnError}${timedOut ? ", timed out" : ""}, ${done.durationMs}ms]\n`, () => resolve(done));
      else resolve(done);
    };
    child.on("error", (err) => finish({ exitCode: null, signal: null, spawnError: err.message }));
    child.on("close", (code, signal) => finish({ exitCode: code, signal }));
  });
}

// Children run in their own process group (so a timeout can kill grandchildren too), which means
// Ctrl-C no longer reaches them. Forward it.
const active = new Set();
let forwarding = false;
function trackChild(child) {
  active.add(child);
  child.on("close", () => active.delete(child));
  if (forwarding) return;
  forwarding = true;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      for (const c of active) killTree(c);
      process.exit(130);
    });
  }
}

function killTree(child) {
  try {
    // Negative pid: the whole process group (the child was started detached as its own group).
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }, 5000).unref();
}

const quoteForLog = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
