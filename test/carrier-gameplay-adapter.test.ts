import { expect, test } from 'bun:test';
import {
  createCarrierGameplayAdapter,
  type CarrierRuntimeSnapshot,
} from '../src/game/carrier-gameplay-adapter';

const readyRuntime: CarrierRuntimeSnapshot = {
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

function adapter(games: readonly string[] = ['gta-route-dev', 'other-game'], runtime: CarrierRuntimeSnapshot | null = readyRuntime) {
  const requests: unknown[] = [];
  const value = createCarrierGameplayAdapter({
    projectId: 'project-a',
    listGames: () => games,
    readRuntime: () => runtime,
    dispatch: async (request) => {
      requests.push(request);
      return {
        ok: true,
        identity: {
          carrierId: 'runtime:runtime-1',
          runtimeId: 'runtime-1',
          scope: { projectId: 'project-a', gameId: 'gta-route-dev' },
          pageIdentity: 'http://127.0.0.1:18920/',
          canvasIdentity: 'canvas-1',
          rendererIdentity: 'renderer-1',
          rendererGeneration: 4,
        },
      };
    },
  });
  return { value, requests };
}

test('discovery exposes candidates before explicit selection', async () => {
  const { value } = adapter();
  await expect(value.discover()).resolves.toMatchObject({
    version: 'server-game-carrier/v1',
    selectedGame: null,
    candidates: [{ gameId: 'gta-route-dev' }, { gameId: 'other-game' }],
    directEngine: false,
  });
});

test('selection binds gameplay dispatch to exactly one requested game', async () => {
  const { value, requests } = adapter();
  await expect(value.select('gta-route-dev')).resolves.toMatchObject({
    ok: true,
    selectedGame: 'gta-route-dev',
    scope: { projectId: 'project-a', gameId: 'gta-route-dev' },
  });
  await expect(value.dispatch({ method: 'gameplay', params: { operation: 'describe' } })).resolves.toMatchObject({ ok: true });
  expect(requests).toEqual([expect.objectContaining({
    method: 'gameplay',
    scope: 'game:gta-route-dev',
  })]);
});

test('absent and ambiguous selection fail without changing the selected game', async () => {
  const missing = adapter(['other-game']);
  await expect(missing.value.select('gta-route-dev')).resolves.toMatchObject({ ok: false, error: { code: 'game-not-found' } });
  await expect(missing.value.discover()).resolves.toMatchObject({ selectedGame: null });

  const duplicate = adapter(['gta-route-dev', 'gta-route-dev']);
  await expect(duplicate.value.select('gta-route-dev')).resolves.toMatchObject({ ok: false, error: { code: 'game-selection-ambiguous' } });
  await expect(duplicate.value.discover()).resolves.toMatchObject({ selectedGame: null });
});

test('unselected and wrong-game requests fail closed without dispatch', async () => {
  const { value, requests } = adapter();
  await expect(value.dispatch({ method: 'gameplay', gameId: 'gta-route-dev', params: {} })).resolves.toMatchObject({
    ok: false,
    error: { code: 'game-selection-required' },
  });
  await value.select('gta-route-dev');
  await expect(value.dispatch({ method: 'gameplay', gameId: 'other-game', params: {} })).resolves.toMatchObject({
    ok: false,
    error: { code: 'game-selection-mismatch' },
  });
  expect(requests).toHaveLength(0);
});

test('identity is unavailable for stale runtime observations', async () => {
  const { value } = adapter(['gta-route-dev'], { ...readyRuntime, liveness: 'unreachable' });
  await value.select('gta-route-dev');
  await expect(value.discover()).resolves.toMatchObject({
    selectedGame: 'gta-route-dev',
    readiness: 'unavailable',
    identity: null,
  });
});

test('typed operations preserve the selected identity and reject provenance drift', async () => {
  const { value } = adapter(['gta-route-dev']);
  await value.select('gta-route-dev');
  const identity = (await value.discover()).identity!;
  const gameplayIdentity = {
    ...identity,
    scope: { projectId: identity.scope.projectId, gameId: identity.scope.gameId! },
  };
  await expect(value.operate({ version: 1, requestId: 'input-1', operation: 'input', scope: { projectId: 'project-a', gameId: 'gta-route-dev' }, identity: gameplayIdentity, action: { type: 'key', key: 'ArrowRight', phase: 'down' } })).resolves.toMatchObject({ ok: true, operation: 'input', identity: gameplayIdentity });
  await expect(value.operate({ version: 1, requestId: 'input-2', operation: 'input', scope: { projectId: 'project-a', gameId: 'gta-route-dev' }, identity: { ...gameplayIdentity, rendererGeneration: 99 }, action: { type: 'key', key: 'ArrowRight', phase: 'down' } })).resolves.toMatchObject({ ok: false, error: { code: 'stale-or-mismatched-identity', category: 'provenance' } });
});

test('typed gameplay Stop is dispatched as its own operation', async () => {
  const { value, requests } = adapter(['gta-route-dev']);
  await value.select('gta-route-dev');
  const identity = (await value.discover()).identity!;
  await expect(value.operate({ version: 1, requestId: 'stop-1', operation: 'gameplayStop', scope: { projectId: 'project-a', gameId: 'gta-route-dev' }, identity: { ...identity, scope: { projectId: 'project-a', gameId: 'gta-route-dev' } } })).resolves.toMatchObject({ ok: true, operation: 'gameplayStop' });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ method: 'gameplay', params: { operation: 'gameplayStop' } });
});
