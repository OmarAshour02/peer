import type { RuntimeInfo, RuntimeKind } from "../../shared/types.js";
import type { AgentRuntimeAdapter, RuntimeEvent } from "./adapter.js";

/** Unknown or unconfigured runtime kind requested by a caller. */
export class UnknownRuntimeError extends Error {}

/** The runtimes Peer can drive, by kind. Sessions are routed by `session.runtime`. */
export class RuntimeSet {
  private readonly adapters = new Map<RuntimeKind, AgentRuntimeAdapter>();

  constructor(adapters: AgentRuntimeAdapter[]) {
    for (const adapter of adapters) this.adapters.set(adapter.kind, adapter);
  }

  get(kind: RuntimeKind): AgentRuntimeAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new UnknownRuntimeError(`Runtime "${kind}" is not available in this Peer build`);
    return adapter;
  }

  has(kind: string): kind is RuntimeKind {
    return this.adapters.has(kind as RuntimeKind);
  }

  all(): AgentRuntimeAdapter[] {
    return [...this.adapters.values()];
  }

  info(): RuntimeInfo[] {
    return this.all().map((a) => ({ kind: a.kind, name: a.name, status: a.status() }));
  }

  onEvent(listener: (event: RuntimeEvent, kind: RuntimeKind) => void): () => void {
    const offs = this.all().map((a) => a.onEvent((e) => listener(e, a.kind)));
    return () => offs.forEach((off) => off());
  }

  /** Start every runtime; one failing (e.g. a CLI that is not installed) does not stop the others. */
  async startAll(log: (line: string) => void) {
    await Promise.all(
      this.all().map((a) =>
        a.start().catch((err) => log(`[peer] ${a.name} failed to start: ${err instanceof Error ? err.message : String(err)}`)),
      ),
    );
  }

  async stopAll() {
    await Promise.all(this.all().map((a) => a.stop().catch(() => {})));
  }
}
