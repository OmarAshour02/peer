// Detects consequential engineering decisions in an agent's tool call before it runs, from the
// call's arguments alone, so Peer can involve the developer whatever the model decides to ask.
//
// Deliberately narrow. Today it recognizes new dependencies (an installer command that names
// packages, or an edit/write/patch that adds an entry to a dependency manifest) and changes to public
// API contracts (an edit/write/patch to a spec file, or to `exports`/`bin` in package.json). It does
// not see indirect changes (a script, generator or `node -e` that edits a file), and it reads the
// manifest from disk, so its answer is only as current as the workspace. A missed detection means
// Peer does not ask; a detection never changes what the tool does.
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { DecisionKind } from "../../shared/types.js";
import { normalizePypi, pipfileDependencies, pyprojectDependencies, setupCfgDependencies, setupPyDependencies } from "./python-manifests.js";

type Ecosystem = "npm" | "pypi" | "crates" | "go";

export interface Detection {
  kind: DecisionKind;
  /** New dependency names or changed contracts, deduplicated, in the order they appear. */
  subjects: string[];
  ecosystem: Ecosystem | "api";
  /** The action, as shown to the developer and the agent. */
  action: string;
}

/** Reads a file in the workspace; null when it does not exist or cannot be read. */
export type ReadFile = (absolutePath: string) => string | null;

const MAX_MANIFEST_BYTES = 2_000_000;

