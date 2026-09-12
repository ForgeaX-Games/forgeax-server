import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { getEventBus, _resetEventBusForTests } from '@forgeax/orchestrator/events/bus';
import { initPathManager, resetPathManager } from '@forgeax/orchestrator/fs/path-manager';
import { ACTIVE_GAME_CHANGED_TOPIC, setActiveGame } from '../src/game/active-game';
import { createProductApiRouter } from '../src/game/product-api';
import { ProjectDependencyError } from '../src/game/project-dependencies';
import type { RuntimeScopeClient, RuntimeScopeState } from '../src/game/runtime-scope-client';

let root: string;
let previousProjectRoot: string | undefined;
let app: Hono;
let ensured: string[];
let prepared: string[];

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), 'forgeax-active-game-'));
  previousProjectRoot = process.env.FORGEAX_PROJECT_ROOT;
  process.env.FORGEAX_PROJECT_ROOT = root;
  for (const slug of ['game-a', 'game-b']) mkdirSync(resolve(root, '.forgeax/games', slug), { recursive: true });
  resetPathManager();
  initPathManager({ projectRoot: root });
  _resetEventBusForTests();
  ensured = [];
  prepared = [];
  app = new Hono();
  app.route('/api', createProductApiRouter({
    ensureGameProjectDependencies: async (gameDir) => {
      prepared.push(gameDir);
    },
    ensureSessionForGame: async (slug) => {
      ensured.push(slug);
      return { sid: `session-${slug}`, created: true };
    },
  }));
});

afterEach(() => {
  _resetEventBusForTests();
  resetPathManager();
  if (previousProjectRoot === undefined) delete process.env.FORGEAX_PROJECT_ROOT;
  else process.env.FORGEAX_PROJECT_ROOT = previousProjectRoot;
  rmSync(root, { recursive: true, force: true });
});

