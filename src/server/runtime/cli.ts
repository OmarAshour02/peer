import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * Find an executable the way a shell would: an explicit override, else the first match on PATH.
 * GUI launches get the login-shell PATH merged in by the server (see platform.ts).
 */
export function findExecutable(name: string, env: NodeJS.ProcessEnv, override?: string): string | null {
  const candidates = override ? [override] : (env.PATH ?? "").split(delimiter).filter(isAbsolute).map((dir) => join(dir, name));
  for (const file of candidates) {
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      // not here
    }
  }
  return null;
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run a short, non-interactive CLI command (version and auth-status probes). Never throws. */
export function runCli(file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 15_000): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : null) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && !stdout ? err.message : "")) });
    });
  });
}