export const readWorkspaceFile: ReadFile = (path) => {
  try {
    if (statSync(path).size > MAX_MANIFEST_BYTES) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** The decision a tool call would make, or null for everything else (including mechanical work). */
export function detectDecision(tool: string, args: unknown, workspace: string, read: ReadFile = readWorkspaceFile): Detection | null {
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  if (tool === "bash") {
    // Where the command runs, when the runtime says so (OpenCode `workdir`, Codex `cwd`). Claude
    // Code's shell keeps its directory between calls and does not report it: the workspace root.
    const dir = typeof a.workdir === "string" ? a.workdir : typeof a.cwd === "string" ? a.cwd : null;
    return typeof a.command === "string" ? detectInstall(a.command, workspace, dir ? resolve(workspace, dir) : workspace, read) : null;
  }
  return detectManifestEdit(tool, a, workspace, read);
}

// ---------------------------------------------------------------------------
// Installer commands

interface Install {
  ecosystem: Ecosystem;
  /** Package specs as written (name plus optional version). */
  specs: string[];
  /** Directory the command installs into, when it says so (--prefix, -C, ...). */
  dir: string | null;
}

const NPM_INSTALL = new Set(["install", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall", "add"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
/** Prefixes that run the rest of the line as a command. */
const WRAPPERS = new Set(["sudo", "env", "time", "command", "exec", "nohup"]);

/** Flags that take a value (as the next word), per package manager. Others are treated as switches. */
const PYPI_VALUE_FLAGS = ["-r", "--requirement", "-c", "--constraint", "-e", "--editable", "-i", "--index-url", "--extra-index-url", "-f", "--find-links", "-t", "--target", "--prefix", "--root", "--python", "-p", "--group", "-G", "--source", "--platform", "--python-version", "--only-binary", "--no-binary", "--upgrade-strategy", "--optional", "--extra"];
const VALUE_FLAGS: Record<string, Set<string>> = {
  npm: new Set(["-w", "--workspace", "--prefix", "--registry", "--tag", "--omit", "--include", "--cache", "--userconfig", "--save-prefix", "--loglevel"]),
  // pnpm's -w is a switch (--workspace-root).
  pnpm: new Set(["--filter", "-F", "-C", "--dir", "--registry"]),
  yarn: new Set(["--cwd", "--registry"]),
  bun: new Set(["--cwd", "--registry"]),
  pypi: new Set(PYPI_VALUE_FLAGS),
  cargo: new Set(["-F", "--features", "--rename", "--registry", "-p", "--package", "--manifest-path", "--path", "--git", "--branch", "--tag", "--rev", "--target"]),
  go: new Set(["-C", "-modfile"]),
};
const DIR_FLAGS = new Set(["--prefix", "-C", "--dir", "--cwd"]);
/** Upgrading the installer itself is housekeeping, not a project dependency. */
const TOOLING = new Set(["pypi:pip", "pypi:setuptools", "pypi:wheel"]);

function detectInstall(command: string, workspace: string, start: string, read: ReadFile): Detection | null {
  const found: { ecosystem: Ecosystem; names: string[] } = { ecosystem: "npm", names: [] };
  let cwd = start;
  const visit = (line: string[], depth: number) => {
    const words = stripPrefixes(line);
    const [cmd, ...rest] = words;
    if (!cmd) return;
    const base = cmd.split("/").pop()!;
    if (base === "cd") {
      if (rest[0] && !rest[0].startsWith("-")) cwd = resolve(cwd, rest[0]);
      return;
    }
    // `bash -lc "npm install zod"` and the like: look inside the script.
    if (SHELLS.has(base) && depth < 3) {
      const c = rest.findIndex((w) => /^-[a-z]*c[a-z]*$/.test(w));
      if (c !== -1 && rest[c + 1]) for (const inner of commandLines(rest[c + 1]!)) visit(inner, depth + 1);
      return;
    }
    const install = parseInstall(base, rest);
    if (!install) return;
    const dir = install.dir ? resolve(cwd, install.dir) : cwd;
    const names = install.specs
      .filter((s) => !isLocalSpec(s))
      .map((s) => packageName(install.ecosystem, s))
      .filter((n) => n && !TOOLING.has(`${install.ecosystem}:${n}`) && !alreadyDeclared(install.ecosystem, n, dir, workspace, read));
    if (names.length === 0) return;
    found.ecosystem = install.ecosystem;
    found.names.push(...names);
  };
  for (const line of commandLines(command)) visit(line, 0);
  const subjects = unique(found.names);
  if (subjects.length === 0) return null;
  const shown = command.trim().length > 160 ? `${command.trim().slice(0, 157)}...` : command.trim();
  return { kind: "dependency", subjects, ecosystem: found.ecosystem, action: `\`${shown}\`` };
}

function stripPrefixes(words: string[]): string[] {
  const out = [...words];
  for (;;) {
    while (out.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(out[0]!)) out.shift();
    if (out.length > 0 && WRAPPERS.has(out[0]!.split("/").pop()!)) {
      out.shift();
      while (out.length > 0 && out[0]!.startsWith("-")) out.shift();
      continue;
    }
    return out;
  }
}

/** Subcommands that can install packages, per command. */
const INSTALL_SUBCOMMANDS: Record<string, Set<string>> = {
  npm: NPM_INSTALL,
  pnpm: new Set(["add"]),
  yarn: new Set(["add"]),
  poetry: new Set(["add"]),
  cargo: new Set(["add"]),
  bun: new Set(["add", "a", "install", "i"]),
  pip: new Set(["install"]),
  pip3: new Set(["install"]),
  pipenv: new Set(["install"]),
  uv: new Set(["add", "pip"]),
  go: new Set(["get"]),
};

/** Manager key in VALUE_FLAGS, and the ecosystem, per command. */
const MANAGERS: Record<string, [string, Ecosystem]> = {
  npm: ["npm", "npm"],
  pnpm: ["pnpm", "npm"],
  yarn: ["yarn", "npm"],
  bun: ["bun", "npm"],
  pip: ["pypi", "pypi"],
  pip3: ["pypi", "pypi"],
  pipenv: ["pypi", "pypi"],
  uv: ["pypi", "pypi"],
  poetry: ["pypi", "pypi"],
  cargo: ["cargo", "crates"],
  go: ["go", "go"],
};

function parseInstall(cmd: string, rest: string[]): Install | null {
  if (cmd === "python" || cmd === "python3") {
    const m = rest.indexOf("-m");
    return m !== -1 && (rest[m + 1] === "pip" || rest[m + 1] === "pip3") ? parseInstall("pip", rest.slice(m + 2)) : null;
  }
  const manager = MANAGERS[cmd];
  if (!manager) return null;
  const [key, ecosystem] = manager;
  // Options may come before the subcommand: `npm --prefix web install zod`.
  const lead = options(key, rest, INSTALL_SUBCOMMANDS[cmd]);
  if (!lead) return null;
  const [sub, ...args] = lead.positional;
  let install: Install | null = null;
  const take = (from: string[]) => packages(ecosystem, key, from);
  switch (cmd) {
    case "npm":
      if (sub && NPM_INSTALL.has(sub)) install = take(args);
      break;
    case "pnpm":
    case "yarn":
    case "poetry":
      if (sub === "add") install = take(args);
      break;
    case "bun":
      if (sub === "add" || sub === "a" || sub === "install" || sub === "i") install = take(args);
      break;
    case "pip":
    case "pip3":
    case "pipenv":
      if (sub === "install") install = take(args);
      break;
    case "uv":
      if (sub === "add") install = take(args);
      else if (sub === "pip" && args[0] === "install") install = take(args.slice(1));
      break;
    case "cargo":
      if (sub === "add") install = take(args);
      break;
    case "go":
      if (sub === "get") install = take(args);
      break;
  }
  return install && { ...install, dir: install.dir ?? lead.dir };
}

/**
 * Split words into options and positional words, keeping their order for positionals. Null for a
 * global or throwaway install, which does not change the project.
 *
 * With `subcommands`, stop at the first positional (the subcommand). Before it, a word right after
 * an option this table does not know (`npm --loglevel warn install`) is taken as that option's
 * value unless it is an install subcommand, so an unlisted option cannot hide the subcommand.
 */
function options(manager: string, args: string[], subcommands?: Set<string>): { positional: string[]; dir: string | null } | null {
  const positional: string[] = [];
  let dir: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (a === "-g" || a === "--global" || a === "--location=global" || a === "--no-save") return null;
    if (a.startsWith("-") && a !== "-") {
      const [flag, inline] = a.split("=", 2) as [string, string | undefined];
      const next = args[i + 1];
      const takesValue = VALUE_FLAGS[manager]!.has(flag) || (subcommands !== undefined && next !== undefined && !next.startsWith("-") && !subcommands.has(next));
      const value = inline ?? (takesValue ? args[++i] : undefined);
      if (DIR_FLAGS.has(flag) && value) dir = value;
      continue;
    }
    if (subcommands) return { positional: args.slice(i), dir };
    positional.push(a);
  }
  return { positional, dir };
}

/** Positional package specs after the subcommand, or null for a global install. */
function packages(ecosystem: Ecosystem, manager: string, args: string[]): Install | null {
  const parsed = options(manager, args);
  return parsed && { ecosystem, specs: parsed.positional, dir: parsed.dir };
}

function isLocalSpec(spec: string): boolean {
  return /^(\.|\/|~|file:|link:|workspace:)/.test(spec) || /\.(whl|tar\.gz|tgz|zip)$/.test(spec);
}

/** The package name in a spec, without its version. Remote specs (git, URLs) are kept whole. */
export function packageName(ecosystem: Ecosystem, spec: string): string {
  if (/^[a-z+]+:/i.test(spec) || spec.includes("://")) return spec;
  switch (ecosystem) {
    case "npm": {
      const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
      return at > 0 ? spec.slice(0, at) : spec;
    }
    case "pypi":
      return normalizePypi(spec.split(/[[<>=!~;@\s]/)[0]!);
    case "crates":
    case "go":
      return spec.split("@")[0]!;
  }
}

/** Whether the project already declares the package (then installing it is not a new decision). */
function alreadyDeclared(ecosystem: Ecosystem, name: string, dir: string, workspace: string, read: ReadFile): boolean {
  for (const d of ancestors(dir, workspace)) {
    switch (ecosystem) {
      case "npm": {
        const manifest = read(join(d, "package.json"));
        if (manifest === null) continue;
        // A manifest Peer cannot parse declares nothing it can rely on: ask rather than assume.
        return safely(npmDependencies, manifest)?.has(name) ?? false;
      }
      case "pypi": {
        // Each manifest is parsed for its declarations; one Peer cannot read (null) declares nothing.
        const readers: [string, (text: string) => Set<string> | null][] = [
          ["requirements.txt", requirementNames],
          ["requirements-dev.txt", requirementNames],
          ["pyproject.toml", pyprojectDependencies],
          ["Pipfile", pipfileDependencies],
          ["setup.cfg", setupCfgDependencies],
          ["setup.py", setupPyDependencies],
        ];
        const texts = readers.map(([file, parse]) => [read(join(d, file)), parse] as const);
        if (texts.every(([t]) => t === null)) continue;
        return texts.some(([t, parse]) => t !== null && (safely(parse, t)?.has(name) ?? false));
      }
      case "crates": {
        const manifest = read(join(d, "Cargo.toml"));
        if (manifest === null) continue;
        return new RegExp(`^\\s*["']?${escapeRegExp(name)}["']?\\s*[=.]`, "m").test(manifest);
      }
      case "go": {
        const manifest = read(join(d, "go.mod"));
        if (manifest === null) continue;
        return new RegExp(`(^|\\s)${escapeRegExp(name)}(\\s|$)`, "m").test(manifest);
      }
    }
  }
  return false;
}

/** A manifest reader that throws declares nothing: the failure leads Peer to ask, never to allow silently. */
function safely(parse: (text: string) => Set<string> | null, text: string): Set<string> | null {
  try {
    return parse(text);
  } catch {
    return null;
  }
}

/** `dir` and its parents up to the workspace root (only `dir` itself if it is outside the workspace). */
function ancestors(dir: string, workspace: string): string[] {
  if (!inside(workspace, dir)) return [dir];
  const out: string[] = [];
  for (let d = dir; ; d = dirname(d)) {
    out.push(d);
    if (d === workspace || dirname(d) === d) return out;
  }
}

// ---------------------------------------------------------------------------
// Manifest edits

const NPM_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

type Manifest = { ecosystem: "npm" | "pypi"; names: (text: string) => Set<string> | null };

function manifestFor(path: string): Manifest | null {
  if (/(^|\/)node_modules\//.test(path)) return null;
  const name = basename(path);
  if (name === "package.json") return { ecosystem: "npm", names: npmDependencies };
  if (/^requirements[\w.-]*\.(txt|in)$/.test(name)) return { ecosystem: "pypi", names: requirementNames };
  return null;
}

export function npmDependencies(text: string): Set<string> | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;
  const names = new Set<string>();
  for (const section of NPM_SECTIONS) {
    const deps = (json as Record<string, unknown>)[section];
    if (deps && typeof deps === "object") for (const n of Object.keys(deps)) names.add(n);
  }
  return names;
}

function requirementNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    // Options (-r other.txt, -e ., --index-url) and local paths are not new packages.
    if (!line || line.startsWith("-") || isLocalSpec(line)) continue;
    names.add(packageName("pypi", line));
  }
  return names;
}

/** The absolute path of a tool argument, normalized so equivalent spellings of one file are one path. Changes outside the workspace are a safety matter (denied or asked separately), not this one. */
function workspacePath(p: unknown, workspace: string): string | null {
  if (typeof p !== "string" || !p) return null;
  const abs = resolve(workspace, p);
  return inside(workspace, abs) ? abs : null;
}

/** A file a write-like tool call would produce. */
interface EditedFile {
  path: string;
  before: string | null;
  /** The content after the call; null when Peer can't work it out. */
  after: string | null;
  added: string[];
  /** A hunk's old lines occur more than once, so `after` may have changed the wrong place. */
  ambiguous?: boolean;
  /** An edit's old text isn't literally in the file: it fails, or the tool matches loosely (OpenCode). */
  unmatched?: boolean;
}

function editedFiles(tool: string, a: Record<string, unknown>, workspace: string, read: ReadFile): EditedFile[] {
  const pathOf = (p: unknown) => workspacePath(p, workspace);
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);

  const patch = tool === "apply_patch" || tool === "patch";
  // Codex: a fileChange's changes, each with its own diff.
  if (patch && Array.isArray(a.changes)) {
    return (a.changes as { path?: unknown; kind?: { type?: unknown }; diff?: unknown }[]).flatMap((c): EditedFile[] => {
      const path = pathOf(c.path);
      if (!path || !manifestFor(path)) return [];
      const before = read(path);
      const diff = str(c.diff) ?? "";
      const type = c.kind?.type;
      if (type === "delete") return [];
      if (type === "add") return [{ path, before: null, after: stripAddedPrefix(diff), added: [] }];
      const lines = diffLines(diff);
      return [{ path, before, after: applyHunks(before ?? "", lines), added: addedLines(lines), ambiguous: hunksAmbiguous(before ?? "", lines) }];
    });
  }
  // OpenCode's apply_patch (the "*** Begin Patch" format).
  if (patch && typeof a.patchText === "string") {
    return parsePatchText(a.patchText).flatMap((f): EditedFile[] => {
      const path = pathOf(f.path);
      if (!path || !manifestFor(path) || f.type === "delete") return [];
      if (f.type === "add") return [{ path, before: null, after: stripAddedPrefix(f.lines.join("\n")), added: [] }];
      const before = read(path);
      return [{ path, before, after: applyHunks(before ?? "", f.lines), added: addedLines(f.lines), ambiguous: hunksAmbiguous(before ?? "", f.lines) }];
    });
  }

  const path = pathOf(a.filePath ?? a.file_path);
  if (!path || !manifestFor(path)) return [];
  if (tool === "write") {
    const content = str(a.content);
    return content === undefined ? [] : [{ path, before: read(path), after: content, added: [] }];
  }
  if (tool === "edit" || tool === "multiedit") {
    const before = read(path);
    const edits = Array.isArray(a.edits) ? (a.edits as Record<string, unknown>[]) : [a];
    let after = before ?? "";
    const added: string[] = [];
    let unmatched = false;
    for (const e of edits) {
      const from = str(e.oldString ?? e.old_string);
      const to = str(e.newString ?? e.new_string);
      if (from === undefined || to === undefined) return [];
      const all = (e.replaceAll ?? e.replace_all) === true;
      added.push(...to.split("\n"));
      if (from === "") after = to;
      else if (!after.includes(from)) unmatched = true;
      else after = all ? after.split(from).join(to) : after.replace(from, () => to);
    }
    return unmatched ? [{ path, before, after: null, added, unmatched }] : [{ path, before, after, added: [] }];
  }
  return [];
}

function detectManifestEdit(tool: string, a: Record<string, unknown>, workspace: string, read: ReadFile): Detection | null {
  const subjects: string[] = [];
  let ecosystem: Ecosystem = "npm";
  const files: string[] = [];
  for (const f of editedFiles(tool, a, workspace, read)) {
    if (f.unmatched) continue;
    const manifest = manifestFor(f.path)!;
    const before = f.before === null ? new Set<string>() : manifest.names(f.before);
    const after = f.after === null ? null : manifest.names(f.after);
    let added: string[];
    if (before && after) added = [...after].filter((n) => !before.has(n));
    else added = fallbackAdded(manifest, f.added, f.before ?? "");
    if (added.length === 0) continue;
    ecosystem = manifest.ecosystem;
    subjects.push(...added);
    files.push(relative(workspace, f.path) || f.path);
  }
  if (subjects.length === 0) return null;
  return { kind: "dependency", subjects: unique(subjects), ecosystem, action: `an edit to ${files.map((f) => `\`${f}\``).join(", ")}` };
}

/**
 * When a manifest cannot be parsed before or after the change (a patch that does not apply, JSON
 * that is invalid mid-edit), look at the added lines: a `"name": "<version>"` entry in package.json,
 * or a requirement line, that the current file does not already contain.
 */
function fallbackAdded(manifest: Manifest, lines: string[], before: string): string[] {
  if (manifest.ecosystem === "pypi") {
    const existing = requirementNames(before);
    return [...requirementNames(lines.join("\n"))].filter((n) => !existing.has(n));
  }
  const existing = npmDependencies(before) ?? new Set<string>();
  return lines
    .map((l) => /^\s*"([^"]+)"\s*:\s*"([^"]*)"/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null && isVersionSpec(m[2]!) && !existing.has(m[1]!) && !before.includes(`"${m[1]}"`))
    .map((m) => m[1]!);
}

function isVersionSpec(v: string): boolean {
  return /^\s*(\^|~|>=?|<=?|=)?\s*v?\d/.test(v) || /^(\*|latest|next|workspace:|npm:|file:|link:|git\+|git:|github:|https?:)/.test(v);
}

// ---------------------------------------------------------------------------
// Public API contracts

/** Copies, build output, tests and samples: nobody relies on a file here as the project's API. */
const NOT_THE_PROJECT = new Set(["node_modules", "vendor", "third_party", "third-party", ".git", "dist", "build", "target", "generated", "test", "tests", "__tests__", "testdata", "fixtures", "__fixtures__", "example", "examples"]);
const PACKAGE_CONTRACT_FIELDS = ["exports", "bin"];

/** A file that defines an API, by its name and location. Its content is not read. */
export function isContractFile(relativePath: string): boolean {
  const name = basename(relativePath).toLowerCase();
  if (name.endsWith(".proto") || name.endsWith(".graphqls")) return true;
  if (/\.(graphql|gql)$/.test(name)) {
    // Other .graphql files are usually a client's queries, not the API's schema.
    return /(^|[._-])schema\.(graphql|gql)$/.test(name) || dirname(relativePath).toLowerCase().split("/").some((d) => d === "schema" || d === "schemas");
  }
  return /(^|[._-])(openapi|swagger)([._-][\w.-]*)?\.(ya?ml|json)$/.test(name) && !/(^|[._-])(generator|config|ui)[._-]/.test(name);
}

function isProjectFile(relativePath: string): boolean {
  return !dirname(relativePath).toLowerCase().split("/").some((d) => NOT_THE_PROJECT.has(d));
}

/** Distinct workspace files a write-like tool call targets, as absolute paths. Shell commands have none Peer can see. */
export function editTargetPaths(tool: string, args: unknown, workspace: string): string[] {
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  return [...new Set(changedPaths(tool, a, workspace).map((f) => f.path))];
}

/** Every workspace file a write-like tool call changes, including both ends of a rename. */
function changedPaths(tool: string, a: Record<string, unknown>, workspace: string): { path: string; deleted: boolean }[] {
  const out: { path: string; deleted: boolean }[] = [];
  const add = (p: unknown, deleted = false) => {
    const path = workspacePath(p, workspace);
    if (path) out.push({ path, deleted });
  };
  const patch = tool === "apply_patch" || tool === "patch";
  if (patch && Array.isArray(a.changes)) {
    for (const c of a.changes as { path?: unknown; kind?: { type?: unknown; move_path?: unknown } }[]) {
      add(c.path, c.kind?.type === "delete");
      add(c.kind?.move_path);
    }
  } else if (patch && typeof a.patchText === "string") {
    for (const f of parsePatchText(a.patchText)) add(f.path, f.type === "delete");
    for (const m of a.patchText.matchAll(/^\*\*\* Move to: (.+)$/gm)) add(m[1]!.trim());
  } else if (tool === "write" || tool === "edit" || tool === "multiedit") {
    add(a.filePath ?? a.file_path);
  }
  return out;
}

function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const json: unknown = JSON.parse(text);
    return json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The contract fields of package.json that change. Compared as JSON text, not deep equality: the
 * order of `exports` conditions is significant. When Peer cannot tell (invalid JSON, a patch it
 * cannot place with certainty), it asks about any contract field the text mentions.
 */
function changedPackageFields(before: string | null, after: string | null, added: string[]): string[] {
  const was = before === null ? {} : jsonObject(before);
  const now = after === null ? null : jsonObject(after);
  if (was && now) return PACKAGE_CONTRACT_FIELDS.filter((k) => JSON.stringify(was[k]) !== JSON.stringify(now[k]));
  // `\u` is the only JSON escape that can spell a letter of these names ("exp\u006frts").
  const text = [before ?? "", after ?? "", ...added].join("\n").replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return PACKAGE_CONTRACT_FIELDS.filter((k) => text.includes(`"${k}"`));
}

/** A change to a public API contract a tool call would make, or null. Shell commands are not seen. */
export function detectContractChange(tool: string, args: unknown, workspace: string, read: ReadFile = readWorkspaceFile): Detection | null {
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const rel = (path: string) => relative(workspace, path);
  const subjects: string[] = [];
  const files: string[] = [];
  const found = (file: string, subject = file) => {
    subjects.push(subject);
    files.push(file);
  };
  const isPackage = (path: string) => basename(path) === "package.json" && isProjectFile(rel(path));
  for (const { path, deleted } of changedPaths(tool, a, workspace)) {
    if (isProjectFile(rel(path)) && isContractFile(rel(path))) found(rel(path));
    if (deleted && isPackage(path)) for (const k of changedPackageFields(read(path), "{}", [])) found(rel(path), `${rel(path)}#${k}`);
  }
  for (const f of editedFiles(tool, a, workspace, read)) {
    // A new-file patch reports no `before`, but it may overwrite a file that exists.
    if (isPackage(f.path)) for (const k of changedPackageFields(f.before ?? read(f.path), f.ambiguous ? null : f.after, f.added)) found(rel(f.path), `${rel(f.path)}#${k}`);
  }
  if (subjects.length === 0) return null;
  return { kind: "contract", subjects: unique(subjects), ecosystem: "api", action: `an edit to ${unique(files).map((f) => `\`${f}\``).join(", ")}` };
}

// ---------------------------------------------------------------------------
// Patches

/** Lines of a unified diff (or a patch section) without file headers. */
function diffLines(diff: string): string[] {
  const lines = diff.split("\n");
  const first = lines.findIndex((l) => l.startsWith("@@"));
  return first === -1 ? lines.filter((l) => !l.startsWith("--- ") && !l.startsWith("+++ ")) : lines.slice(first);
}

function addedLines(lines: string[]): string[] {
  return lines.filter((l) => l.startsWith("+") && !l.startsWith("+++ ")).map((l) => l.slice(1));
}

/** New-file content: Codex sends it as is, patch formats prefix every line with "+". */
function stripAddedPrefix(text: string): string {
  const lines = text.split("\n");
  const body = lines.at(-1) === "" ? lines.slice(0, -1) : lines;
  return body.length > 0 && body.every((l) => l.startsWith("+")) ? lines.map((l) => l.slice(1)).join("\n") : text;
}

/**
 * Apply hunks by locating their old lines (context and removals) in order, ignoring line numbers.
 * Returns null when a hunk does not match, so the caller falls back to the added lines.
 */
export function applyHunks(before: string, lines: string[]): string | null {
  const src = before.split("\n");
  const out: string[] = [];
  let pos = 0;
  for (const body of changingHunks(lines)) {
    const old = body.filter((l) => !l.startsWith("+")).map((l) => l.slice(1));
    const neu = body.filter((l) => !l.startsWith("-")).map((l) => l.slice(1));
    if (old.length === 0) return null;
    const at = findBlock(src, old, pos);
    if (at === -1) return null;
    out.push(...src.slice(pos, at), ...neu);
    pos = at + old.length;
  }
  out.push(...src.slice(pos));
  return out.join("\n");
}

/** Hunks that change something, without the patch text's final newline. */
function changingHunks(lines: string[]): string[][] {
  const hunks: string[][] = [[]];
  for (const l of lines) {
    if (l.startsWith("@@")) hunks.push([]);
    else if (!l.startsWith("\\")) hunks.at(-1)!.push(l);
  }
  return hunks.map((h) => (h.at(-1) === "" ? h.slice(0, -1) : h)).filter((h) => h.some((l) => l.startsWith("+") || l.startsWith("-")));
}

/**
 * Whether a hunk's old lines occur more than once. applyHunks takes the first; the real patch may
 * mean another (it goes by line number or an anchor Peer ignores).
 */
function hunksAmbiguous(before: string, lines: string[]): boolean {
  const src = before.split("\n").map((l) => l.trimEnd());
  return changingHunks(lines).some((hunk) => {
    const old = hunk.filter((l) => !l.startsWith("+")).map((l) => l.slice(1).trimEnd());
    let matches = 0;
    for (let i = 0; i + old.length <= src.length && old.length > 0; i++) if (old.every((l, j) => src[i + j] === l)) matches++;
    return matches > 1;
  });
}

function findBlock(src: string[], block: string[], from: number): number {
  for (const same of [(a: string, b: string) => a === b, (a: string, b: string) => a.trimEnd() === b.trimEnd()]) {
    for (let i = from; i + block.length <= src.length; i++) {
      if (block.every((l, j) => same(src[i + j]!, l))) return i;
    }
  }
  return -1;
}

function parsePatchText(text: string): { path: string; type: "add" | "update" | "delete"; lines: string[] }[] {
  const files: { path: string; type: "add" | "update" | "delete"; lines: string[] }[] = [];
  for (const line of text.split("\n")) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      files.push({ path: header[2]!.trim(), type: header[1]!.toLowerCase() as "add" | "update" | "delete", lines: [] });
      continue;
    }
    if (line.startsWith("*** ")) continue; // Begin/End Patch, Move to, End of File
    files.at(-1)?.lines.push(line);
  }
  return files;
}

// ---------------------------------------------------------------------------
// Shell words

/**
 * Simple commands of a shell command line, as words with quotes removed. Splits on `;`, `&&`,
 * `||`, `|`, `&`, newlines and parentheses, and drops redirections (`> log`, `2>&1`). Quoting is
 * respected; expansions are not performed.
 */
export function commandLines(command: string): string[][] {
  const lines: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: string | null = null;
  /** The next word is a redirection target. */
  let target = false;
  const flush = () => {
    if (inWord && target) target = false;
    else if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const end = () => {
    flush();
    target = false;
    if (words.length > 0) lines.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === "\\" && i + 1 < command.length) {
      word += command[++i];
      inWord = true;
    } else if (c === ">" || c === "<") {
      // `2>file`: the digits name a file descriptor, not an argument.
      if (/^\d+$/.test(word)) {
        word = "";
        inWord = false;
      }
      flush();
      while (command[i + 1] === ">") i++;
      if (command[i + 1] === "&") {
        i++;
        while (/[\d-]/.test(command[i + 1] ?? "")) i++;
      } else target = true;
    } else if (c === "\n" || c === ";" || c === "|" || c === "&" || c === "(" || c === ")") end();
    else if (/\s/.test(c)) flush();
    else {
      word += c;
      inWord = true;
    }
  }
  end();
  return lines;
}

// ---------------------------------------------------------------------------
// Developer words

// "Replace X", "remove X" and the like are about what goes out; they say nothing against what comes in.
const NEGATION = /n['’]t\b|\b(?:dont|not|no|never|without|avoid|instead|rather than)\b/i;
// "Can you add zod?" is a request; "can we add zod?" asks the developer's own question back.
const OPEN_QUESTION = /\b(?:should|whether|which|or|why|what|how|is|are|does|do we|do i|can we|could we|shall we)\b/i;
/** Any letter outside A-Z: the words may not be English, whose negations Peer would not recognize. */
const NON_ENGLISH = /[^\P{L}A-Za-z]/u;
/**
 * Pasted material: fenced code, a quoted line, or an indented line (four or more whitespace
 * characters, or a tab, at the start of any line, whatever follows). `^` starts every line.
 */
const PASTED = /```|~~~|^[^\S\r\n\u2028\u2029]*>|^[^\S\r\n\u2028\u2029]{4}|^[^\S\r\n\u2028\u2029]*\t/m;
/** Courtesy words that may open an imperative request. */
const LEAD = /^(?:(?:please|also|then|and|now|just|so|ok|okay|yes|sure|actually|alright|go ahead and|can you|could you|would you|will you)\b[\s,]*)*/i;
/** A request verb opening the sentence, then its direct object. "Replace X with Y" brings in Y. */
const REQUEST = /^(?:(?:add|install|use|include|adopt|switch to|move to|migrate to|go with|depend on)|(?:replace|swap)\s+\S+(?:\s+\S+)?\s+(?:with|for))\s+(?:the\s+)?/i;
/** One object of the request: `code`, "quoted", or a bare token. */
const OBJECT = /^(?:`([^`\s]+)`|"([^"\s]+)"|'([^'\s]+)'|([^\s,;:!?`"']+))/;
const PACKAGE_NOUN = /^\s+(?:package|library|lib|dependency|dep|module|crate)\b/i;

