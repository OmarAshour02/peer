import type { PeerEvent } from "../shared/types.js";

/** Fan-out of Peer events to connected UI clients (SSE). */
export class EventHub {
  private readonly subscribers = new Set<(event: PeerEvent) => void>();

  subscribe(fn: (event: PeerEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  emit(event: PeerEvent) {
    for (const fn of this.subscribers) fn(event);
  }
}
