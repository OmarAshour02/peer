#!/usr/bin/env node
// Runs `--smoke-test` against the *packaged* app for this OS/arch (what users actually install),
// not the development build. Used locally and in CI after electron-builder.
//
//   node scripts/smoke-packaged.mjs                 # unpacked app in release/
//   node scripts/smoke-packaged.mjs --appimage      # the AppImage itself (Linux)
//   node scripts/smoke-packaged.mjs --exec /opt/Peer/peer   # an installed app (e.g. from the .deb)
// Linux CI without a display: wrap in `xvfb-run -a`. PEER_SMOKE_LLM=1 adds a real agent turn.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const release = join(root, "release");
const args = process.argv.slice(2);

function findExecutable() {
  const i = args.indexOf("--exec");
  if (i !== -1) return { exe: args[i + 1], extra: [] };
  if (process.platform === "darwin") {
    for (const dir of [`mac-${process.arch}`, "mac", "mac-universal"]) {
      const exe = join(release, dir, "Peer.app", "Contents", "MacOS", "Peer");
      if (existsSync(exe)) return { exe, extra: [] };
    }
  }
  if (process.platform === "linux") {
    if (args.includes("--appimage")) {
      const image = readdirSync(release).find((f) => f.endsWith(".AppImage") && f.includes(process.arch === "arm64" ? "arm64" : "x86_64"));
      if (image) return { exe: join(release, image), extra: ["--appimage-extract-and-run"] };
    }
    for (const dir of ["linux-unpacked", `linux-${process.arch}-unpacked`]) {
      const exe = join(release, dir, "peer");
      if (existsSync(exe)) return { exe, extra: [] };
    }
  }
  throw new Error(`No packaged Peer found in ${release} for ${process.platform}-${process.arch}. Run electron-builder first.`);
}

const { exe, extra } = findExecutable();
// CI containers/VMs usually can't use Chromium's sandbox (no SUID helper / userns); the smoke test
// opens only Peer's own local UI.
const sandbox = process.platform === "linux" && process.env.PEER_SMOKE_SANDBOX !== "1" ? ["--no-sandbox"] : [];
console.log(`[smoke] ${exe} ${[...extra, "--smoke-test", ...sandbox].join(" ")}`);

const child = spawn(exe, [...extra, "--smoke-test", ...sandbox], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
let result = null;
const onData = (chunk) => {
  for (const line of chunk.toString().split("\n")) {
    if (line.startsWith("PEER_SMOKE_RESULT ")) result = JSON.parse(line.slice("PEER_SMOKE_RESULT ".length));
    else if (/^(PASS|FAIL) /.test(line)) console.log(line);
    else if (process.env.PEER_SMOKE_VERBOSE && line.trim()) console.log(`  ${line}`);
  }
};
child.stdout.on("data", onData);
child.stderr.on("data", onData);
const timer = setTimeout(() => {
  console.error("[smoke] timed out after 6 minutes");
  child.kill("SIGKILL");
}, 6 * 60_000);
child.on("exit", (code) => {
  clearTimeout(timer);
  if (!result) {
    console.error(`[smoke] no result reported (exit ${code})`);
    process.exit(1);
  }
  console.log(`[smoke] ${result.ok ? "OK" : "FAILED"} on ${result.platform}-${result.arch}`);
  process.exit(result.ok && code === 0 ? 0 : 1);
});
