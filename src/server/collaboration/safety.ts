// Safety rules shared by every runtime and every collaboration mode: destructive shell commands
// always need the developer's explicit approval. OpenCode receives these as permission patterns;
// for Claude Code and Codex, Peer applies them itself before a command runs.

/** Glob-style command patterns (`*` matches anything), in OpenCode's permission syntax. */
export const DESTRUCTIVE_COMMAND_PATTERNS = [
  "rm *", "rmdir *", "sudo *", "su *", "dd *", "mkfs*", "shutdown*", "reboot*", "truncate *",
  "chmod -R *", "chown *", "kill *", "pkill *", "killall *",
  "git push*", "git reset --hard*", "git clean *", "git checkout -- *", "git restore *", "git rebase *",
  "git branch -D *", "git stash drop*", "git stash clear*", "git filter-branch*",
  "npm publish*", "pnpm publish*", "yarn publish*", "docker rm*", "docker system prune*",
  "curl * | sh*", "curl * | bash*", "wget * | sh*", "wget * | bash*", "find * -delete*",
] as const;

const PATTERNS = DESTRUCTIVE_COMMAND_PATTERNS.map(
  (p) => new RegExp(`^${p.replace(/[.+?^${}()[\]\\]/g, "\\$&").replace(/\|/g, "\\|").replace(/\*/g, ".*")}$`, "s"),
);

/** `/bin/zsh -lc 'cmd'` (how Codex reports commands) -> `cmd`. */
export function unwrapShell(command: string): string {
  const m = /^\s*(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(command);
  return m ? m[2]! : command;
}

/** Prefixes that run the rest of the line as a command. */
const WRAPPERS = /^(?:env(?:\s+-\S+)*|command|exec|nohup|time|nice(?:\s+-n\s*\S+)?|xargs(?:\s+-\S+)*|timeout\s+\S+)\s+/;

/** `FOO=1 env /bin/rm -rf x` -> `rm -rf x`: drop env assignments, wrappers and the command's path. */
function normalizeSegment(segment: string): string {
  let s = segment.trim();
  // xargs supplies the arguments, so `xargs rm` means `rm <files>`.
  const viaXargs = /^xargs\b/.test(s.replace(/^(?:\w+=\S*\s+)+/, ""));
  for (let i = 0; i < 8; i++) {
    const next = s.replace(/^(?:\w+=\S*\s+)+/, "").replace(WRAPPERS, "").replace(/^\S*\/(?=\S)/, "");
    if (next === s) break;
    s = next;
  }
  return viaXargs ? `${s} <args>` : s;
}

/**
 * True if any part of the command matches a destructive pattern. Checks the whole command and
 * each `;`/`&&`/`||`/`|`/`&`/newline-separated segment, so `cd x && rm -rf y` and `ls | xargs rm`
 * are caught.
 */
export function isDestructiveCommand(command: string): boolean {
  const cmd = unwrapShell(command).trim();
  const candidates = [cmd, ...cmd.split(/;|&&|\|\|?|&|\n|\$\(|`/)].map(normalizeSegment).filter(Boolean);
  return candidates.some((c) => PATTERNS.some((re) => re.test(c)));
}
