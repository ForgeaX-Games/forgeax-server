import { expect, test } from 'bun:test';
import { readPerceptionEvidence } from './perception-evidence';
const ctx = { agentId: 'forge', projectRoot: '/tmp/isolated-test' };
const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';

test('missing channels, timeout, thrown errors and malformed data never become observations', async () => {
  for (const kind of ['world', 'frame'] as const) {
    expect(await readPerceptionEvidence(kind, ctx)).toMatchObject({ ok: false, unavailable: true, evidenceStatus: 'unverified', error: { code: 'perception-evidence-unavailable' } });
    for (const result of [null, {}, { unavailable: true, reason: 'timeout' }, { ok: false, error: 'failed' }]) {
      expect(await readPerceptionEvidence(kind, { ...ctx, perception: async () => result })).toMatchObject({ ok: false, evidenceStatus: 'unverified' });
    }
    expect(await readPerceptionEvidence(kind, { ...ctx, perception: async () => { throw new Error('offline'); } })).toMatchObject({ error: { reason: 'offline', retryable: false } });
  }
});
test('returns a complete decodable PNG and byte count, without claiming gameplay acceptance', async () => {
  expect(await readPerceptionEvidence('frame', { ...ctx, perception: async () => ({ dataUrl }) })).toEqual({ ok: true, evidenceStatus: 'observed', evidenceKind: 'frame', gameplayVerified: false, dataUrl, bytes: Buffer.from(dataUrl.split(',')[1]!, 'base64').length });
  for (const invalid of [dataUrl.slice(0, 64) + '…', dataUrl.slice(0, 66), 'data:image/png;base64,aGVsbG8=']) {
    expect(await readPerceptionEvidence('frame', { ...ctx, perception: async () => ({ dataUrl: invalid }) })).toMatchObject({ ok: false });
  }
});
test('preserves an empty but valid world and forwards the query', async () => {
  let query: unknown;
  const world = { entityCount: 0, archetypes: [], systems: [] };
  expect(await readPerceptionEvidence('world', { ...ctx, perception: async (_, q) => { query = q; return world; } }, 'player')).toEqual({ ...world, ok: true, evidenceStatus: 'observed', evidenceKind: 'world-snapshot', gameplayVerified: false });
  expect(query).toBe('player');
});
