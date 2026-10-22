// Headless entry point: runs the Peer backend + runtime and serves the built UI to a browser.
// Used for development without Electron and for Linux/CI smoke testing.
//   PEER_PORT (default 4317), PEER_DATA_DIR, PEER_DEV_ORIGIN, PEER_OPENCODE_BIN
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDataDir } from "./platform.js";
import { startPeerServer } from "./server.js";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const devOrigin = process.env.PEER_DEV_ORIGIN;

const peer = await startPeerServer({
  dataDir: defaultDataDir(),
  appRoot,
  port: Number(process.env.PEER_PORT ?? 4317),
  rendererDir: join(appRoot, "dist", "renderer"),
  devOrigins: devOrigin ? [devOrigin] : [],
  persistToken: true,
});

const uiBase = devOrigin ?? peer.url;
console.log(`\nPeer is running.\n  Open: ${uiBase}/?api=${encodeURIComponent(peer.url)}#token=${peer.token}\n  Data: ${defaultDataDir()}\n`);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void peer.stop().finally(() => process.exit(0));
  });
}
