#!/usr/bin/env node
// Downloads the pinned OpenCode runtime binary for one or more targets into
// vendor/opencode/<os>-<arch>/opencode, where <os> matches electron-builder's
// ${os} macro ("mac" | "linux") so packaging can pick it up per target.
//
// Usage:
//   node scripts/fetch-opencode.mjs                 # current platform/arch
//   node scripts/fetch-opencode.mjs --target linux-arm64 --target mac-x64
//   node scripts/fetch-opencode.mjs --all
//
// Binaries come from the official npm platform packages (opencode-<platform>-<arch>),
// pinned by package.json "opencode.version". npm verifies tarball integrity.
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).opencode.version;

// x64 uses the "baseline" builds: they do not require AVX2, so they run on older
// Intel Macs, under Rosetta, and on any x86_64 Linux machine.
const TARGETS = {
  "mac-arm64": "opencode-darwin-arm64",
  "mac-x64": "opencode-darwin-x64-baseline",
  "linux-arm64": "opencode-linux-arm64",
  "linux-x64": "opencode-linux-x64-baseline",
};

function currentTarget() {
  const os = { darwin: "mac", linux: "linux" }[process.platform];
  if (!os) throw new Error(`Unsupported platform: ${process.platform}`);
  return `${os}-${process.arch}`;
}

const args = process.argv.slice(2);
let targets = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--all") targets = Object.keys(TARGETS);
  else if (args[i] === "--target") targets.push(args[++i]);
}
if (targets.length === 0) targets = [currentTarget()];

for (const target of targets) {
  const pkg = TARGETS[target];
  if (!pkg) throw new Error(`Unknown target ${target}. Known: ${Object.keys(TARGETS).join(", ")}`);
  const outDir = join(root, "vendor", "opencode", target);
  const outBin = join(outDir, "opencode");
  const stamp = join(outDir, ".version");
  if (existsSync(outBin) && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === `${pkg}@${version}`) {
    console.log(`[fetch-opencode] ${target}: ${pkg}@${version} already present`);
    continue;
  }
  const work = mkdtempSync(join(tmpdir(), "peer-opencode-"));
  try {
    console.log(`[fetch-opencode] ${target}: downloading ${pkg}@${version}`);
    execFileSync("npm", ["pack", `${pkg}@${version}`, "--silent"], { cwd: work, stdio: ["ignore", "pipe", "inherit"] });
    const tgz = execFileSync("sh", ["-c", "ls *.tgz"], { cwd: work }).toString().trim();
    execFileSync("tar", ["-xzf", tgz], { cwd: work });
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    cpSync(join(work, "package", "bin", "opencode"), outBin);
    chmodSync(outBin, 0o755);
    execFileSync("sh", ["-c", `printf '%s' '${pkg}@${version}' > '${stamp}'`]);
    console.log(`[fetch-opencode] ${target}: wrote ${outBin}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
