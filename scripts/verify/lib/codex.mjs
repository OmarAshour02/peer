// The real Codex CLI as an independent reviewer: model resolution, the exact command line, and
// reading what Codex actually did from its JSONL event stream.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { UsageError } from "../../lib/args.mjs";
import { run } from "../../lib/proc.mjs";

export class ConfigError extends UsageError {}

/** Reasoning efforts Codex accepts in `-c model_reasoning_effort=...`. Checked again per model. */
const EFFORT = /^[a-z]+$/;

export async function codexVersion(bin) {
  const r = await run(bin, ["--version"], { timeoutMs: 30_000 });
  if (r.spawnError) throw new ConfigError(`Codex CLI not found (${bin}): ${r.spawnError}. Install it and run \`codex login\`, or set PEER_VERIFY_CODEX_BIN.`);
  if (r.exitCode !== 0) throw new ConfigError(`\`${bin} --version\` failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout.trim();
}

/** Codex's own model catalog, so an unknown model fails here instead of after a long run. */
export async function codexCatalog(bin) {
  const r = await run(bin, ["debug", "models"], { timeoutMs: 60_000, tailBytes: 8 * 1024 * 1024 });
  if (r.exitCode !== 0) throw new ConfigError(`Could not read Codex's model catalog (\`${bin} debug models\`): ${r.stderr.trim().slice(-500)}`);
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    throw new ConfigError("Codex's model catalog was not valid JSON");
  }
  const models = Array.isArray(parsed) ? parsed : parsed.models;
  if (!Array.isArray(models)) throw new ConfigError("Codex's model catalog has no models list");
  return models.map((m) => ({
    slug: m.slug,
    displayName: m.display_name ?? m.slug,
    efforts: (m.supported_reasoning_levels ?? []).map((l) => l.effort),
    defaultEffort: m.default_reasoning_level ?? null,
  }));
}

/**
 * Resolve the requested reviewer model and effort against the catalog. Never falls back.
 * @returns {{ model: string, displayName: string, effort: string }}
 */
export function resolveReviewer({ model, effort }, catalog) {
  if (!model) throw new ConfigError("No reviewer model configured. Set codex.model in verify.config.json or pass --model.");
  const entry = catalog.find((m) => m.slug === model);
  if (!entry) throw new ConfigError(`Codex does not offer model "${model}". Available: ${catalog.map((m) => m.slug).join(", ")}`);
  if (!effort) throw new ConfigError("No reasoning effort configured. Set codex.effort in verify.config.json or pass --effort.");
  if (!EFFORT.test(effort) || (entry.efforts.length > 0 && !entry.efforts.includes(effort))) {
    throw new ConfigError(`Model ${model} does not support reasoning effort "${effort}". Supported: ${entry.efforts.join(", ") || "(none listed)"}`);
  }
  return { model: entry.slug, displayName: entry.displayName, effort };
}

/**
 * The full `codex exec` argument list. The prompt goes in on stdin ("-").
 * - --ignore-user-config: no MCP servers, plugins or profile from ~/.codex; login still works.
 * - Not --ephemeral: the session rollout is how we confirm the model and sandbox actually used.
 * - workspace-write sandbox rooted at the snapshot: Codex can run tests and write probes there,
 *   cannot write the developer's checkout, and has no network. /tmp is excluded; the caller points
 *   TMPDIR inside the snapshot, so the snapshot is the only writable place.
 */
export function buildCodexArgs({ model, effort, snapshotDir, schemaPath, outputPath }) {
  for (const [k, v] of Object.entries({ model, effort, snapshotDir, schemaPath, outputPath })) {
    if (typeof v !== "string" || v === "") throw new TypeError(`buildCodexArgs: ${k} is required`);
  }
  if (!EFFORT.test(effort)) throw new TypeError(`buildCodexArgs: invalid effort ${effort}`);
  return [
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "--model",
    model,
    "--config",
    `model_reasoning_effort="${effort}"`,
    "--config",
    'approval_policy="never"',
    "--config",
    "sandbox_workspace_write.network_access=false",
    "--config",
    "sandbox_workspace_write.exclude_slash_tmp=true",
    "--sandbox",
    "workspace-write",
    "--cd",
    snapshotDir,
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
    "--json",
    "--color",
    "never",
    "-",
  ];
}

