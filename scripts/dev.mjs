#!/usr/bin/env node
// Development: bundles main/server/plugin, starts the Vite dev server (hot reload for the UI),
// and launches Electron pointed at it. Main-process changes need a restart of this script.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = (name) => join(root, "node_modules", ".bin", name);
const children = [];

function run(cmd, args, env = {}) {
  const child = spawn(cmd, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
  children.push(child);
  return child;
}

await new Promise((resolve, reject) =>
  run("node", ["scripts/build.mjs"]).on("exit", (code) => (code === 0 ? resolve() : reject(new Error("build failed")))),
);

const rendererUrl = "http://127.0.0.1:5173";
run(bin("vite"), []);
for (let i = 0; i < 50; i++) {
  try {
    await fetch(rendererUrl);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}

const electron = run(bin("electron"), [".", ...process.argv.slice(2)], { PEER_RENDERER_URL: rendererUrl });
const stop = () => {
  for (const c of children) c.kill("SIGTERM");
  process.exit(0);
};
electron.on("exit", stop);
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
