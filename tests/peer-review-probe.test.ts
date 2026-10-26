import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { Store } from '../src/server/store.js';
import { PeerService } from '../src/server/service.js';
import { EventHub } from '../src/server/hub.js';
import { RuntimeSet } from '../src/server/runtime/set.js';
import { FakeRuntime } from './helpers.js';

describe('independent hint gate probes', () => {
  for (const kind of ['opencode', 'claude', 'codex'] as const) {
    it(`${kind}: a hint on a later question locks an already writable Learn turn`, async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'peer-review-')));
      const store = new Store(':memory:');
      try {
        const runtime = new FakeRuntime(kind);
        const service = new PeerService(store, new RuntimeSet([runtime]), new EventHub());
        const s = await service.createSession(service.addWorkspace(dir).id, { mode: 'learn' });
        await service.send(s.id, 'Implement caching');
        const a = await service.engine.requestCheckpoint(s.runtimeSessionId, null, { category: 'hypothesis', question: 'What should the cache key contain?' });
        await service.engine.resolveCheckpoint(a.checkpoint!.id, { action: 'answer', text: 'The request URL' });
        const b = await service.engine.requestCheckpoint(s.runtimeSessionId, null, { category: 'tradeoff', question: 'TTL or LRU eviction?' });
        await service.send(s.id, '', 'hint');
        expect(store.getCheckpoint(b.checkpoint!.id)!.resolution!.action).toBe('hint');
        expect(await service.engine.checkTool(s.runtimeSessionId, 'write', { filePath: 'cache.ts', content: 'changed' })).toMatchObject({ allow: false });
      } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
    });
  }
  it('routine declaration cannot unlock a checkpoint hint response', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'peer-review-')));
    const store = new Store(':memory:');
    try {
      const runtime = new FakeRuntime();
      const service = new PeerService(store, new RuntimeSet([runtime]), new EventHub());
      const s = await service.createSession(service.addWorkspace(dir).id, { mode: 'learn' });
      await service.send(s.id, 'Implement caching');
      const q = await service.engine.requestCheckpoint(s.runtimeSessionId, null, { category: 'hypothesis', question: 'What should the cache key contain?' });
      await service.engine.resolveCheckpoint(q.checkpoint!.id, { action: 'hint' });
      await service.engine.requestCheckpoint(s.runtimeSessionId, null, { category: 'routine', question: 'Wire up the cache helper' });
      expect(await service.engine.checkTool(s.runtimeSessionId, 'write', { filePath: 'cache.ts', content: 'changed' })).toMatchObject({ allow: false });
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
