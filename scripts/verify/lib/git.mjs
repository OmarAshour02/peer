// Git scope detection, the isolated review snapshot, and content fingerprints.
//
// The reviewer never works in the developer's checkout. It gets a throwaway repository whose
// HEAD is the base of the change and whose working tree is the change, so `git diff` there shows
// exactly the feature diff (committed, uncommitted and untracked work alike).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { UsageError } from "../../lib/args.mjs";

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };

export function git(cwd, args, opts = {}) {
  return execFileSync("git", args, { cwd, env: GIT_ENV, maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...opts }).toString();
}

function tryGit(cwd, args) {
  try {
    return git(cwd, args).trim();
  } catch {
    return null;
  }
}

export function repoRoot(cwd) {
  const root = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) throw new UsageError(`${cwd} is not inside a git repository`);
  return realpathSync(root);
}

/**
 * Decide what the change is measured against.
 * @param {string} repo
 * @param {{ base?: string, baseBranches?: string[] }} [opts]
 * @returns {{ head: string|null, branch: string|null, base: { ref: string|null, sha: string|null, reason: string } }}
 */
export function detectScope(repo, { base, baseBranches = ["main", "origin/main"] } = {}) {
  const head = tryGit(repo, ["rev-parse", "--verify", "-q", "HEAD"]);
  const branch = tryGit(repo, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (base) {
    const sha = tryGit(repo, ["rev-parse", "--verify", "-q", `${base}^{commit}`]);
    if (!sha) throw new UsageError(`--base ${base} is not a commit in this repository`);
    return { head, branch, base: { ref: base, sha, reason: `explicit --base ${base}` } };
  }
  if (!head) return { head, branch, base: { ref: null, sha: null, reason: "the repository has no commits yet, so every file is new" } };
  for (const candidate of baseBranches) {
    const sha = tryGit(repo, ["rev-parse", "--verify", "-q", `${candidate}^{commit}`]);
    if (!sha) continue;
    if (branch && (candidate === branch || candidate.endsWith(`/${branch}`))) {
      return { head, branch, base: { ref: "HEAD", sha: head, reason: `on ${branch} itself, so only uncommitted changes are reviewed` } };
    }
    const mergeBase = tryGit(repo, ["merge-base", head, sha]);
    if (mergeBase) return { head, branch, base: { ref: candidate, sha: mergeBase, reason: `merge-base of ${branch ?? "HEAD"} and ${candidate}` } };
  }
  return { head, branch, base: { ref: "HEAD", sha: head, reason: `no base branch (${baseBranches.join(", ")}) found, so only uncommitted changes are reviewed` } };
}

/** Prefix ("dir/") or exact-path exclusion. */
export function isExcluded(path, patterns) {
  return patterns.some((p) => (p.endsWith("/") ? path.startsWith(p) || path === p.slice(0, -1) : path === p));
}

/** Tracked and untracked, non-ignored files that exist on disk. */
export function workingFiles(repo, exclude = []) {
  return git(repo, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
    .split("\0")
    .filter(Boolean)
    .filter((p, i, all) => all.indexOf(p) === i)
    .filter((p) => !isExcluded(p, exclude))
    .filter((p) => {
      try {
        const st = lstatSync(join(repo, p));
        return st.isFile() || st.isSymbolicLink();
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * Content fingerprint of the developer's checkout: HEAD plus a hash of every working file.
 * Taken before and after the reviewer runs; any difference means the reviewer wrote to it.
 */
export function fingerprint(repo, exclude = []) {
  const files = {};
  for (const p of workingFiles(repo, exclude)) {
    const full = join(repo, p);
    const st = lstatSync(full);
    const h = createHash("sha256");
    h.update(st.isSymbolicLink() ? `link:${readlinkSync(full)}` : readFileSync(full));
    files[p] = `${h.digest("hex").slice(0, 16)}:${(st.mode & 0o777).toString(8)}`;
  }
  const head = tryGit(repo, ["rev-parse", "--verify", "-q", "HEAD"]);
  const digest = createHash("sha256").update(JSON.stringify({ head, files })).digest("hex");
  return { head, digest, files };
}

/** Paths whose content differs between two fingerprints (added, removed or changed). */
export function changedBetween(a, b) {
  const paths = new Set([...Object.keys(a.files), ...Object.keys(b.files)]);
  return [...paths].filter((p) => a.files[p] !== b.files[p]).sort();
}

function copyEntry(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  const st = lstatSync(from);
  if (st.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
  else {
    copyFileSync(from, to);
    chmodSync(to, st.mode & 0o777);
  }
}

/**
 * Build the review snapshot.
 * @param {string} repo
 * @param {{ sha: string|null }} base
 * @param {{ exclude?: string[], linkIgnored?: string[], contextDir?: string }} opts
 * @returns {{ dir: string, files: { path: string, status: string }[], numstat: { added: number, removed: number }, patch: string }}
 */
export function createSnapshot(repo, base, { exclude = [], linkIgnored = [], contextDir = ".peer-verify" } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "peer-verify-review-")));
  git(dir, ["init", "-q"]);
  for (const [k, v] of [["user.email", "verify@peer.local"], ["user.name", "peer-verify"], ["commit.gpgsign", "false"], ["core.hooksPath", "/dev/null"]]) git(dir, ["config", k, v]);

  if (base.sha) {
    const tar = join(dir, ".git", "base.tar");
    git(repo, ["archive", "--format=tar", "-o", tar, base.sha]);
    execFileSync("tar", ["-xf", tar, "-C", dir]);
    rmSync(tar);
    for (const p of git(dir, ["ls-files", "-z", "--others"]).split("\0").filter(Boolean)) if (isExcluded(p, exclude)) rmSync(join(dir, p), { force: true });
    git(dir, ["add", "-A"]);
  }
  git(dir, ["commit", "-q", "--allow-empty", "--no-verify", "-m", base.sha ? `base ${base.sha}` : "base (empty repository)"]);

  // Replace the base tree with the developer's working tree.
  for (const entry of readdirSync(dir)) if (entry !== ".git") rmSync(join(dir, entry), { recursive: true, force: true });
  for (const p of workingFiles(repo, exclude)) copyEntry(join(repo, p), join(dir, p));

  // Ignored dependency trees are linked, not copied. Writes through the link resolve into the
  // developer's checkout, which the reviewer's sandbox does not allow.
  const ignore = [`/${contextDir}/`];
  for (const name of linkIgnored) {
    if (existsSync(join(repo, name)) && !existsSync(join(dir, name))) {
      symlinkSync(join(repo, name), join(dir, name));
      ignore.push(`/${name}`);
    }
  }
  writeFileSync(join(dir, ".git", "info", "exclude"), `${ignore.join("\n")}\n`);

  git(dir, ["add", "-A", "--intent-to-add"]);
  const tokens = git(dir, ["diff", "--name-status", "--no-renames", "-z", "HEAD"]).split("\0").filter(Boolean);
  const files = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) files.push({ status: tokens[i], path: tokens[i + 1] });
  let added = 0;
  let removed = 0;
  for (const line of git(dir, ["diff", "--numstat", "HEAD"]).split("\n").filter(Boolean)) {
    const [a, r] = line.split("\t");
    added += Number(a) || 0;
    removed += Number(r) || 0;
  }
  const patch = git(dir, ["diff", "--binary", "--no-renames", "HEAD"]);
  return { dir, files, numstat: { added, removed }, patch, tree: worktreeTree(dir) };
}

/** Tree object of the snapshot's working state, built in a private index so `git diff` is untouched. */
export function worktreeTree(dir) {
  const env = { ...GIT_ENV, GIT_INDEX_FILE: join(dir, ".git", "peer-verify-index") };
  git(dir, ["add", "-A"], { env });
  return git(dir, ["write-tree"], { env }).trim();
}

/** The reviewer's own scratch edits inside the snapshot (probe tests etc.), kept as evidence. */
export function snapshotScratch(dir, originalTree) {
  const now = worktreeTree(dir);
  if (now === originalTree) return "";
  return git(dir, ["diff-tree", "-r", "--stat", originalTree, now]) + "\n" + git(dir, ["diff-tree", "-r", "-p", "--binary", originalTree, now]);
}