describe('active game resource', () => {
  test('PUT is the only explicit selection route and emits the derived state', async () => {
    setActiveGame(root, 'game-a');
    _resetEventBusForTests();
    const events: unknown[] = [];
    const unsubscribe = getEventBus().subscribe(ACTIVE_GAME_CHANGED_TOPIC, (event) => events.push(event.payload));
    const response = await app.request('/api/projects/active', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'game-b' }),
    });
    unsubscribe();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      activeSlug: 'game-b',
      session: { sid: 'session-game-b', created: true },
    });
    expect(ensured).toEqual(['game-b']);
    expect(events).toEqual([{ activeSlug: 'game-b' }]);
    expect(prepared).toEqual([resolve(root, '.forgeax/games/game-b')]);
    expect(await (await app.request('/api/projects/active')).json()).toEqual({ activeSlug: 'game-b' });
    expect((await app.request('/api/projects/game-a/activate', { method: 'POST' })).status).toBe(404);
  });

  test('repeating the same selection is idempotent', async () => {
    const request = () => app.request('/api/projects/active', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'game-a' }),
    });
    expect((await request()).status).toBe(200);
    _resetEventBusForTests();
    expect((await request()).status).toBe(200);
    expect(getEventBus().recent(ACTIVE_GAME_CHANGED_TOPIC, 10)).toEqual([]);
  });

  test('returns an actionable dependency error before publishing a selection', async () => {
    setActiveGame(root, 'game-a');
    const guardedApp = new Hono();
    guardedApp.route('/api', createProductApiRouter({
      ensureGameProjectDependencies: async () => {
        throw new ProjectDependencyError(
          'project-dependency-conflict',
          'Engine scope is occupied by a user directory',
          409,
          { path: resolve(root, '.forgeax/games/game-b/node_modules/@forgeax') },
        );
      },
      ensureSessionForGame: async () => {
        throw new Error('session must not be created after dependency preparation fails');
      },
    }));

    const response = await guardedApp.request('/api/projects/active', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'game-b' }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'failed to prepare game dependencies: Engine scope is occupied by a user directory',
      code: 'project-dependency-conflict',
      path: resolve(root, '.forgeax/games/game-b/node_modules/@forgeax'),
    });
    await expect((await app.request('/api/projects/active')).json()).resolves.toEqual({ activeSlug: 'game-a' });
  });

  test('GET restore reports dependency preparation failure instead of a usable selection', async () => {
    setActiveGame(root, 'game-a');
    const guardedApp = new Hono();
    guardedApp.route('/api', createProductApiRouter({
      ensureGameProjectDependencies: async (gameDir) => {
        expect(gameDir).toBe(resolve(root, '.forgeax/games/game-a'));
        throw new ProjectDependencyError('project-dependency-source-unavailable', 'Engine source missing', 503);
      },
    }));
    const response = await guardedApp.request('/api/projects/active');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'failed to prepare game dependencies: Engine source missing', code: 'project-dependency-source-unavailable' });
  });

  test('GET restore awaits preparation without creating a session or binding the sidecar', async () => {
    setActiveGame(root, 'game-a');
    let release!: () => void;
    const preparation = new Promise<void>((done) => { release = done; });
    let started!: () => void;
    const entered = new Promise<void>((done) => { started = done; });
    const guardedApp = new Hono();
    guardedApp.route('/api', createProductApiRouter({
      ensureGameProjectDependencies: async () => { started(); await preparation; },
      ensureSessionForGame: async () => { throw new Error('GET must not create sessions'); },
    }));
    let settled = false;
    const response = Promise.resolve(guardedApp.request('/api/projects/active')).then((value) => { settled = true; return value; });
    await entered;
    expect(settled).toBe(false);
    release();
    expect((await response).status).toBe(200);
  });

  test('GET does not publish an old selection after a concurrent switch', async () => {
    setActiveGame(root, 'game-a');
    const guardedApp = new Hono();
    guardedApp.route('/api', createProductApiRouter({
      ensureGameProjectDependencies: async () => { setActiveGame(root, 'game-b'); },
    }));
    const response = await guardedApp.request('/api/projects/active');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'active project changed during preparation; retry', code: 'active-project-changed' });
  });

  test('publishes the sidecar-confirmed binding atomically with the active game', async () => {
    const state: RuntimeScopeState = {
      status: 'ready',
      binding: {
        schemaVersion: 'runtime-asset-binding-v1',
        gameId: 'game-b',
        scopeId: 'studio-game-b',
        generation: 12,
        status: 'ready',
        catalogUrl: '/preview/__pack/scopes/studio-game-b/12/catalog.json',
        importUrlBase: '/preview/__pack/scopes/studio-game-b/12/import',
        packageUrlBase: '/preview/__pack/scopes/studio-game-b/12/asset',
      },
    };
    const binds: Array<{ gameId: string; gameDir: string }> = [];
    const runtimeScope = {
      snapshot: () => state,
      bind: async (gameId: string, gameDir: string) => {
        binds.push({ gameId, gameDir });
        return state;
      },
    } as unknown as RuntimeScopeClient;
    const runtimeApp = new Hono();
    runtimeApp.route('/api', createProductApiRouter({
      runtimeScope,
      ensureSessionForGame: async () => ({ sid: 'runtime-session', created: true }),
    }));

    const response = await runtimeApp.request('/api/projects/active', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'game-b' }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as {
      runtime: { binding: { generation: number } };
    };
    expect(body.runtime.binding.generation).toBe(12);
    expect(binds).toEqual([{ gameId: 'game-b', gameDir: resolve(root, '.forgeax/games/game-b') }]);
  });

  test('keeps the previous authority when the candidate runtime cannot commit', async () => {
    setActiveGame(root, 'game-a');
    _resetEventBusForTests();
    const events: unknown[] = [];
    const unsubscribe = getEventBus().subscribe(ACTIVE_GAME_CHANGED_TOPIC, (event) => events.push(event.payload));
    const runtimeScope = {
      snapshot: () => ({ status: 'unavailable' as const }),
      bind: async () => ({
        status: 'unavailable' as const,
        error: 'runtime scope bind failed: runtime-binding-mismatch',
      }),
    } as unknown as RuntimeScopeClient;
    const runtimeApp = new Hono();
    runtimeApp.route('/api', createProductApiRouter({
      runtimeScope,
      ensureSessionForGame: async () => ({ sid: 'runtime-session', created: true }),
    }));

    const response = await runtimeApp.request('/api/projects/active', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'game-b' }),
    });
    unsubscribe();

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: 'runtime-binding-mismatch',
      retryable: false,
      requestedSlug: 'game-b',
      activeSlug: 'game-a',
    });
    expect(events).toEqual([]);
    expect(await (await runtimeApp.request('/api/projects/active')).json()).toMatchObject({
      activeSlug: 'game-a',
    });
  });

  test('prevents an older slow request from binding after a newer selection', async () => {
    let releaseOlder!: () => void;
    const olderBlocked = new Promise<void>((resolve) => { releaseOlder = resolve; });
    let markOlderStarted!: () => void;
    const olderStarted = new Promise<void>((resolve) => { markOlderStarted = resolve; });
    const binds: string[] = [];
    const runtimeScope = {
      snapshot: () => ({ status: 'unbound' as const }),
      bind: async (gameId: string) => {
        binds.push(gameId);
        return {
          status: 'ready' as const,
          binding: {
            schemaVersion: 'runtime-asset-binding-v1' as const,
            gameId,
            scopeId: `studio-${gameId}`,
            generation: binds.length,
            status: 'ready' as const,
            catalogUrl: `/preview/${gameId}/catalog.json`,
            importUrlBase: `/preview/${gameId}/import`,
            packageUrlBase: `/preview/${gameId}/asset`,
          },
        };
      },
    } as unknown as RuntimeScopeClient;
    const runtimeApp = new Hono();
    runtimeApp.route('/api', createProductApiRouter({
      runtimeScope,
      ensureSessionForGame: async (slug) => {
        if (slug === 'game-a') {
          markOlderStarted();
          await olderBlocked;
        }
        return { sid: `session-${slug}`, created: true };
      },
    }));
    const put = (slug: string) => runtimeApp.request('/api/projects/active', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug }),
    });

    const older = put('game-a');
    await olderStarted;
    const newer = await put('game-b');
    releaseOlder();
    const olderResponse = await older;

    expect(newer.status).toBe(200);
    expect(olderResponse.status).toBe(409);
    expect(await olderResponse.json()).toMatchObject({
      code: 'active-game-switch-superseded',
      activeSlug: 'game-b',
    });
    expect(binds).toEqual(['game-b']);
    expect(await (await runtimeApp.request('/api/projects/active')).json()).toMatchObject({
      activeSlug: 'game-b',
    });
  });

  test('keeps authority aligned when an in-flight older bind succeeds and the newer bind fails', async () => {
    mkdirSync(resolve(root, '.forgeax/games/game-c'), { recursive: true });
    setActiveGame(root, 'game-c');
    let releaseOlder!: () => void;
    const olderBlocked = new Promise<void>((resolve) => { releaseOlder = resolve; });
    let markOlderBinding!: () => void;
    const olderBinding = new Promise<void>((resolve) => { markOlderBinding = resolve; });
    let markOlderCommitted!: () => void;
    const olderCommitted = new Promise<void>((resolve) => { markOlderCommitted = resolve; });
    let markNewerBinding!: () => void;
    const newerBinding = new Promise<void>((resolve) => { markNewerBinding = resolve; });
    const bindingFor = (gameId: string) => ({
      schemaVersion: 'runtime-asset-binding-v1' as const,
      gameId,
      scopeId: `studio-${gameId}`,
      generation: gameId === 'game-a' ? 1 : 2,
      status: 'ready' as const,
      catalogUrl: `/preview/${gameId}/catalog.json`,
      importUrlBase: `/preview/${gameId}/import`,
      packageUrlBase: `/preview/${gameId}/asset`,
    });
    const runtimeScope = {
      snapshot: () => ({ status: 'unbound' as const }),
      bind: async (gameId: string) => {
        if (gameId === 'game-a') {
          markOlderBinding();
          await olderBlocked;
          markOlderCommitted();
          return { status: 'ready' as const, binding: bindingFor('game-a') };
        }
        markNewerBinding();
        await olderCommitted;
        return {
          status: 'degraded' as const,
          binding: { ...bindingFor('game-a'), status: 'degraded' as const },
          error: 'runtime scope bind failed: catalog-scan-failed',
        };
      },
    } as unknown as RuntimeScopeClient;
    const runtimeApp = new Hono();
    runtimeApp.route('/api', createProductApiRouter({
      runtimeScope,
      ensureSessionForGame: async (slug) => ({ sid: `session-${slug}`, created: true }),
    }));
    const put = (slug: string) => runtimeApp.request('/api/projects/active', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug }),
    });

    const older = put('game-a');
    await olderBinding;
    const newer = put('game-b');
    await newerBinding;
    releaseOlder();
    const [olderResponse, newerResponse] = await Promise.all([older, newer]);

    expect(olderResponse.status).toBe(409);
    expect(newerResponse.status).toBe(503);
    expect(await (await runtimeApp.request('/api/projects/active')).json()).toMatchObject({
      activeSlug: 'game-a',
    });
  });

  test('GET returns the cached runtime projection without waiting for the sidecar', async () => {
    setActiveGame(root, 'game-a');
    const state: RuntimeScopeState = {
      status: 'ready',
      binding: {
        schemaVersion: 'runtime-asset-binding-v1',
        gameId: 'game-a',
        scopeId: 'stale-scope',
        generation: 7,
        status: 'ready',
        catalogUrl: '/preview/__pack/scopes/stale-scope/7/catalog.json',
        importUrlBase: '/preview/__pack/scopes/stale-scope/7/import',
        packageUrlBase: '/preview/__pack/scopes/stale-scope/7/asset',
      },
    };
    let binds = 0;
    const runtimeScope = {
      snapshot: () => state,
      bind: async () => {
        binds += 1;
        return state;
      },
    } as unknown as RuntimeScopeClient;
    const runtimeApp = new Hono();
    runtimeApp.route('/api', createProductApiRouter({ runtimeScope }));

    const response = await runtimeApp.request('/api/projects/active');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ activeSlug: 'game-a', runtime: state });
    expect(binds).toBe(0);
  });
});
