import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EffortDefault } from "../shared/types.js";

// What reasoning effort a session gets when it has no pick of its own, so the composer can show
// the level instead of "Default". The order is the one the runtimes apply: Peer's Runtime settings
// (sent with each turn), then the CLI's own configuration, then the model's default.

function readJson(path: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const level = (v: unknown) => (typeof v === "string" && /^[a-z][a-z_-]{0,31}$/.test(v) ? v : null);

/**
 * A Claude model id in its canonical form, for matching `modelSettings` keys: Claude Code keys them
 * by canonical name, which also matches the dated, `[1m]`, Bedrock and Vertex spellings.
 */
export function canonicalClaudeModel(id: string): string {
  return id
    .toLowerCase()
    .replace(/\[1m\]$/, "")
    .replace(/^(?:[a-z]{2,4}\.)?anthropic\./, "") // Bedrock: us.anthropic.claude-… / anthropic.claude-…
    .replace(/-v\d+(?::\d+)?$/, "") // Bedrock version suffix
    .replace(/@\d{8}$/, "") // Vertex: claude-…@20250929
    .replace(/-\d{8}$/, ""); // dated: claude-…-20250929
}

const ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];
const rank = (l: string) => ORDER.indexOf(l);
/** The lower of two levels; unknown levels are left as they are. */
export function lowerEffort(a: string, b: string): string {
  return rank(a) >= 0 && rank(b) >= 0 && rank(b) < rank(a) ? b : a;
}

type ClaudeSettings = { effortLevel?: unknown; maxEffortLevel?: unknown; modelSettings?: Record<string, { effortLevel?: unknown; maxEffortLevel?: unknown }> };

/** The `modelSettings` entry for a model, matched on canonical names. */
function forModel(settings: ClaudeSettings, models: readonly string[]) {
  const table = settings.modelSettings && typeof settings.modelSettings === "object" ? settings.modelSettings : {};
  const wanted = new Set(models.map(canonicalClaudeModel));
  for (const [key, value] of Object.entries(table)) if (wanted.has(canonicalClaudeModel(key)) && value && typeof value === "object") return value;
  return undefined;
}

/**
 * What Claude Code's settings say about effort for a model, following its own rules:
 * - the level: `CLAUDE_CODE_EFFORT_LEVEL`, else the first settings file (project local, project,
 *   user) with one, where a per-model `modelSettings[<model>].effortLevel` wins over `effortLevel`;
 * - the cap: in each file, a per-model `maxEffortLevel` replaces the file's own (`"max"` exempts
 *   the model), and across files the lowest cap wins. The cap clamps every level, Peer's included.
 * `models` are the spellings of the session's model (its id, and the canonical id an alias resolves to).
 */
export function claudeEffortConfig(directory: string, models: readonly string[], env: NodeJS.ProcessEnv = process.env): { level: string | null; cap: string | null } {
  const userDir = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
  const files = [join(directory, ".claude", "settings.local.json"), join(directory, ".claude", "settings.json"), join(userDir, "settings.json")]
    .map((path) => readJson(path) as ClaudeSettings | null)
    .filter((s): s is ClaudeSettings => s !== null);
  const fromEnv = env.CLAUDE_CODE_EFFORT_LEVEL;
  let found: string | null = fromEnv === "unset" ? null : level(fromEnv);
  let cap: string | null = null;
  for (const settings of files) {
    const own = forModel(settings, models);
    if (!found && fromEnv !== "unset") found = level(own?.effortLevel) ?? level(settings.effortLevel);
    const fileCap = own && own.maxEffortLevel !== undefined ? level(own.maxEffortLevel) : level(settings.maxEffortLevel);
    if (fileCap && fileCap !== "max") cap = cap ? lowerEffort(cap, fileCap) : fileCap;
  }
  return { level: found, cap };
}

/** Claude Code's configured effort for a model, before any cap (kept for callers that only need the level). */
export function claudeConfigEffort(directory: string, model: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  return claudeEffortConfig(directory, model ? [model] : [], env).level;
}

/** Codex's `model_reasoning_effort` from the top level of `$CODEX_HOME/config.toml` (profiles are not read). */
export function codexConfigEffort(env: NodeJS.ProcessEnv = process.env): string | null {
  let text: string;
  try {
    text = readFileSync(join(env.CODEX_HOME || join(env.HOME || homedir(), ".codex"), "config.toml"), "utf8");
  } catch {
    return null;
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) break; // past the top-level keys
    const m = /^model_reasoning_effort\s*=\s*["']([^"']+)["']/.exec(line);
    if (m) return level(m[1]);
  }
  return null;
}

/**
 * The first answer in the chain, with where it came from, then clamped to the CLI's cap if it has
 * one (`cappedFrom` keeps what was asked for).
 */
export function resolveEffortDefault(sources: { settings?: string | null; cli?: string | null; model?: string | null; cap?: string | null }): EffortDefault | null {
  const picked: EffortDefault | null = sources.settings
    ? { level: sources.settings, source: "settings" }
    : sources.cli
      ? { level: sources.cli, source: "cli" }
      : sources.model
        ? { level: sources.model, source: "model" }
        : null;
  if (!picked || !sources.cap) return picked;
  const capped = lowerEffort(picked.level, sources.cap);
  return capped === picked.level ? picked : { ...picked, level: capped, cappedFrom: picked.level };
}
