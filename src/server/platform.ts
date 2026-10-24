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

const MARKER = "__PEER_ENV__";

export interface LoginShellEnv {
  /** The login shell's PATH, or the current PATH if the shell could not be asked. */
  path: string | undefined;
  /** The login shell's whole environment (empty if the shell could not be asked). */
  vars: Record<string, string>;
}

/** Parse `env -0` output (NUL-separated NAME=value entries; values may contain newlines). */
export function parseEnvOutput(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const entry of text.split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) vars[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return vars;
}

/**
 * Apps launched from Finder, the Dock, or a Linux desktop launcher get a minimal environment, so
 * the agent's shell would not find node, git from Homebrew, language toolchains, etc., and model
 * providers would not see API keys exported in the shell profile. Ask the user's login shell for
 * its environment once at startup. Falls back to the current PATH and no variables.
 */
export async function resolveLoginShellEnv(env: NodeJS.ProcessEnv = process.env): Promise<LoginShellEnv> {
  const shell = env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  return await new Promise((resolve) => {
    execFile(
      shell,
      ["-ilc", `printf '%s' '${MARKER}'; /usr/bin/env -0; printf '%s' '${MARKER}'`],
      { timeout: 5000, maxBuffer: 4 * 1024 * 1024, env: { ...env, DISABLE_AUTO_UPDATE: "true" } },
      (err, stdout) => {
        const text = String(stdout ?? "");
        const start = text.indexOf(MARKER);
        const end = text.lastIndexOf(MARKER);
        const vars = !err && start >= 0 && end > start ? parseEnvOutput(text.slice(start + MARKER.length, end)) : {};
        resolve({ path: vars.PATH || env.PATH, vars });
      },
    );
  });
}

/** Cloud credential and endpoint variables model providers read, besides any `*_API_KEY`/`*_API_TOKEN`. */
const PROVIDER_VARIABLES = new Set([
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_BEARER_TOKEN_BEDROCK",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "VERTEX_LOCATION",
  "AZURE_RESOURCE_NAME",
  "OLLAMA_HOST",
]);

/**
 * The model-provider variables from the login shell that Peer's own environment lacks (Peer's own
 * environment wins). Only for the bundled OpenCode runtime: Claude Code and Codex keep the
 * environment Peer was started with, so an exported ANTHROPIC_API_KEY cannot quietly switch
 * Claude Code from the developer's subscription to API billing.
 */
export function providerVariables(shellVars: Record<string, string>, current: NodeJS.ProcessEnv): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const [name, value] of Object.entries(shellVars)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || !value || current[name] !== undefined) continue;
    if (/_API_(KEY|TOKEN)$/.test(name) || PROVIDER_VARIABLES.has(name)) picked[name] = value;
  }
  return picked;
}

export function mergePath(primary: string | undefined, fallback: string | undefined): string {
  const parts = [...(primary ?? "").split(":"), ...(fallback ?? "").split(":")].filter(Boolean);
  return [...new Set(parts)].join(":");
}