/** `/bin/zsh -lc 'npm test'` → `npm test`. */
export function unwrapShell(command) {
  const m = /^\S*\/?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(command.trim());
  return m ? m[2].replace(/'\\''/g, "'") : command.trim();
}

/** What Codex actually did, from `codex exec --json`. This, not Codex's own summary, is the evidence. */
export function parseEvents(jsonl) {
  const out = { threadId: null, commands: [], fileChanges: [], usage: null, errors: [], completed: false };
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "thread.started") out.threadId = e.thread_id ?? null;
    else if (e.type === "turn.completed") {
      out.completed = true;
      out.usage = e.usage ?? null;
    } else if (e.type === "turn.failed" || e.type === "error") out.errors.push(e.error?.message ?? e.message ?? JSON.stringify(e));
    else if (e.type === "item.completed" && e.item) {
      if (e.item.type === "command_execution") {
        out.commands.push({
          command: unwrapShell(e.item.command ?? ""),
          exitCode: e.item.exit_code ?? null,
          status: e.item.status ?? null,
          outputTail: String(e.item.aggregated_output ?? "").slice(-1500),
        });
      } else if (e.item.type === "file_change") {
        out.fileChanges.push(...(e.item.changes ?? []).map((c) => c.path ?? String(c)));
      }
    }
  }
  return out;
}

// Quoting differs between the event log and the reviewer's report (`\"bash\"` vs `"bash"`),
// so quotes and escapes are ignored when matching.
const norm = (s) => s.replace(/[\\'"]/g, "").replace(/\s+/g, " ").trim();

/**
 * Match each test Codex says it ran to a command in the event log. A claim with no matching
 * command is unobserved; the observed exit code replaces the claimed one.
 */
export function crossCheckTests(claimed, observed) {
  return claimed.map((t) => {
    const want = norm(t.command);
    const hit = [...observed].reverse().find((c) => want && (norm(c.command) === want || norm(c.command).includes(want)));
    return { ...t, observed: Boolean(hit), observedExitCode: hit ? hit.exitCode : null };
  });
}

/** The session rollout Codex wrote for this thread ($CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<thread>.jsonl). */
export function findRollout(threadId, codexHome = process.env.CODEX_HOME || join(homedir(), ".codex")) {
  if (!threadId || !/^[\w-]+$/.test(threadId)) return null;
  const dir = join(codexHome, "sessions");
  if (!existsSync(dir)) return null;
  const hit = readdirSync(dir, { recursive: true }).find((p) => String(p).endsWith(`-${threadId}.jsonl`));
  return hit ? join(dir, String(hit)) : null;
}

/** Settings Codex applied to each turn, as recorded in the rollout. */
export function appliedSettings(rolloutText) {
  const turns = [];
  for (const line of rolloutText.split("\n")) {
    if (!line.includes('"turn_context"')) continue;
    try {
      const e = JSON.parse(line);
      if (e.type !== "turn_context") continue;
      const p = e.payload ?? {};
      turns.push({ model: p.model ?? null, effort: p.effort ?? null, cwd: p.cwd ?? null, sandbox: p.sandbox_policy ?? null });
    } catch {}
  }
  return turns;
}

/**
 * Compare what Codex applied with what was requested. Any mismatch voids the review: a different
 * model, a different effort, a sandbox other than workspace-write, network on, or a writable root
 * that reaches the developer's checkout.
 */
export function checkApplied(turns, { model, effort, repo, snapshotDir, tmpDir = process.env.TMPDIR }) {
  if (turns.length === 0) return ["the session rollout records no turn settings"];
  const errors = [];
  const inside = (child, parent) => {
    const rel = relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
  };
  for (const [i, t] of turns.entries()) {
    if (t.model !== model) errors.push(`turn ${i + 1} ran on model ${t.model}, not the requested ${model}`);
    if (t.effort !== effort) errors.push(`turn ${i + 1} ran at effort ${t.effort}, not the requested ${effort}`);
    if (t.cwd && t.cwd !== snapshotDir) errors.push(`turn ${i + 1} ran in ${t.cwd}, not the review snapshot`);
    const sb = t.sandbox;
    if (!sb || sb.type !== "workspace-write") errors.push(`turn ${i + 1} sandbox is ${sb?.type ?? "unknown"}, not workspace-write`);
    else {
      if (sb.network_access !== false) errors.push(`turn ${i + 1} had network access`);
      // Besides its listed roots, workspace-write can write $TMPDIR and /tmp unless excluded.
      const implicit = [];
      if (sb.exclude_tmpdir_env_var !== true && tmpDir) implicit.push(tmpDir);
      if (sb.exclude_slash_tmp !== true) implicit.push("/tmp", "/private/tmp");
      for (const root of [...(sb.writable_roots ?? []), ...implicit]) {
        if (inside(repo, root) || inside(root, repo)) errors.push(`turn ${i + 1} could write ${root}, which overlaps the checkout ${repo}`);
      }
    }
  }
  return [...new Set(errors)];
}
