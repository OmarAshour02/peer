import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
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

/** `dir` relative to its repository root, with a trailing slash ("" at the root). */
async function prefixOf(dir: string): Promise<string> {
  return (await git(dir, ["rev-parse", "--show-prefix"])).trim();
}

/**
 * Paths (relative to the repository root) that differ between two snapshots; with
 * `insideDirectory`, only those inside `dir` (which may be a folder within the repository).
 */
export async function changedFiles(dir: string, base: string, current: string, opts: { insideDirectory?: boolean } = {}): Promise<string[]> {
  if (base === current) return [];
  const top = (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
  // -z: unquoted names (git quotes non-ASCII paths otherwise), separated by NUL.
  const files = (await git(top, ["diff-tree", "-r", "-z", "--no-renames", "--name-only", base, current])).split("\0").filter(Boolean);
  if (!opts.insideDirectory) return files;
  const prefix = await prefixOf(dir);
  return files.filter((f) => f.startsWith(prefix));
}

/**
 * Put `paths` (repository-relative, inside `dir`) back to how they are in `tree`: files the tree
 * lacks are deleted first (and directories left empty by that, up to `dir`), then the files it
 * has are written with their content and mode. Deleting first lets a file replace a directory and
 * the other way round. Uses its own temporary index, so the developer's index and staging area
 * are untouched. Paths outside `dir` are refused.
 */
export async function restoreFiles(dir: string, tree: string, paths: string[], indexFile: string): Promise<void> {
  if (paths.length === 0) return;
  const top = (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
  const prefix = await prefixOf(dir);
  const outside = paths.find((p) => !p.startsWith(prefix));
  if (outside) throw new Error(`${outside} is outside the workspace`);
  const root = prefix ? resolve(top, prefix) : top;
  const present = new Set<string>();
  for (let i = 0; i < paths.length; i += 200) {
    const out = await git(top, ["ls-tree", "-r", "-z", "--name-only", tree, "--", ...paths.slice(i, i + 200).map(literal)]);
    for (const p of out.split("\0")) if (p) present.add(p);
  }
  // Deepest first, so a directory's files go before the directory itself.
  for (const p of paths.filter((x) => !present.has(x)).sort((a, b) => b.length - a.length)) {
    const file = resolve(top, p);
    if (!file.startsWith(root + sep)) continue;
    try {
      rmSync(file, { force: true });
    } catch (err) {
      // Already gone along with a parent that is now a file.
      if ((err as NodeJS.ErrnoException).code !== "ENOTDIR") throw err;
    }
    // Remove directories the deleted file leaves empty, never the workspace folder itself.
    for (let d = dirname(file); d.startsWith(root + sep); d = dirname(d)) {
      try {
        if (readdirSync(d).length > 0) break;
        rmdirSync(d);
      } catch {
        break;
      }
    }
  }
  const restoreIndex = `${indexFile}.restore`;
  mkdirSync(dirname(restoreIndex), { recursive: true });
  try {
    await git(top, ["read-tree", tree], restoreIndex);
    const write = paths.filter((p) => present.has(p));
    for (let i = 0; i < write.length; i += 200) {
      await git(top, ["checkout-index", "-f", "--", ...write.slice(i, i + 200)], restoreIndex);
    }
  } finally {
    rmSync(restoreIndex, { force: true });
  }
}

/** A pathspec that matches exactly this path (no glob characters, no magic). */
function literal(path: string): string {
  return `:(literal)${path}`;
}
