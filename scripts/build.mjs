#!/usr/bin/env node
// Bundles the non-renderer code with esbuild:
//   dist/server/main.js     headless Peer backend (ESM, Node)
//   dist/plugin/peer.js     Peer plugin loaded by the OpenCode runtime (ESM, runs in OpenCode's Bun)
//   dist/electron/*.cjs     Electron main + preload (CJS)
// The renderer is built separately by Vite (`npm run build:renderer`).
import { build } from "esbuild";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");
const common = { bundle: true, sourcemap: true, logLevel: "info", absWorkingDir: root };

for (const dir of ["dist/server", "dist/plugin", "dist/electron"]) rmSync(join(root, dir), { recursive: true, force: true });

await Promise.all([
  build({
    ...common,
    entryPoints: ["src/server/main.ts"],
    outfile: "dist/server/main.js",
    platform: "node",
    format: "esm",
    target: "node22",
    // Some bundled CJS deps call require(); give ESM output a real one.
    banner: { js: "import { createRequire as __peerCreateRequire } from 'node:module'; const require = __peerCreateRequire(import.meta.url);" },
  }),
  build({
    ...common,
    entryPoints: ["src/plugin/peer-plugin.ts"],
    outfile: "dist/plugin/peer.js",
    platform: "node",
    format: "esm",
    target: "esnext",
    sourcemap: false,
  }),
  build({
    ...common,
    entryPoints: { main: "electron/main.ts" },
    outdir: "dist/electron",
    outExtension: { ".js": ".cjs" },
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
    // Bundled ESM deps (the Claude Agent SDK) read import.meta.url, which CJS output lacks.
    define: { "import.meta.url": "__peerImportMetaUrl" },
    banner: { js: 'const __peerImportMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
  }),
  // The preload runs sandboxed (only a few modules are available), so it gets no banner.
  build({
    ...common,
    entryPoints: { preload: "electron/preload.ts" },
    outdir: "dist/electron",
    outExtension: { ".js": ".cjs" },
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
  }),
]);

if (watch) console.log("[build] watch mode is not implemented; rerun `npm run build:main` after changes.");
