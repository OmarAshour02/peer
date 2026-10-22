import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, parse } from "node:path";

export class WorkspaceError extends Error {}

/**
 * Validate a directory the developer chose as a workspace. The agent is confined to explicitly
 * chosen workspaces (OpenCode's `external_directory` permission is denied), so refuse paths that
 * would make that confinement meaningless.
 */
export function validateWorkspacePath(input: unknown, home: string = homedir()): { path: string; name: string } {
  if (typeof input !== "string" || input.trim() === "") throw new WorkspaceError("A directory path is required.");
  const raw = input.trim();
  if (!isAbsolute(raw)) throw new WorkspaceError("Use an absolute path.");

  let path: string;
  try {
    path = realpathSync(raw);
  } catch {
    throw new WorkspaceError(`Directory does not exist: ${raw}`);
  }
  if (!statSync(path).isDirectory()) throw new WorkspaceError(`Not a directory: ${path}`);

  const resolvedHome = safeRealpath(home);
  if (path === parse(path).root) throw new WorkspaceError("The filesystem root cannot be a workspace.");
  if (path === resolvedHome) throw new WorkspaceError("Your home directory cannot be a workspace; choose a project folder.");

  return { path, name: basename(path) };
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
