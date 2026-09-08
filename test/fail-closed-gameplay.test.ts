import { expect, test } from 'bun:test';
import {
  createCarrierGameplayAdapter,
  type CarrierRuntimeSnapshot,
} from '../src/game/carrier-gameplay-adapter';
import { parseGameplayOperationRequest } from '../src/game/gameplay-operation-contract';

const runtime: CarrierRuntimeSnapshot = {
  runtimeId: 'runtime-1',
  lifecycle: 'running',
  liveness: 'alive',
  renderReadiness: 'ready',
  confirmedScope: { projectId: 'project-a', gameId: 'gta-route-dev' },
  pageIdentity: 'http://127.0.0.1:18920/',
  canvasIdentity: 'canvas-1',
  rendererIdentity: 'renderer-1',
  rendererGeneration: 4,
  lastFailure: null,
};

const identity = {
  carrierId: 'runtime:runtime-1',
  runtimeId: 'runtime-1',
  scope: { projectId: 'project-a', gameId: 'gta-route-dev' },
  pageIdentity: 'http://127.0.0.1:18920/',
  canvasIdentity: 'canvas-1',
  rendererIdentity: 'renderer-1',
  rendererGeneration: 4,
};

function createAdapter(dispatch: (request: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  return createCarrierGameplayAdapter({
    projectId: 'project-a',
    listGames: () => ['gta-route-dev'],
    readRuntime: () => runtime,
    dispatch,
  });
}

test('rejects private fields instead of accepting a shadow gameplay authority', () => {
  expect(parseGameplayOperationRequest({
    version: 1,
    requestId: 'private-1',
    operation: 'play',
    scope: { projectId: 'project-a', gameId: 'gta-route-dev' },
    cwd: '/private/game',
  })).toMatchObject({ ok: false, error: { code: 'unknown-field', category: 'contract' } });
});

test('converts a thrown carrier transport failure into a structured fail-closed result', async () => {
  const adapter = createAdapter(async () => { throw new Error('socket closed'); });
  await adapter.select('gta-route-dev');

  await expect(adapter.operate({
    version: 1,
    requestId: 'transport-1',
    operation: 'play',
    scope: { projectId: 'project-a', gameId: 'gta-route-dev' },
    identity,
  })).resolves.toMatchObject({ ok: false, error: { code: 'carrier-dispatch-failed', category: 'transport', retryable: true } });
});

test('rejects duplicate in-flight mutations without dispatching a second write', async () => {
  const requests: Record<string, unknown>[] = [];
  let release!: (result: Record<string, unknown>) => void;
  const pending = new Promise<Record<string, unknown>>((resolve) => { release = resolve; });
  const adapter = createAdapter(async (request) => {
    requests.push(request);
    return pending;
  });
  await adapter.select('gta-route-dev');
  const request = {
    version: 1 as const,
    requestId: 'duplicate-1',
    operation: 'input' as const,
    scope: { projectId: 'project-a', gameId: 'gta-route-dev' },
    identity,
    action: { type: 'key', key: 'ArrowRight', phase: 'down' },
  };

  const first = adapter.operate(request);
  await Bun.sleep(0);
  await expect(adapter.operate(request)).resolves.toMatchObject({ ok: false, error: { code: 'duplicate-in-flight-mutation' } });
  expect(requests).toHaveLength(1);
  release({ ok: true, identity });
  await expect(first).resolves.toMatchObject({ ok: true, operation: 'input' });
});

test('does not dispatch stale renderer generations', async () => {
  const requests: Record<string, unknown>[] = [];
  const adapter = createAdapter(async (request) => {
    requests.push(request);
    return { ok: true, identity };
  });
  await adapter.select('gta-route-dev');

  await expect(adapter.operate({
    version: 1,
    requestId: 'stale-1',
    operation: 'query',
    scope: { projectId: 'project-a', gameId: 'gta-route-dev' },
    identity: { ...identity, rendererGeneration: 3 },
    query: 'gameplay.state',
  })).resolves.toMatchObject({ ok: false, error: { code: 'stale-or-mismatched-identity', category: 'provenance' } });
  expect(requests).toHaveLength(0);
});
