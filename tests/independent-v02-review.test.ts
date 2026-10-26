import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { Store } from '../src/server/store.js';
import { PeerService } from '../src/server/service.js';
import { EventHub } from '../src/server/hub.js';
import { RuntimeSet } from '../src/server/runtime/set.js';
import { FakeRuntime } from './helpers.js';

describe('independent restart probes', () => {
  for (const mode of ['collaborate', 'learn'] as const) {
    it(`${mode}: ordinary answer after restart preserves sticky discussion`, async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'peer-independent-')));
      const store = new Store(':memory:');
      try {
        const runtime = new FakeRuntime();
        const service = new PeerService(store, new RuntimeSet([runtime]), new EventHub());
        const s = await service.createSession(service.addWorkspace(dir).id, {mode});
        await service.send(s.id, 'Discuss caching choices', 'discuss');
        const q = await service.engine.requestCheckpoint(s.runtimeSessionId, null, {category: 'tradeoff', question: 'TTL or LRU?'});
        service.engine.recover();
        const resumed = new PeerService(store, new RuntimeSet([runtime]), new EventHub());
        await resumed.engine.resolveCheckpoint(q.checkpoint!.id, {action:'answer', text:'Compare the memory costs of both before implementing.'});
        expect(store.getSession(s.id)!.discussing).toBe(true);
        expect(await resumed.engine.checkTool(s.runtimeSessionId, 'write', {filePath:'cache.ts', content:'change'})).toMatchObject({allow:false});
      } finally {store.close(); rmSync(dir, {recursive:true, force:true});}
    });
  }
  it('restart preserves Just do it after answering a mandatory risk question', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'peer-independent-')));
    const store = new Store(':memory:');
    try {
      const runtime = new FakeRuntime();
      const service = new PeerService(store, new RuntimeSet([runtime]), new EventHub());
      const s = await service.createSession(service.addWorkspace(dir).id, {mode:'collaborate'});
      await service.send(s.id, 'Implement caching', 'delegate');
      const q = await service.engine.requestCheckpoint(s.runtimeSessionId, null, {category:'risk', question:'Delete the existing cache?'});
      service.engine.recover();
      const resumed = new PeerService(store, new RuntimeSet([runtime]), new EventHub());
      await resumed.engine.resolveCheckpoint(q.checkpoint!.id, {action:'answer', text:'Yes, delete it.'});
      const optional = await resumed.engine.requestCheckpoint(s.runtimeSessionId, null, {category:'architecture', question:'Use a helper module?'});
      expect(optional.checkpoint!.status).toBe('auto_resolved');
    } finally {store.close(); rmSync(dir, {recursive:true, force:true});}
  });
});
