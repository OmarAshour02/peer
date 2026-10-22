// Classifies agent tool calls as read-only or mutating, so the collaboration gate can lock
// code changes while still letting the agent explore the codebase.
//
// The classification is deliberately conservative: anything not recognized as read-only is
// treated as mutating. A false "mutating" only costs the agent a retry after engagement; a
// false "read-only" would let an edit slip past the gate.

/** Tools that never modify the workspace. */
const READ_ONLY_TOOLS = new Set([
  "read",
  "glob",
  "grep",
  "list",
  "ls",
  "webfetch",
  "websearch",
  "codesearch",
  "todoread",
  "todowrite",
  "skill",
  "lsp",
  "peer_checkpoint",
  // Subagents run in child sessions whose tool calls are gated against the parent session.
  "task",
]);

/** Commands that are read-only regardless of arguments (modulo the redirection check). */
// Deliberately absent: pagers (less/more can run commands), ag (--pager), sed (has `w`/`e` commands;
// only its plain print form is allowed below).
const READ_ONLY_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "wc", "pwd", "echo", "printf", "grep", "egrep", "fgrep",
  "rg", "tree", "file", "stat", "du", "df", "which", "type", "whoami", "uname", "date",
  "printenv", "basename", "dirname", "realpath", "readlink", "diff", "cmp", "sort", "uniq", "cut", "tr",
  "column", "jq", "true", "false", "test", "[", "nl", "od", "hexdump", "md5sum", "sha256sum", "shasum",
]);

/** Read-only subcommands for multi-purpose tools. */
const READ_ONLY_SUBCOMMANDS: Record<string, Set<string>> = {
  git: new Set(["status", "log", "diff", "show", "blame", "branch", "rev-parse", "ls-files", "remote", "describe", "shortlog", "grep", "config", "tag"]),
  npm: new Set(["ls", "list", "view", "info", "outdated", "explain", "why"]),
  pnpm: new Set(["ls", "list", "why", "outdated"]),
  yarn: new Set(["list", "info", "why"]),
  cargo: new Set(["tree", "metadata"]),
  go: new Set(["list", "env", "version", "doc"]),
};

/** Mutating flags for otherwise read-only multi-purpose commands. */
const MUTATING_GIT_FLAGS = /\s-(d|D|m|M|O)\b|--delete|--move|--set-upstream|--unset|--add|--replace|--output|--open-files-in-pager|--ext-diff|--textconv/;

/** Flags that make an otherwise read-only command write files or run programs. */
const UNSAFE_FLAGS: Record<string, RegExp> = {
  rg: /\s--pre(-glob)?\b/,
  tree: /\s-o\b/,
  file: /\s-C\b|--compile/,
  sort: /\s-o\b|--output/,
  find: /\s-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)\b/,
  // `go env -w` / `-u` rewrite Go's environment config file. Go flags take one or two dashes.
  go: /\senv\b.*\s--?[wu]\b/,
};

/** Commands whose safety depends on their flags or operands. */
const ARG_SENSITIVE = new Set([...Object.keys(UNSAFE_FLAGS), "uniq", "git"]);

export function isReadOnlyTool(tool: string, args: unknown): boolean {
  if (tool === "bash") {
    const command = typeof args === "object" && args !== null ? (args as { command?: unknown }).command : undefined;
    return typeof command === "string" && isReadOnlyCommand(command);
  }
  return READ_ONLY_TOOLS.has(tool);
}

export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed === "") return false;
  // Any output redirection, command substitution, or backgrounding could write or run anything.
  if (/[>`]|\$\(|(?<!&)&(?!&)|<\(/.test(trimmed.replace(/2>&1|>\s*\/dev\/null/g, ""))) return false;

  const segments = trimmed.split(/&&|\|\||[;|\n]/);
  return segments.every((segment) => isReadOnlySegment(segment.trim()));
}

function isReadOnlySegment(segment: string): boolean {
  if (segment === "") return true;
  const words = segment.split(/\s+/);
  // Skip leading env assignments like FOO=bar cmd.
  while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift();
  const [cmd, sub] = words;
  if (!cmd) return true;
  const base = cmd.split("/").pop()!;

  if (base === "cd") return true;
  // Quoting or escaping can disguise a flag ('-o', \-o, -'o'), and expansion can inject one or
  // add operands ($OPTS, {in,out}, *). Check flags on the unquoted text, and give up on expansion
  // for commands whose safety depends on their arguments.
  const plain = segment.replace(/['"\\]/g, "");
  const unquoted = segment.replace(/'[^']*'|"[^"$`]*"/g, "''");
  if (ARG_SENSITIVE.has(base) && (/\$/.test(segment) || /[*?[\]{}]/.test(unquoted))) return false;
  // Only `sed -n '<lines>p' [files]`: sed scripts can otherwise write (w) or execute (e).
  if (base === "sed") return /^sed\s+-n\s+(['"]?)\d+(,(\d+|\$))?p\1(\s+[^\s-][^\s]*)*$/.test(words.join(" "));
  if (UNSAFE_FLAGS[base]?.test(plain)) return false;
  // `uniq [input [output]]` writes its second operand.
  if (base === "uniq") return countUniqOperands(commandArgs(segment)) <= 1;
  if (base === "find" || READ_ONLY_COMMANDS.has(base)) return true;

  const subs = READ_ONLY_SUBCOMMANDS[base];
  if (subs && sub && subs.has(sub)) {
    if (base === "git" && MUTATING_GIT_FLAGS.test(plain)) return false;
    if (base === "git" && sub === "config") {
      // Only getter forms read. git config stops parsing options at the first operand, so
      // `git config user.name --get` writes "--get": the getter must come before any operand or `--`.
      const args = commandArgs(segment).slice(1);
      const firstOperand = args.findIndex((w) => !w.startsWith("-") || w === "--");
      const opts = firstOperand === -1 ? args : args.slice(0, firstOperand);
      if (args.includes("--") || !opts.some((w) => ["--get", "--get-all", "--list", "-l"].includes(w))) return false;
    }
    // `git branch foo`, `git tag v1`, `git remote add ...` create things; only bare/flag-only forms list.
    if (base === "git" && ["branch", "tag", "remote"].includes(sub)) return words.slice(2).every((w) => w.startsWith("-"));
    return true;
  }
  return false;
}

/**
 * File operands of a uniq invocation. Values of -f/-s/-w are not operands; everything after `--`
 * is. BSD uniq (macOS) stops option parsing at the first operand, so `uniq in -c` writes a file
 * named "-c": after the first operand, every word counts.
 */
function countUniqOperands(args: string[]): number {
  let n = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    // Once an operand is seen, `--` is just another operand (BSD): `uniq in --` writes a file named "--".
    if (n > 0) return n + args.length - i;
    if (a === "--") return args.length - i - 1;
    if (/^-[fsw]$/.test(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-") && a !== "-") continue;
    n++;
  }
  return n;
}

/** Arguments after the command word, skipping leading `NAME=value` assignments. */
function commandArgs(segment: string): string[] {
  const words = shellWords(segment);
  while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift();
  return words.slice(1);
}

/** Shell words with quotes and escapes removed. Only used where expansion was already ruled out. */
function shellWords(segment: string): string[] {
  return (segment.match(/(?:[^\s'"\\]+|'[^']*'|"(?:[^"\\]|\\.)*"|\\.)+/g) ?? []).map((w) =>
    w.replace(/'([^']*)'|"((?:[^"\\]|\\.)*)"|\\(.)/g, (_, sq, dq, esc) => sq ?? dq?.replace(/\\(.)/g, "$1") ?? esc),
  );
}
