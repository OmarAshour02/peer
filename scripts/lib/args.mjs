// Strict command-line parsing for Peer's scripts.
//
// Flags are declared up front. An undeclared flag, a flag without its value, a stray positional,
// or a flag that npm consumed (`npm run x --model m` without `--`) is an error, never a silent
// default. That last case once dropped `--model` and ran the runtime's expensive default model:
// npm keeps `--model` for itself, sets npm_config_model=true, and passes only the bare value on.

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * @param {Record<string, { type: "string" | "boolean" | "list", default?: unknown, help?: string }>} spec
 * @param {string[]} argv  process.argv.slice(2)
 * @param {NodeJS.ProcessEnv} env
 * @returns {Record<string, any>}
 */
export function parseArgs(spec, argv, env = process.env) {
  const out = {};
  for (const [name, s] of Object.entries(spec)) {
    out[name] = s.default !== undefined ? structuredClone(s.default) : s.type === "list" ? [] : s.type === "boolean" ? false : undefined;
  }
  const seen = new Set();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--") || arg === "--") {
      throw new UsageError(
        `Unexpected argument "${arg}". ` +
          (env.npm_lifecycle_event ? `If you ran this through npm, put the flags after "--": npm run ${env.npm_lifecycle_event} -- --flag value` : "Every value needs its --flag."),
      );
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    const s = spec[name];
    if (!s) throw new UsageError(`Unknown flag --${name}. Known flags: ${Object.keys(spec).map((k) => `--${k}`).join(", ")}`);

    if (s.type === "boolean") {
      if (eq !== -1) {
        const v = arg.slice(eq + 1);
        if (v !== "true" && v !== "false") throw new UsageError(`--${name} is a switch; use --${name} or --${name}=false`);
        out[name] = v === "true";
      } else {
        out[name] = true;
      }
      continue;
    }

    let value;
    if (eq !== -1) value = arg.slice(eq + 1);
    else {
      value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} needs a value`);
      i++;
    }
    if (value === "") throw new UsageError(`--${name} needs a non-empty value`);
    if (s.type === "list") out[name].push(value);
    else {
      if (seen.has(name)) throw new UsageError(`--${name} was given twice`);
      out[name] = value;
    }
    seen.add(name);
  }

  // npm turns `npm run x --model m` into npm_config_model=... and hides the flag from us.
  if (env.npm_lifecycle_event) {
    for (const name of Object.keys(spec)) {
      const key = `npm_config_${name.replace(/-/g, "_")}`;
      if (env[key] !== undefined && !seen.has(name) && !(spec[name].type === "boolean" && out[name])) {
        throw new UsageError(`npm consumed --${name} (it was not passed to the script). Put script flags after "--": npm run ${env.npm_lifecycle_event} -- --${name} …`);
      }
    }
  }
  return out;
}

/** "provider/model" → ModelRef. The model id may itself contain slashes. */
export function parseModelRef(text) {
  const slash = text.indexOf("/");
  if (slash <= 0 || slash === text.length - 1) throw new UsageError(`Model "${text}" must look like provider/model, e.g. claude/haiku`);
  return { providerId: text.slice(0, slash), modelId: text.slice(slash + 1) };
}

export const formatModelRef = (m) => (m ? `${m.providerId}/${m.modelId}` : "(none)");
