import { existsSync } from "node:fs";
import { join } from "node:path";

/** electron-builder's ${os} naming, used for vendor/opencode/<os>-<arch>. */
export function platformTarget(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  const os = platform === "darwin" ? "mac" : platform === "linux" ? "linux" : null;
  if (!os) throw new Error(`Peer does not support ${platform} yet (supported: macOS, Linux).`);
  if (arch !== "x64" && arch !== "arm64") throw new Error(`Peer does not support the ${arch} architecture (supported: x64, arm64).`);
  return `${os}-${arch}`;
}

/**
 * Locate the OpenCode runtime binary. Order:
 *  1. PEER_OPENCODE_BIN (explicit override)
 *  2. <resourcesPath>/opencode/opencode (packaged app)
 *  3. <appRoot>/vendor/opencode/<os>-<arch>/opencode (development; `npm run fetch:opencode`)
 */
export function resolveOpenCodeBinary(opts: { resourcesPath?: string; appRoot: string; env?: NodeJS.ProcessEnv }): string {
  const env = opts.env ?? process.env;
  const candidates = [
    env.PEER_OPENCODE_BIN,
    opts.resourcesPath ? join(opts.resourcesPath, "opencode", "opencode") : undefined,
    join(opts.appRoot, "vendor", "opencode", platformTarget(), "opencode"),
  ].filter((p): p is string => Boolean(p));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `OpenCode runtime binary not found. Looked in:\n${candidates.map((c) => `  - ${c}`).join("\n")}\nRun \`npm run fetch:opencode\` or set PEER_OPENCODE_BIN.`,
  );
}
