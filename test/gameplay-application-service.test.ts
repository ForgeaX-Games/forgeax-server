import { describe, expect, test } from 'bun:test';
import {
  GAMEPLAY_BRIDGE_VERSION,
  GAMEPLAY_CONTRACT_VERSION,
  parseGameplayBridgeRequest,
  sameGameplayIdentity,
  type GameplayBridgeRequest,
  type GameplayOperation,
  type GameplayProvenance,
} from '../src/game/gameplay-operation-contract';
import { CarrierGameplayAdapter } from '../src/game/carrier-gameplay-adapter';
import { GAMEPLAY_OPERATION_MANIFEST } from '../src/game/gameplay-operation-manifest';

const scope = { projectId: 'project', gameId: 'game' };
const identity: GameplayProvenance = {
  runtimeId: 'runtime-1',
  scope,
  pageIdentity: 'page-1',
  canvasIdentity: 'canvas-1',
  rendererGeneration: 4,
};

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    action: 'ensure' as const,
    runtimeId: identity.runtimeId,
    lifecycle: 'running' as const,
    liveness: 'alive' as const,
    renderReadiness: 'ready' as const,
    confirmedScope: identity.scope,
    pageIdentity: identity.pageIdentity,
    canvasIdentity: identity.canvasIdentity,
    rendererGeneration: identity.rendererGeneration,
    rendererIdentity: 'renderer-1',
    lastFailure: null,
    ...overrides,
  };
}

function adapter(
  statuses: unknown[],
  execute: (request: unknown) => Promise<unknown>,
  options: { waitTimeoutMs?: number } = {},
) {
  let statusIndex = 0;
  let ensures = 0;
  const service = new CarrierGameplayAdapter({
    supervisor: {
      ensure: async () => {
        ensures += 1;
        return snapshot({ lifecycle: 'starting', renderReadiness: 'pending' });
      },
      status: async () => statuses[Math.min(statusIndex++, statuses.length - 1)],
    } as never,
    gateway: { execute },
    ...options,
  });
  return { service, getEnsures: () => ensures };
}

