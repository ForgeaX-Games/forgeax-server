import { expect, test } from 'bun:test';
import {
  aggregatePositiveDurationFrames,
  assertSameCarrierDiagnostics,
  createBoundedRawLogWindow,
} from '../src/game/gameplay-capture';
import type { GameplayIdentity } from '../src/game/gameplay-operation-contract';

const identity: GameplayIdentity = {
  carrierId: 'runtime:1',
  runtimeId: 'runtime-1',
  scope: { projectId: 'project-a', gameId: 'gta-route-dev' },
  pageIdentity: 'page-1',
  canvasIdentity: 'canvas-1',
  rendererIdentity: 'renderer-1',
  rendererGeneration: 3,
};

test('returns all raw entries in bounded windows with continuation metadata', () => {
  const result = createBoundedRawLogWindow({ windowId: 'window-1', identity, entries: [{ level: 'debug' }, { level: 'error' }, { level: 'info' }], limit: 2 });
  expect(result).toMatchObject({ ok: true, value: { entries: [{ level: 'debug' }, { level: 'error' }], truncated: true, continuationToken: 'window-1:2', startIndex: 0, endIndexExclusive: 2 } });
});

test('requires at least two samples and a positive-duration frame window', () => {
  expect(aggregatePositiveDurationFrames({ windowId: 'window-2', identity, samples: [{ atMs: 10, durationMs: 0 }] })).toMatchObject({ ok: false, error: { code: 'invalid-frame-window' } });
  expect(aggregatePositiveDurationFrames({ windowId: 'window-2', identity, samples: [{ atMs: 10, durationMs: 16 }, { atMs: 26, durationMs: 17 }] })).toMatchObject({ ok: true, value: { sampleCount: 2, durationMs: 33 } });
});

test('rejects evidence assembled from a different carrier identity', () => {
  expect(assertSameCarrierDiagnostics({ expected: identity, query: identity, capture: { ...identity, rendererGeneration: 4 }, logs: identity, frames: identity })).toMatchObject({ ok: false, error: { code: 'identity-mismatch', observed: { source: 'capture' } } });
});
