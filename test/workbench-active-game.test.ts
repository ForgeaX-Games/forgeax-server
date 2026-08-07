import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { getEventBus, _resetEventBusForTests } from '@forgeax/orchestrator/events/bus';
import { initPathManager, resetPathManager } from '@forgeax/orchestrator/fs/path-manager';
import { ACTIVE_GAME_CHANGED_TOPIC, setActiveGame } from '../src/game/active-game';
import { createWorkbenchRouter } from '../src/game/workbench';
import type { RuntimeScopeClient, RuntimeScopeState } from '../src/game/runtime-scope-client';

let root: string;
let previousProjectRoot: string | undefined;
let app: Hono;
let ensured: string[];

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), 'forgeax-active-game-'));
  previousProjectRoot = process.env.FORGEAX_PROJECT_ROOT;
  process.env.FORGEAX_PROJECT_ROOT = root;
  for (const slug of ['game-a', 'game-b']) mkdirSync(resolve(root, '.forgeax/games', slug), { recursive: true });
  resetPathManager();
  initPathManager({ projectRoot: root });
  _resetEventBusForTests();
  ensured = [];
  app = new Hono();
  app.route('/api/workbench', createWorkbenchRouter({
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
    const response = await app.request('/api/workbench/active-game', {
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
    expect(await (await app.request('/api/workbench/active-game')).json()).toEqual({ activeSlug: 'game-b' });
    expect((await app.request('/api/workbench/games/game-a/activate', { method: 'POST' })).status).toBe(404);
  });

  test('repeating the same selection is idempotent', async () => {
    const request = () => app.request('/api/workbench/active-game', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'game-a' }),
    });
    expect((await request()).status).toBe(200);
    _resetEventBusForTests();
    expect((await request()).status).toBe(200);
    expect(getEventBus().recent(ACTIVE_GAME_CHANGED_TOPIC, 10)).toEqual([]);
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
    runtimeApp.route('/api/workbench', createWorkbenchRouter({
      runtimeScope,
      ensureSessionForGame: async () => ({ sid: 'runtime-session', created: true }),
    }));

    const response = await runtimeApp.request('/api/workbench/active-game', {
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
});
