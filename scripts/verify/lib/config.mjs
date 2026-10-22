// verify.config.json: what to check, which reviewer model, and the loop limit. Validated strictly;
// a typo is an error, not a silently ignored setting.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { ConfigError } from "./codex.mjs";

const DEFAULTS = {
  baseBranches: ["main", "origin/main"],
  reportsDir: ".peer-dev/verify",
  checks: [],
  codex: { bin: "codex", model: null, effort: null, timeoutMinutes: 25 },
  reviewer: { instructions: "scripts/verify/reviewer/instructions.md", rubrics: [], schema: "scripts/verify/reviewer/report.schema.json" },
  snapshot: { exclude: [], linkIgnored: ["node_modules"] },
  loop: { maxRepairCycles: 2 },
};

const KEYS = {
  "": ["project", "baseBranches", "reportsDir", "checks", "codex", "reviewer", "snapshot", "loop"],
  codex: ["bin", "model", "effort", "timeoutMinutes"],
  reviewer: ["instructions", "rubrics", "schema"],
  snapshot: ["exclude", "linkIgnored"],
  loop: ["maxRepairCycles"],
};

const isStrings = (v) => Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);

export function loadConfig(repo, path) {
  const file = path ? (isAbsolute(path) ? path : join(repo, path)) : join(repo, "verify.config.json");
  if (!existsSync(file)) throw new ConfigError(`No verification config at ${file}`);
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON: ${err.message}`);
  }
  for (const [section, allowed] of Object.entries(KEYS)) {
    const obj = section ? raw[section] : raw;
    if (obj === undefined) continue;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new ConfigError(`${section || "config"} must be an object`);
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw new ConfigError(`Unknown setting ${section ? `${section}.` : ""}${k} in ${file}`);
  }
  const cfg = {
    ...DEFAULTS,
    ...raw,
    codex: { ...DEFAULTS.codex, ...raw.codex },
    reviewer: { ...DEFAULTS.reviewer, ...raw.reviewer },
    snapshot: { ...DEFAULTS.snapshot, ...raw.snapshot },
    loop: { ...DEFAULTS.loop, ...raw.loop },
    file,
  };
  if (!isStrings(cfg.baseBranches)) throw new ConfigError("baseBranches must be a list of branch names");
  if (!Array.isArray(cfg.checks)) throw new ConfigError("checks must be a list");
  for (const c of cfg.checks) {
    if (typeof c?.name !== "string" || !isStrings(c.command) || c.command.length === 0 || typeof c.required !== "boolean") {
      throw new ConfigError(`Each check needs a name, a command (argument list) and required: true/false. Got ${JSON.stringify(c)}`);
    }
  }
  if (!Number.isInteger(cfg.loop.maxRepairCycles) || cfg.loop.maxRepairCycles < 0 || cfg.loop.maxRepairCycles > 5) {
    throw new ConfigError("loop.maxRepairCycles must be an integer from 0 to 5");
  }
  if (!(cfg.codex.timeoutMinutes > 0 && cfg.codex.timeoutMinutes <= 120)) throw new ConfigError("codex.timeoutMinutes must be between 1 and 120");
  if (!isStrings(cfg.reviewer.rubrics)) throw new ConfigError("reviewer.rubrics must be a list of paths");
  if (!Array.isArray(cfg.snapshot.exclude) || !Array.isArray(cfg.snapshot.linkIgnored)) throw new ConfigError("snapshot.exclude and snapshot.linkIgnored must be lists");
  return cfg;
}
