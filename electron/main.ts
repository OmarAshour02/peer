import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { startPeerServer, type PeerServer } from "../src/server/server.js";
import { runSmokeTest } from "./smoke.js";

const smokeTest = process.argv.includes("--smoke-test");
/** Vite dev server URL in development (set by scripts/dev.mjs). */
const devRendererUrl = process.env.PEER_RENDERER_URL;

let peer: PeerServer | null = null;
let mainWindow: BrowserWindow | null = null;

// A separate data dir is a separate Peer: its own database, runtime, browser profile and
// single-instance lock (useful for development and testing).
if (process.env.PEER_DATA_DIR) app.setPath("userData", process.env.PEER_DATA_DIR);

if (!smokeTest && !app.requestSingleInstanceLock()) {
  app.quit();
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    title: "Peer",
    backgroundColor: "#0d1117",
    show: !smokeTest,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  const appOrigin = new URL(devRendererUrl ?? peer!.url).origin;
  // Links open in the system browser; the app window never navigates away from Peer.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== appOrigin) event.preventDefault();
  });

  void win.loadURL(devRendererUrl ?? peer!.url);
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  mainWindow = win;
  return win;
}

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  try {
    peer = await startPeerServer({
      dataDir: smokeTest ? join(app.getPath("temp"), `peer-smoke-${process.pid}`) : app.getPath("userData"),
      appRoot: app.getAppPath(),
      resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
      port: 0,
      rendererDir: join(app.getAppPath(), "dist", "renderer"),
      devOrigins: devRendererUrl ? [new URL(devRendererUrl).origin] : [],
      log: (line) => console.log(line),
    });
  } catch (err) {
    dialog.showErrorBox("Peer failed to start", err instanceof Error ? err.message : String(err));
    app.exit(1);
    return;
  }

  ipcMain.handle("peer:config", () => ({ apiBase: peer!.url, token: peer!.token }));
  ipcMain.handle("peer:pick-directory", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"], title: "Choose a project folder" })
      : await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"], title: "Choose a project folder" });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  if (smokeTest) {
    const ok = await runSmokeTest(peer, createWindow);
    await peer.stop();
    app.exit(ok ? 0 : 1);
    return;
  }

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

let quitting = false;
app.on("before-quit", (event) => {
  if (quitting || !peer) return;
  // Stop the runtime (and its process group) before exiting so no agent process is orphaned.
  event.preventDefault();
  quitting = true;
  void peer.stop().finally(() => app.quit());
});