/**
 * Whether the developer's words ask for `subject`. Only an unambiguous request counts in free
 * text: English only; an imperative sentence that opens with a request verb ("Add …", "Please use
 * …", "Replace moment with …") whose direct object is the package; no negation; not an open
 * question; and the name written so it can only be a package: as code or quoted (`zod`), followed
 * by "package"/"library", or shaped like a package name (date-fns, @tanstack/query, py3-x).
 * A plain word ("add debug logging") or a mere mention ("we use httpx elsewhere", a pasted log,
 * "why is lodash here?") is not approval. With `choice`, the text is an option the developer
 * picked, so naming the package without a negation is enough. Missing an approval costs one
 * question; reading one that was not given would skip the developer, so the rules err that way.
 */
export function namesApproved(text: string, subject: string, choice = false): boolean {
  if (NON_ENGLISH.test(text)) return false;
  // Pasted material (fenced or indented code, quoted lines) may contain requests the developer
  // did not make. Who wrote what is uncertain, so the whole message infers nothing.
  if (!choice && PASTED.test(text)) return false;
  const same = (name: string) => {
    const bare = name.replace(/(?<=.)@[^/@]*$/, "").toLowerCase();
    return bare === subject.toLowerCase() || bare.replace(/[-_.]+/g, "-") === subject.toLowerCase().replace(/[-_.]+/g, "-");
  };
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    if (NEGATION.test(sentence)) continue;
    if (choice) {
      const named = new RegExp(`(^|[^\\w@/.-])${escapeRegExp(subject)}(?![\\w/-]|\\.\\w)`, "i");
      if (named.test(sentence)) return true;
      continue;
    }
    if (sentence.includes("?") && OPEN_QUESTION.test(sentence)) continue;
    const request = sentence.trim().replace(LEAD, "");
    const verb = REQUEST.exec(request);
    if (!verb) continue;
    // The objects: "add `zod` and `pino`", "use date-fns, dayjs".
    let rest = request.slice(verb[0].length);
    for (;;) {
      const obj = OBJECT.exec(rest);
      if (!obj) break;
      const quoted = obj[1] ?? obj[2] ?? obj[3];
      const name = (quoted ?? obj[4]!).replace(/\.$/, "");
      rest = rest.slice(obj[0].length);
      const marked = quoted !== undefined || PACKAGE_NOUN.test(rest) || /[@/_.\d-]/.test(name);
      if (marked && same(name)) return true;
      const more = /^\s*(?:,\s*(?:and\s+)?|and\s+)/.exec(rest);
      if (!more) break;
      rest = rest.slice(more[0].length);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
