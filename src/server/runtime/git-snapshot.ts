import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { FileDiff } from "../../shared/types.js";

// Session diffs for runtimes that don't track file changes per session themselves (Claude Code,
// Codex). Peer records the workspace as a git tree when a session starts working and diffs the
// current workspace against it. A private index file keeps this away from the developer's own
// index and staging area; nothing is committed and no refs are created (the snapshot objects are
// ordinary unreferenced git objects that `git gc` eventually prunes).

const MAX_PATCH_BYTES = 200_000;

function git(dir: string, args: string[], indexFile?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: dir,
        maxBuffer: 32 * 1024 * 1024,
        timeout: 30_000,
        env: { ...process.env, ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}), GIT_OPTIONAL_LOCKS: "0" },
      },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
    );
  });
}

/** Tree hash of the workspace as it is now (tracked + untracked, honoring .gitignore), or null outside git. */
export async function snapshotWorkspace(dir: string, indexFile: string): Promise<string | null> {
  try {
    if ((await git(dir, ["rev-parse", "--is-inside-work-tree"])).trim() !== "true") return null;
    const top = (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
    mkdirSync(dirname(indexFile), { recursive: true });
    await git(top, ["add", "-A", "--", "."], indexFile);
    return (await git(top, ["write-tree"], indexFile)).trim() || null;
  } catch {
    return null;
  }
}

/** Files changed between a snapshot and the current workspace, with unified patches. */
export async function diffSinceSnapshot(dir: string, base: string, indexFile: string): Promise<FileDiff[]> {
  const current = await snapshotWorkspace(dir, indexFile);
  if (!current || current === base) return [];
  const top = (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
  const numstat = await git(top, ["diff-tree", "-r", "--no-renames", "--numstat", base, current]);
  const nameStatus = await git(top, ["diff-tree", "-r", "--no-renames", "--name-status", base, current]);
  const statusOf = new Map<string, FileDiff["status"]>();
  for (const line of nameStatus.split("\n")) {
    const [s, file] = line.split("\t");
    if (!file) continue;
    statusOf.set(file, s === "A" ? "added" : s === "D" ? "deleted" : "modified");
  }
  const diffs: FileDiff[] = [];
  for (const line of numstat.split("\n")) {
    const [add, del, file] = line.split("\t");
    if (!file) continue;
    let patch: string | undefined;
    try {
      const text = await git(top, ["diff", "--no-color", "--no-ext-diff", base, current, "--", file]);
      patch = text.length > MAX_PATCH_BYTES ? undefined : text;
    } catch {
      patch = undefined;
    }
    // Binary files report "-" for both counts.
    diffs.push({ file, additions: Number(add) || 0, deletions: Number(del) || 0, status: statusOf.get(file) ?? "modified", patch });
  }
  return diffs;
}

/** Paths (relative to the repository root) that differ between two snapshots. */
export async function changedFiles(dir: string, base: string, current: string): Promise<string[]> {
  if (base === current) return [];
  const top = (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
  // -z: unquoted names (git quotes non-ASCII paths otherwise), separated by NUL.
  return (await git(top, ["diff-tree", "-r", "-z", "--no-renames", "--name-only", base, current])).split("\0").filter(Boolean);
}
