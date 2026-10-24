import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LocalServerInfo, LocalServerKind } from "../../../shared/types.js";
import { ProviderError } from "../adapter.js";

// Local model servers (Ollama, LM Studio, anything OpenAI-compatible). Peer keeps the servers the
// developer added in its own file and writes them as custom providers into the OpenCode config
// file in Peer's config dir, which OpenCode re-reads on a provider reload. Nothing here sends a
// credential: local servers are called without one.

/** A server the developer added. `id` is its OpenCode provider id. */
export interface LocalServerRecord {
  id: string;
  name: string;
  kind: LocalServerKind;
  baseUrl: string;
  /** Model ids, as last seen on the server (kept while it is not running). */
  models: string[];
}

interface Preset {
  kind: Exclude<LocalServerKind, "custom">;
  name: string;
  baseUrl: string;
}

/** Peer's record of added servers. */
export function localServersFile(rootDir: string): string {
  return join(rootDir, "peer-local-models.json");
}

/** The OpenCode config file Peer owns (in OPENCODE_CONFIG_DIR, which only Peer uses). */
export function peerConfigFile(rootDir: string): string {
  return join(rootDir, "peer-config", "opencode.json");
}

/** Ollama's address from OLLAMA_HOST ("host", "host:port" or a URL), as an OpenAI-compatible base URL. */
export function ollamaBaseUrl(env: NodeJS.ProcessEnv): string {
  const raw = env.OLLAMA_HOST?.trim();
  if (!raw) return "http://127.0.0.1:11434/v1";
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`);
    // A server bound to every interface is reached on loopback.
    if (url.hostname === "0.0.0.0" || url.hostname === "[::]") url.hostname = "127.0.0.1";
    if (!url.port && url.protocol === "http:") url.port = "11434";
    return `${url.origin}/v1`;
  } catch {
    return "http://127.0.0.1:11434/v1";
  }
}

export function localPresets(env: NodeJS.ProcessEnv): Preset[] {
  return [
    { kind: "ollama", name: "Ollama", baseUrl: ollamaBaseUrl(env) },
    { kind: "lmstudio", name: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1" },
  ];
}

/**
 * An OpenAI-compatible base URL: http(s) only, no credentials in it, no trailing slash, and
 * "/v1" when the developer typed only the server address.
 */
export function normalizeBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new ProviderError("Enter the server's address, e.g. http://127.0.0.1:8080/v1.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ProviderError("Only http:// and https:// addresses are supported.");
  if (url.username || url.password) throw new ProviderError("Leave credentials out of the address.");
  url.hash = "";
  url.search = "";
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path || "/v1"}`;
}

/** Model ids the server lists at `GET <base>/models`, or null when it does not answer. Embedding models are left out. */
export async function fetchModels(baseUrl: string, timeoutMs = 1500): Promise<string[] | null> {
  try {
    const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    if (!Array.isArray(body.data)) return null;
    const ids = body.data.map((m) => m.id).filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 200);
    return [...new Set(ids)].filter((id) => !/embed/i.test(id)).sort();
  } catch {
    return null;
  }
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "server";
}

function writeAtomic(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

/** The added servers and the OpenCode config generated from them. */
export class LocalServers {
  constructor(private readonly rootDir: string) {}

  list(): LocalServerRecord[] {
    try {
      const data = JSON.parse(readFileSync(localServersFile(this.rootDir), "utf8")) as { servers?: unknown };
      if (!Array.isArray(data.servers)) return [];
      return data.servers.filter(
        (s): s is LocalServerRecord =>
          !!s && typeof s.id === "string" && typeof s.name === "string" && typeof s.baseUrl === "string" && Array.isArray(s.models) && s.models.every((m: unknown) => typeof m === "string"),
      );
    } catch {
      return [];
    }
  }

  private save(servers: LocalServerRecord[]) {
    writeAtomic(localServersFile(this.rootDir), `${JSON.stringify({ servers }, null, 2)}\n`);
    this.writeConfig(servers);
  }

  /** Write the OpenCode config for the added servers (also at runtime start, before OpenCode reads it). */
  writeConfig(servers = this.list()) {
    const provider = Object.fromEntries(
      servers.map((s) => [
        s.id,
        {
          npm: "@ai-sdk/openai-compatible",
          name: `${s.name} (local)`,
          options: { baseURL: s.baseUrl },
          // Coding agents need tool calls; OpenCode gives a model no tools unless it says it supports them.
          models: Object.fromEntries(s.models.map((m) => [m, { name: m, tool_call: true }])),
        },
      ]),
    );
    writeAtomic(peerConfigFile(this.rootDir), `${JSON.stringify({ provider }, null, 2)}\n`);
  }

  async add(input: { baseUrl: string; name?: string; kind?: LocalServerKind }): Promise<LocalServerRecord> {
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const servers = this.list();
    if (servers.some((s) => s.baseUrl === baseUrl)) throw new ProviderError(`${baseUrl} is already added.`);
    const models = await fetchModels(baseUrl, 3000);
    if (models === null) throw new ProviderError(`Nothing answered at ${baseUrl}/models. Start the server (and load a model), then try again.`);
    if (models.length === 0) throw new ProviderError(`${baseUrl} has no models. Download or load one first.`);
    const name = input.name?.trim().slice(0, 60) || new URL(baseUrl).host;
    let id = `local-${slug(name)}`;
    for (let n = 2; servers.some((s) => s.id === id); n++) id = `local-${slug(name)}-${n}`;
    const record: LocalServerRecord = { id, name, kind: input.kind ?? "custom", baseUrl, models };
    this.save([...servers, record]);
    return record;
  }

  remove(id: string) {
    const servers = this.list();
    if (!servers.some((s) => s.id === id)) throw new ProviderError("That local server is not added.");
    this.save(servers.filter((s) => s.id !== id));
  }

  /**
   * Ask every added server and the presets for their models. Added servers that answer with a
   * different list are updated; returns what to show, and whether the config changed.
   */
  async refresh(env: NodeJS.ProcessEnv): Promise<{ servers: LocalServerInfo[]; changed: boolean }> {
    const added = this.list();
    const presets = localPresets(env).filter((p) => !added.some((s) => s.baseUrl === p.baseUrl));
    const [addedModels, presetModels] = await Promise.all([
      Promise.all(added.map((s) => fetchModels(s.baseUrl))),
      Promise.all(presets.map((p) => fetchModels(p.baseUrl))),
    ]);
    let changed = false;
    const next = added.map((s, i) => {
      const models = addedModels[i];
      if (!models || models.length === 0 || models.join("\n") === s.models.join("\n")) return s;
      changed = true;
      return { ...s, models };
    });
    if (changed) this.save(next);
    return {
      changed,
      servers: [
        ...next.map((s, i) => ({ id: s.id, name: s.name, kind: s.kind, baseUrl: s.baseUrl, added: true, running: addedModels[i] !== null, models: s.models })),
        ...presets.map((p, i) => ({ id: null, name: p.name, kind: p.kind, baseUrl: p.baseUrl, added: false, running: presetModels[i] !== null, models: presetModels[i] ?? [] })),
      ],
    };
  }
}
