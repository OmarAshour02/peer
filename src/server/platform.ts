import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Peer's data directory. Matches Electron's `app.getPath("userData")` for productName "Peer",
 * so the desktop app and headless server share workspaces and sessions.
 */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.PEER_DATA_DIR) return env.PEER_DATA_DIR;
  const home = env.HOME || homedir();
  if (platform === "darwin") return join(home, "Library", "Application Support", "Peer");
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "Peer");
}

const MARKER = "__PEER_PATH__";

/**
 * Apps launched from Finder, the Dock, or a Linux desktop launcher get a minimal PATH, so the
 * agent's shell would not find node, git from Homebrew, language toolchains, etc. Ask the
 * user's login shell for its PATH once at startup. Falls back to the current PATH.
 */
export async function resolveLoginShellPath(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const shell = env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  return await new Promise((resolve) => {
    execFile(
      shell,
      ["-ilc", `printf '%s%s%s' '${MARKER}' "$PATH" '${MARKER}'`],
      { timeout: 5000, env: { ...env, DISABLE_AUTO_UPDATE: "true" } },
      (err, stdout) => {
        const match = new RegExp(`${MARKER}(.*)${MARKER}`).exec(stdout ?? "");
        resolve(!err && match?.[1] ? match[1] : env.PATH);
      },
    );
  });
}

export function mergePath(primary: string | undefined, fallback: string | undefined): string {
  const parts = [...(primary ?? "").split(":"), ...(fallback ?? "").split(":")].filter(Boolean);
  return [...new Set(parts)].join(":");
}
