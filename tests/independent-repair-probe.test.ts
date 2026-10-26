import { it, expect } from 'vitest';
import { Store } from '../src/server/store.js';
import { PeerService } from '../src/server/service.js';
import { EventHub } from '../src/server/hub.js';
import { RuntimeSet } from '../src/server/runtime/set.js';
import { FakeRuntime } from './helpers.js';
it('mode round trip retires hint on interrupted resume', async () => {
 const store = new Store(':memory:');
 try {
  const runtime = new FakeRuntime();
  let service = new PeerService(store, new RuntimeSet([runtime]), new EventHub());
  const s = await service.createSession(service.addWorkspace(process.cwd()).id, {mode:'learn'});
  await service.send(s.id, 'Explain caching', 'hint');
  const q = await service.engine.requestCheckpoint(s.runtimeSessionId, null, {category:'risk', question:'Delete cache?'});
  service.engine.recover();
  service = new PeerService(store, new RuntimeSet([runtime]), new EventHub());
  service.updateSession(s.id, {mode:'collaborate'});
  service.updateSession(s.id, {mode:'learn'});
  await service.engine.resolveCheckpoint(q.checkpoint!.id, {action:'answer', text:'Keep it; implement the non-destructive approach.'});
  expect(store.latestTurn(s.id)!.intent).toBe('default');
 } finally { store.close(); }
});
