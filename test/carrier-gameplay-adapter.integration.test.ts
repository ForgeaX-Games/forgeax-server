import { describe, expect, test } from 'bun:test';
import { CarrierGameplayAdapter } from '../src/game/carrier-gameplay-adapter';

const scope = { projectId: 'project', gameId: 'game' };
const identity = {
  runtimeId: 'runtime-1',
  scope,
  pageIdentity: 'page-1',
  canvasIdentity: 'canvas-1',
  rendererGeneration: 1,
};
const ready = {
  ok: true as const, action: 'ensure' as const, runtimeId: 'runtime-1', lifecycle: 'running' as const,
  liveness: 'alive' as const, renderReadiness: 'ready' as const,
  confirmedScope: scope, lastFailure: null,
  pageIdentity: 'page-1', canvasIdentity: 'canvas-1', rendererIdentity: 'renderer-1', rendererGeneration: 1,
};

function createAdapter(status: unknown, execute: (request: unknown) => Promise<unknown>) {
  return new CarrierGameplayAdapter({
    supervisor: { ensure: async () => ready, status: async () => status } as never,
    gateway: { execute },
  });
}

describe('CarrierGameplayAdapter ready gate', () => {
  test('waits for a cold carrier before dispatching once', async () => {
    let dispatches = 0;
    let statusCalls = 0;
    const adapter = new CarrierGameplayAdapter({
      supervisor: {
        ensure: async () => ({ ...ready, lifecycle: 'starting' as const, renderReadiness: 'pending' as const }),
        status: async () => statusCalls++ === 0 ? { ...ready, lifecycle: 'starting' as const, renderReadiness: 'pending' as const } : ready,
      } as never,
      gateway: { execute: async () => { dispatches += 1; return { ok: true, operation: 'play', state: 'running', identity }; } },
    });
    await expect(adapter.execute({ operation: 'play', scope })).resolves.toMatchObject({ ok: true, state: 'running' });
    expect(dispatches).toBe(1);
  });

  test('does not dispatch when identity changes before dispatch', async () => {
    let dispatches = 0;
    let statusCalls = 0;
    const changed = { ...ready, pageIdentity: 'page-2' };
    const adapter = new CarrierGameplayAdapter({
      supervisor: { ensure: async () => ready, status: async () => { statusCalls += 1; return changed; } } as never,
      gateway: { execute: async () => { dispatches += 1; return { ok: true, operation: 'play', state: 'running', identity }; } },
    });
    await expect(adapter.execute({ operation: 'play', scope })).resolves.toMatchObject({
      ok: false, error: { code: 'identity-mismatch', details: { mismatches: [{ field: 'pageIdentity' }] } },
    });
    expect(dispatches).toBe(0);
  });

  test('returns health-stale without dispatching', async () => {
    let dispatches = 0;
    const stale = {
      ...ready,
      liveness: 'unreachable' as const,
      renderReadiness: 'unavailable' as const,
      lastFailure: { code: 'HEALTH_STALE', retryable: true, message: 'stale' },
    };
    const adapter = createAdapter(stale, async () => { dispatches += 1; return { ok: true, operation: 'play', state: 'running', identity }; });
    await expect(adapter.execute({ operation: 'play', scope })).resolves.toMatchObject({ ok: false, error: { code: 'HEALTH_STALE' } });
    expect(dispatches).toBe(0);
  });

  test('keeps ordinary unavailable carriers on a structured carrier error', async () => {
    const unavailable = { ...ready, liveness: 'terminated' as const, renderReadiness: 'unavailable' as const, lastFailure: null };
    const adapter = createAdapter(unavailable, async () => ({ ok: true, operation: 'play', state: 'running', identity }));
    await expect(adapter.execute({ operation: 'play', scope })).resolves.toMatchObject({ ok: false, error: { owner: 'carrier', code: 'surface-unavailable' } });
  });

  test('reveals a matching capture through the producer', async () => {
    let dispatches = 0;
    const artifact = { dataUrl: 'data:image/png;base64,AA==', bytes: 30, provenance: identity };
    const adapter = createAdapter(ready, async () => {
      dispatches += 1;
      return { ok: true, operation: 'reveal', state: 'running', identity, data: artifact };
    });
    await expect(adapter.execute({ operation: 'reveal', scope, artifact })).resolves.toMatchObject({ ok: true, operation: 'reveal' });
    expect(dispatches).toBe(1);
  });
});
