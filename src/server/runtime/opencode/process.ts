import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DESTRUCTIVE_COMMAND_PATTERNS } from "../../collaboration/safety.js";

export interface OpenCodeProcessOptions {
  binary: string;
  /** Peer-owned root for the runtime's data/state/cache and config dir. */
  rootDir: string;
  /** Bundled Peer plugin (runs inside OpenCode). */
  pluginFile: string;
  /** Base environment (with the user's login-shell PATH already resolved). */
  env: NodeJS.ProcessEnv;
  bridgeUrl: string;
  bridgeToken: string;
  log: (line: string) => void;
}

/**
 * Safety rules applied in every collaboration mode. They are merged after the user's own
 * OpenCode config (later keys win), so they tighten but never loosen user rules.
 * Collaboration modes never change these.
 */
export const SAFETY_PERMISSIONS = {
  external_directory: "deny",
  bash: Object.fromEntries(DESTRUCTIVE_COMMAND_PATTERNS.map((pattern) => [pattern, "ask"])),
} as const;

export interface RunningOpenCode {
  url: string;
  password: string;
}

/** Spawns and supervises `opencode serve` bound to loopback with a random password. */
export class OpenCodeProcess {
  private child: ChildProcess | null = null;
  private stopping = false;

  constructor(private readonly opts: OpenCodeProcessOptions) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  async start(onExit: (code: number | null, signal: NodeJS.Signals | null) => void): Promise<RunningOpenCode> {
    const { opts } = this;
    const dirs = {
      data: join(opts.rootDir, "data"),
      state: join(opts.rootDir, "state"),
      cache: join(opts.rootDir, "cache"),
      config: join(opts.rootDir, "peer-config"),
    };
    for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
    mkdirSync(join(dirs.config, "plugin"), { recursive: true });
    copyFileSync(opts.pluginFile, join(dirs.config, "plugin", "peer.js"));

    const password = randomBytes(24).toString("base64url");
    const env: NodeJS.ProcessEnv = {
      ...opts.env,
      // Isolate runtime storage from any other OpenCode install (schemas differ across versions).
      // The user's config dir (XDG_CONFIG_HOME) is left alone so their providers and settings apply.
      XDG_DATA_HOME: dirs.data,
      XDG_STATE_HOME: dirs.state,
      XDG_CACHE_HOME: dirs.cache,
      OPENCODE_CONFIG_DIR: dirs.config,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: false, share: "disabled", permission: SAFETY_PERMISSIONS }),
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      PEER_BRIDGE_URL: opts.bridgeUrl,
      PEER_BRIDGE_TOKEN: opts.bridgeToken,
      PEER_PARENT_PID: String(process.pid),
    };
    const auth = readUserAuth(opts.env);
    if (auth) env.OPENCODE_AUTH_CONTENT = auth;

    this.stopping = false;
    const child = spawn(opts.binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: opts.rootDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group so stop() also terminates shells and language servers it spawned.
      detached: true,
    });
    this.child = child;

    return await new Promise<RunningOpenCode>((resolve, reject) => {
      let settled = false;
      let buffer = "";
      const timer = setTimeout(() => fail(new Error("OpenCode runtime did not start within 30s")), 30_000);

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.kill("SIGKILL");
        reject(err);
      };
      const onData = (chunk: Buffer) => {
        const text = chunk.toString();
        for (const line of text.split("\n")) if (line.trim()) opts.log(line.trimEnd());
        if (settled) return;
        buffer += text;
        const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(buffer);
        if (match) {
          settled = true;
          clearTimeout(timer);
          resolve({ url: match[1]!, password });
        }
      };
      child.stdout!.on("data", onData);
      child.stderr!.on("data", onData);
      child.on("error", (err) => fail(err));
      child.on("exit", (code, signal) => {
        this.child = null;
        if (!settled) fail(new Error(`OpenCode runtime exited during startup (code ${code}, signal ${signal}). Output:\n${buffer.slice(-2000)}`));
        else if (!this.stopping) onExit(code, signal);
      });
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    this.kill("SIGTERM");
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 4000));
    if ((await Promise.race([exited, timeout])) === "timeout") {
      this.kill("SIGKILL");
      await exited;
    }
  }

  private kill(signal: NodeJS.Signals) {
    const pid = this.child?.pid;
    if (!pid) return;
    try {
      process.kill(-pid, signal); // whole process group
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // already gone
      }
    }
  }
}

/**
 * Reuse credentials from the user's own OpenCode install (`opencode auth login`), so Peer
 * does not need its own key management. Passed to the runtime process only, never to the UI.
 */
function readUserAuth(env: NodeJS.ProcessEnv): string | null {
  const dataHome = env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share");
  const file = join(dataHome, "opencode", "auth.json");
  if (!existsSync(file)) return null;
  try {
    const content = readFileSync(file, "utf8");
    JSON.parse(content);
    return content;
  } catch {
    return null;
  }
}
