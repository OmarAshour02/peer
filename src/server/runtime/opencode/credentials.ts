import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** OpenCode's credential file (`auth.json`): provider id -> credential. */
type Credentials = Record<string, unknown>;

/** The runtime's own credential file inside Peer's isolated OpenCode data dir. */
export function runtimeAuthFile(rootDir: string): string {
  return join(rootDir, "data", "opencode", "auth.json");
}

/** The developer's own OpenCode credentials (`opencode auth login`). */
export function userAuthFile(env: NodeJS.ProcessEnv): string {
  const dataHome = env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share");
  return join(dataHome, "opencode", "auth.json");
}

function readJson(file: string): Credentials {
  if (!existsSync(file)) return {};
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Credentials) : {};
  } catch {
    return {};
  }
}

/**
 * Entries the pinned runtime understands. Another OpenCode version may write other shapes,
 * which must not reach (and break) this one.
 */
function isCredential(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const str = (k: string) => typeof v[k] === "string";
  if (v.type === "api") return str("key");
  if (v.type === "oauth") return str("refresh") && str("access") && typeof v.expires === "number";
  if (v.type === "wellknown") return str("key") && str("token");
  return false;
}

/** Provider ids with a usable credential in `file`. Never returns the credentials themselves. */
export function credentialIds(file: string): Set<string> {
  return new Set(Object.entries(readJson(file)).flatMap(([id, value]) => (isCredential(value) ? [id] : [])));
}

/** Which providers Peer imported from the developer's own login, and which they connected in Peer. Ids only. */
function ownershipFile(runtimeFile: string): string {
  return join(dirname(runtimeFile), "peer-imported.json");
}

function readOwnership(runtimeFile: string): { ids: Set<string>; owned: Set<string> } {
  const data = readJson(ownershipFile(runtimeFile));
  const set = (v: unknown) => new Set(Array.isArray(v) ? v.filter((id): id is string => typeof id === "string") : []);
  return { ids: set(data.ids), owned: set(data.owned) };
}

function writeOwnership(runtimeFile: string, ids: Set<string>, owned: Set<string>) {
  const next = { ids: [...ids].sort(), owned: [...owned].sort() };
  const current = readOwnership(runtimeFile);
  if (JSON.stringify(next) === JSON.stringify({ ids: [...current.ids].sort(), owned: [...current.owned].sort() })) return;
  writeSecret(ownershipFile(runtimeFile), next);
}

/** Providers whose credentials came from the developer's own OpenCode login (not connected in Peer). */
export function importedIds(runtimeFile: string): Set<string> {
  return readOwnership(runtimeFile).ids;
}

function writeSecret(file: string, data: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/**
 * Sync the developer's own OpenCode logins into the runtime's credential file before it starts.
 * Their login is used for providers they signed in to there, unless they connected that provider
 * in Peer; a provider they have since logged out of is removed again. The runtime then reads and
 * writes one file, so keys saved through its API persist.
 */
export function importUserCredentials(userFile: string, runtimeFile: string): void {
  const { ids: previous, owned } = readOwnership(runtimeFile);
  const user = Object.fromEntries(Object.entries(readJson(userFile)).filter(([id, value]) => isCredential(value) && !owned.has(id)));
  const current = readJson(runtimeFile);
  const merged: Credentials = { ...current };
  for (const id of previous) if (!(id in user)) delete merged[id];
  Object.assign(merged, user);
  if (JSON.stringify(merged) !== JSON.stringify(current)) writeSecret(runtimeFile, merged);
  writeOwnership(runtimeFile, new Set(Object.keys(user)), owned);
}

/** The developer connected this provider in Peer: from now on it is Peer's, and imports leave it alone. */
export function markConnectedInPeer(runtimeFile: string, providerId: string): void {
  const { ids, owned } = readOwnership(runtimeFile);
  ids.delete(providerId);
  owned.add(providerId);
  writeOwnership(runtimeFile, ids, owned);
}

/** The developer disconnected this provider in Peer. */
export function markDisconnectedInPeer(runtimeFile: string, providerId: string): void {
  const { ids, owned } = readOwnership(runtimeFile);
  owned.delete(providerId);
  writeOwnership(runtimeFile, ids, owned);
}
