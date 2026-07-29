import { describe, expect, test } from 'bun:test';
import { CarrierGameplayAdapter } from '../src/game/carrier-gameplay-adapter';
import { createGameplayCapture } from '../src/game/gameplay-capture';

const evidence = { merged: { sha: 'abc', ci: 'green' }, identity: true, readiness: true, heartbeat: true, reload: true, shutdown: true, studio: { server: '18900' as const, ui: '18920' as const, smoke: true } };
const snapshot = { ok: true as const, action: 'ensure' as const, runtimeId: 'runtime-1', lifecycle: 'running' as const, liveness: 'alive' as const, renderReadiness: 'ready' as const, confirmedScope: { projectId: 'project', gameId: 'game' }, lastFailure: null, pageIdentity: 'page-1', canvasIdentity: 'canvas-1', rendererIdentity: 'renderer-1', heartbeat: { sentinel: 7, at: '2026-07-28T00:00:00.000Z' } };
const identity = { runtimeId: 'runtime-1', scope: { projectId: 'project', gameId: 'game' }, pageIdentity: 'page-1', canvasIdentity: 'canvas-1', rendererGeneration: 7 };

describe('gameplay capture provenance', () => {
  test('artifact is readable and stale provenance is rejected before producer or focus', async () => {
    let producerCalls = 0;
    let focusCalls = 0;
    const capture = createGameplayCapture({ produce: async () => { producerCalls += 1; return { dataUrl: 'data:image/png;base64,live', bytes: 26 }; }, focus: async () => { focusCalls += 1; } });
    const adapter = new CarrierGameplayAdapter({ dependencyEvidence: () => evidence, supervisor: { ensure: async () => snapshot, status: async () => snapshot } as never, gateway: { execute: async (operation) => operation.operation === 'capture' ? capture.produce(identity) : undefined } });
    const result = await adapter.execute({ operation: 'capture', scope: { projectId: 'project', gameId: 'game' } });
    expect(result).toMatchObject({ ok: true, data: { dataUrl: 'data:image/png;base64,live', provenance: { runtimeId: 'runtime-1', canvasIdentity: 'canvas-1', rendererGeneration: 7 } } });
    expect(producerCalls).toBe(1);
    const stale = await capture.reveal({ dataUrl: 'data:image/png;base64,old', bytes: 25, provenance: { ...identity, pageIdentity: 'old-page', canvasIdentity: 'old-canvas', rendererGeneration: 6 } }, identity);
    expect(stale).toMatchObject({ ok: false, error: { code: 'identity-mismatch' } });
    expect(focusCalls).toBe(0);
  });
});
