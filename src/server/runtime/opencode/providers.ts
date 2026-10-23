import type { ProviderAuthMethodInfo, ProviderAuthPrompt, ProviderCatalog, ProviderEntry, ProviderSource } from "../../../shared/types.js";

/** The parts of OpenCode's `GET /provider` this module reads. Its entries also carry keys and options; those never leave. */
export interface OcProviderList {
  all: { id: string; name: string; source: string; env: string[]; models: Record<string, unknown> }[];
  connected: string[];
}

/** OpenCode's `GET /provider/auth`: login methods per provider, for providers that have more than an API key. */
export type OcAuthMethods = Record<string, { type: "oauth" | "api"; label: string; prompts?: ProviderAuthPrompt[] }[]>;

/** Shown first when picking a provider to connect. */
const POPULAR = ["anthropic", "openai", "google", "openrouter", "github-copilot", "opencode", "amazon-bedrock", "azure", "groq", "mistral", "xai", "deepseek"];

const API_KEY: ProviderAuthMethodInfo = { type: "api", label: "API key", prompts: [] };

/**
 * Where a connected provider's credentials come from. `runtimeIds` are the providers in the
 * runtime's own credential file, `userIds` those Peer imported into it from the developer's
 * `opencode auth login` at start.
 */
function sourceOf(provider: OcProviderList["all"][number], runtimeIds: Set<string>, userIds: Set<string>): ProviderSource {
  if (userIds.has(provider.id)) return "opencode-login";
  if (runtimeIds.has(provider.id)) return "peer";
  if (provider.source === "env") return "environment";
  if (provider.source === "config") return "config";
  return "built-in";
}

export function toCatalog(list: OcProviderList, methods: OcAuthMethods, runtimeIds: Set<string>, userIds: Set<string>, reloadPending: boolean): ProviderCatalog {
  const connected = new Set(list.connected);
  const rank = (id: string) => (POPULAR.includes(id) ? POPULAR.indexOf(id) : POPULAR.length);
  const providers: ProviderEntry[] = list.all.map((p) => ({
    id: p.id,
    name: p.name,
    connected: connected.has(p.id),
    source: connected.has(p.id) ? sourceOf(p, runtimeIds, userIds) : undefined,
    modelCount: Object.keys(p.models ?? {}).length,
    methods: methods[p.id]?.map((m) => ({ type: m.type, label: m.label, prompts: m.prompts ?? [] })) ?? [API_KEY],
    env: p.env ?? [],
  }));
  providers.sort((a, b) => Number(b.connected) - Number(a.connected) || rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
  return { providers, reloadPending };
}

/**
 * OpenCode reads providers once per instance; picking up a new credential means disposing its
 * instances, which aborts every running session. So a reload waits until no OpenCode session is
 * busy, and prompts wait (`hold`) while a reload runs.
 */
export class ProviderReload {
  private pending = false;
  /** Whether listeners already know a reload is waiting. */
  private announced = false;
  private running: Promise<boolean> | null = null;
  private holds = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: {
      anyBusy(): Promise<boolean>;
      dispose(): Promise<void>;
      /** A reload started waiting (true) or ran (false, unless another request came in meanwhile). */
      onChange(pending: boolean): void;
      log(line: string): void;
      retryMs?: number;
    },
  ) {}

  get isPending(): boolean {
    return this.pending;
  }

  /** Reload now if nothing is running; otherwise once the running sessions finish. Resolves true if it reloaded now. */
  request(): Promise<boolean> {
    this.pending = true;
    return this.attempt();
  }

  /** A session went idle: a waiting reload may be able to run. */
  poke() {
    if (this.pending) void this.attempt();
  }

  /** Call before starting a turn; release once the runtime has accepted it (it then reports the session busy). */
  async hold(): Promise<() => void> {
    while (this.running) await this.running;
    this.holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      this.poke();
    };
  }

  /** The runtime stopped: its next start reads the new credentials anyway. */
  reset() {
    this.pending = false;
    this.announced = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private attempt(): Promise<boolean> {
    this.running ??= this.run().finally(() => {
      this.running = null;
      if (this.pending) this.schedule();
    });
    return this.running;
  }

  private async run(): Promise<boolean> {
    if (!this.pending) return true;
    let busy = this.holds > 0;
    if (!busy) {
      try {
        busy = await this.deps.anyBusy();
      } catch (err) {
        this.deps.log(`[peer] could not check OpenCode sessions before reloading providers: ${String(err)}`);
        busy = true;
      }
    }
    if (busy) {
      this.announceWaiting();
      return false;
    }
    this.pending = false;
    try {
      await this.deps.dispose();
    } catch (err) {
      this.deps.log(`[peer] reloading OpenCode providers failed: ${String(err)}`);
      this.pending = true;
      this.announceWaiting();
      return false;
    }
    this.announced = false;
    this.deps.onChange(this.pending);
    return true;
  }

  private announceWaiting() {
    if (this.announced) return;
    this.announced = true;
    this.deps.onChange(true);
  }

  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.poke();
    }, this.deps.retryMs ?? 3000);
    this.timer.unref?.();
  }
}
