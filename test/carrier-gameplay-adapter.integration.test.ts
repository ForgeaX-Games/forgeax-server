import { describe, expect, test } from 'bun:test';
import { CarrierGameplayAdapter } from '../src/game/carrier-gameplay-adapter';

const evidence = {
  merged: { sha: 'abc', ci: 'green' }, identity: true, readiness: true,
  heartbeat: true, reload: true, shutdown: true,
  studio: { server: '18900' as const, ui: '18920' as const, smoke: true },
};
const ready = {
  ok: true as const, action: 'ensure' as const, runtimeId: 'runtime-1', lifecycle: 'running' as const,
  liveness: 'alive' as const, renderReadiness: 'ready' as const,
  confirmedScope: { projectId: 'project', gameId: 'game' }, lastFailure: null,
  pageIdentity: 'page-1', canvasIdentity: 'canvas-1', rendererIdentity: 'renderer-1',
};

describe('CarrierGameplayAdapter ready gate', () => {
  test('does not dispatch while pending or when identity changes before dispatch', async () => {
    let dispatches = 0;
    let snapshot: any = { ...ready, renderReadiness: 'pending' };
    const adapter = new CarrierGameplayAdapter({
      dependencyEvidence: () => evidence,
      supervisor: { ensure: async () => snapshot, status: async () => ({ ...ready, pageIdentity: 'page-2' }) } as never,
      gateway: { execute: async () => { dispatches += 1; return { ok: true }; } },
    });
    await expect(adapter.execute({ operation: 'play', scope: { projectId: 'project', gameId: 'game' } })).resolves.toMatchObject({ ok: false });
    expect(dispatches).toBe(0);
    snapshot = { ...ready };
    const result = await adapter.execute({ operation: 'play', scope: { projectId: 'project', gameId: 'game' } });
    expect(result.ok).toBe(false);
    expect(dispatches).toBe(0);
  });

  test('dispatches once for a confirmed ready identity', async () => {
    let dispatches = 0;
    const adapter = new CarrierGameplayAdapter({
      dependencyEvidence: () => evidence,
      supervisor: { ensure: async () => ready, status: async () => ready } as never,
      gateway: { execute: async () => { dispatches += 1; return { ok: true, state: 'running' }; } },
    });
    await expect(adapter.execute({ operation: 'play', scope: { projectId: 'project', gameId: 'game' } })).resolves.toMatchObject({ ok: true });
    expect(dispatches).toBe(1);
  });

  test('returns health-stale without dispatching when the carrier heartbeat is stale', async () => {
    let dispatches = 0;
    const stale = {
      ...ready,
      liveness: 'unreachable' as const,
      renderReadiness: 'unavailable' as const,
      lastFailure: { code: 'HEALTH_STALE', stage: 'heartbeat', retryable: true, hint: 'status', at: new Date().toISOString(), message: 'stale' },
    };
    const adapter = new CarrierGameplayAdapter({
      dependencyEvidence: () => evidence,
      supervisor: { ensure: async () => stale, status: async () => stale } as never,
      gateway: { execute: async () => { dispatches += 1; return { ok: true }; } },
    });
    await expect(adapter.execute({ operation: 'play', scope: { projectId: 'project', gameId: 'game' } })).resolves.toMatchObject({
      ok: false, error: { code: 'health-stale', readiness: 'stale' },
    });
    expect(dispatches).toBe(0);
  });

  test('keeps ordinary unavailable carriers on surface-unavailable', async () => {
    const unavailable = { ...ready, liveness: 'terminated' as const, renderReadiness: 'unavailable' as const, lastFailure: null };
    const adapter = new CarrierGameplayAdapter({
      dependencyEvidence: () => evidence,
      supervisor: { ensure: async () => unavailable, status: async () => unavailable } as never,
      gateway: { execute: async () => ({ ok: true }) },
    });
    await expect(adapter.execute({ operation: 'play', scope: { projectId: 'project', gameId: 'game' } })).resolves.toMatchObject({
      ok: false, error: { code: 'surface-unavailable', readiness: 'unavailable' },
    });
  });

  test('reveals a matching capture without dispatching an unsupported producer operation', async () => {
    let dispatches = 0;
    let focuses = 0;
    const provenance = {
      runtimeId: 'runtime-1',
      scope: { projectId: 'project', gameId: 'game' },
      pageIdentity: 'page-1',
      canvasIdentity: 'canvas-1',
      rendererGeneration: 1,
    };
    const adapter = new CarrierGameplayAdapter({
      dependencyEvidence: () => evidence,
      supervisor: { ensure: async () => ({ ...ready, rendererIdentity: 'renderer-1-generation-1' }), status: async () => ({ ...ready, rendererIdentity: 'renderer-1-generation-1' }) } as never,
      gateway: {
        execute: async () => { dispatches += 1; return { ok: false, error: { code: 'operation-unsupported' } }; },
        focus: async () => { focuses += 1; },
      },
    });
    await expect(adapter.execute({ operation: 'reveal', scope: provenance.scope, artifact: { dataUrl: 'data:image/png;base64,AA==', bytes: 30, provenance } })).resolves.toMatchObject({ ok: true, operation: 'reveal' });
    expect(dispatches).toBe(0);
    expect(focuses).toBe(1);
  });

  test('returns a structured failure for a malformed reveal artifact', async () => {
    const adapter = new CarrierGameplayAdapter({
      dependencyEvidence: () => evidence,
      supervisor: { ensure: async () => ready, status: async () => ready } as never,
      gateway: { execute: async () => ({ ok: true }) },
    });
    await expect(adapter.execute({ operation: 'reveal', scope: ready.confirmedScope, artifact: null })).resolves.toMatchObject({
      ok: false,
      error: { code: 'operation-failed', phase: 'reveal', hint: { action: 'capture-again' } },
    });
  });
});