describe('gameplay application service falsification', () => {
  test('cold play waits for ready and never ensures a second runtime', async () => {
    let dispatches = 0;
    const { service, getEnsures } = adapter(
      [snapshot({ lifecycle: 'starting', renderReadiness: 'pending' }), snapshot()],
      async () => {
        dispatches += 1;
        return { ok: true, operation: 'play', state: 'running', identity };
      },
    );

    await expect(service.execute({ operation: 'play', scope })).resolves.toMatchObject({ ok: true, state: 'running' });
    expect(getEnsures()).toBe(1);
    expect(dispatches).toBe(1);
  });

  test('ready wait times out and is cancellable without dispatch', async () => {
    const { service } = adapter(
      [snapshot({ lifecycle: 'starting', renderReadiness: 'pending' })],
      async () => ({ ok: true, operation: 'play', state: 'running', identity }),
      { waitTimeoutMs: 5 },
    );
    await expect(service.execute({ operation: 'play', scope })).resolves.toMatchObject({
      ok: false,
      error: { code: 'readiness-timeout', phase: 'ready', retryable: true },
    });

    const controller = new AbortController();
    const pending = adapter(
      [snapshot({ lifecycle: 'starting', renderReadiness: 'pending' })],
      async () => ({ ok: true, operation: 'play', state: 'running', identity }),
      { waitTimeoutMs: 1000 },
    );
    const request = pending.service.execute({ operation: 'play', scope }, { signal: controller.signal });
    controller.abort();
    await expect(request).resolves.toMatchObject({ ok: false, error: { code: 'operation-aborted', retryable: true } });
  });

  test.each([
    ['stop', snapshot({ lifecycle: 'stopped', liveness: 'terminated', renderReadiness: 'unavailable' })],
    ['reload', snapshot({ lifecycle: 'failed', liveness: 'terminated', renderReadiness: 'unavailable', lastFailure: { code: 'PAGE_RELOADED', retryable: true } })],
  ])('%s during wait is a typed failure', async (_name, failed) => {
    const { service } = adapter([failed], async () => ({ ok: true, operation: 'play', state: 'running', identity }));
    await expect(service.execute({ operation: 'play', scope })).resolves.toMatchObject({
      ok: false,
      error: { phase: 'ready', retryable: true },
    });
  });

  test.each([
    ['runtimeId', { runtimeId: 'runtime-2' }],
    ['scope.projectId', { scope: { projectId: 'other', gameId: 'game' } }],
    ['scope.gameId', { scope: { projectId: 'project', gameId: 'other' } }],
    ['pageIdentity', { pageIdentity: 'page-2' }],
    ['canvasIdentity', { canvasIdentity: 'canvas-2' }],
    ['rendererGeneration', { rendererGeneration: 5 }],
  ])('reports the %s identity mismatch dimension', (dimension, change) => {
    const result = sameGameplayIdentity(identity, { ...identity, ...change } as GameplayProvenance);
    expect(result).toMatchObject({ matches: false, mismatches: [{ field: dimension }] });
  });

  test('rejects malformed, extra-field, and unknown-version bridge requests', () => {
    expect(() => parseGameplayBridgeRequest({ version: GAMEPLAY_BRIDGE_VERSION, operation: null })).toThrow(/operation/);
    expect(() => parseGameplayBridgeRequest({ version: GAMEPLAY_BRIDGE_VERSION, operation: { operation: 'play', scope, extra: true } })).toThrow(/extra/);
    expect(() => parseGameplayBridgeRequest({ version: 99, operation: { operation: 'play', scope } })).toThrow(/version/);
  });

  test('manifest is a projection of the versioned contract', () => {
    expect(GAMEPLAY_OPERATION_MANIFEST.version).toBe(GAMEPLAY_CONTRACT_VERSION);
    expect(GAMEPLAY_OPERATION_MANIFEST.operations).toBe(GAMEPLAY_OPERATION_MANIFEST.contract.operations);
  });

  test('the producer error envelope preserves its owner and details', async () => {
    const failed: GameplayBridgeRequest = {
      version: GAMEPLAY_BRIDGE_VERSION,
      operation: { operation: 'input', scope, action: { type: 'key', key: 'A', phase: 'down' } },
      identity,
    };
    const { service } = adapter([snapshot()], async () => ({
      ok: false,
      error: {
        owner: 'producer',
        code: 'game-projection-unavailable',
        phase: 'dispatch',
        retryable: false,
        hint: { action: 'status' },
        details: { operation: failed.operation.operation },
      },
    }));
    await expect(service.execute(failed.operation)).resolves.toMatchObject({
      ok: false,
      error: {
        owner: 'producer',
        code: 'game-projection-unavailable',
        retryable: false,
        details: { operation: 'input' },
      },
    });
  });

  test('producer throws and blank capture remain structured failures', async () => {
    const throwing = adapter([snapshot()], async () => { throw new Error('producer exploded'); });
    await expect(throwing.service.execute({ operation: 'play', scope })).resolves.toMatchObject({
      ok: false,
      error: { owner: 'transport', code: 'transport-exception', phase: 'dispatch', retryable: true },
    });

    const blank = adapter([snapshot()], async () => ({
      ok: true,
      operation: 'capture',
      state: 'running',
      identity,
      data: { dataUrl: '', bytes: 0, provenance: identity },
    }));
    await expect(blank.service.execute({ operation: 'capture', scope })).resolves.toMatchObject({
      ok: false,
      error: { owner: 'contract', code: 'invalid-capture-artifact', phase: 'capture', retryable: false },
    });
  });
});

test('server Playwright transport is a thin versioned bridge forwarder', async () => {
  const source = await Bun.file(new URL('../src/runtime-carrier/playwright-host.ts', import.meta.url)).text();
  expect(source).toContain('forgeaxGameplayBridge');
  expect(source).toContain('GAMEPLAY_BRIDGE_VERSION');
  expect(source).not.toContain('__forgeax_editor');
  expect(source).not.toContain('querySelectorAll');
  expect(source).not.toContain('dispatchGameplayInput');
  expect(source).not.toContain('toDataURL');
});

test('gameplay requests do not depend on release evidence environment state', async () => {
  const source = await Bun.file(new URL('../src/main.ts', import.meta.url)).text();
  const evidenceEnv = ['FORGEAX', 'W1L1H', 'EVIDENCE_JSON'].join('_');
  expect(source).not.toContain(evidenceEnv);
});
