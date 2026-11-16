import { contextBridge, ipcRenderer } from "electron";

// The renderer gets only these narrow capabilities. Everything else goes through the
// token-authenticated loopback API, which is the same surface a browser would use.
contextBridge.exposeInMainWorld("peerDesktop", {
  getConfig: (): Promise<{ apiBase: string; token: string }> => ipcRenderer.invoke("peer:config"),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke("peer:pick-directory"),
  platform: process.platform,
  /** The native window chrome (macOS title bar) follows Peer's theme, not the system's. */
  setTheme: (theme: "light" | "dark"): void => ipcRenderer.send("peer:theme", theme),
});
