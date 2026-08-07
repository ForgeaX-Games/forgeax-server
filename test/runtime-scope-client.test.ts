import { describe, expect, test } from 'bun:test';
import { RuntimeScopeClient } from '../src/game/runtime-scope-client';

function binding(gameId: string, scopeId: string, generation: number): Record<string, unknown> {
  return {
    schemaVersion: 'runtime-asset-binding-v1',
    gameId,
    scopeId,
    generation,
    status: 'ready',
    catalogUrl: `/preview/__pack/scopes/studio-${gameId}/${generation}/catalog.json`,
    importUrlBase: `/preview/__pack/scopes/studio-${gameId}/${generation}/import`,
    packageUrlBase: `/preview/__pack/scopes/studio-${gameId}/${generation}/asset`,
    authority: 'authoritative',
  };
}

describe('RuntimeScopeClient', () => {
  test('serializes exact-game binds and validates the sidecar generation', async () => {
    const requests: Array<{ body: Record<string, unknown>; secret: string | null }> = [];
    const client = new RuntimeScopeClient({
      enginePort: 15173,
      secret: 'secret',
      retries: 0,
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push({
          body,
          secret: new Headers(init?.headers).get('x-forgeax-runtime-secret'),
        });
        return Response.json(binding(String(body.gameId), String(body.scopeId), Number(body.generation)));
      }) as unknown as typeof fetch,
    });

    const first = await client.bind('game-a', '/project/.forgeax/games/game-a');
    const second = await client.bind('game-b', '/project/.forgeax/games/game-b');

    expect(first.status).toBe('ready');
    expect(second.binding?.gameId).toBe('game-b');
    expect(typeof second.binding?.generation).toBe('number');
    expect(requests).toHaveLength(2);
    expect(requests[0]?.body.gameId).toBe('game-a');
    expect(typeof requests[0]?.body.generation).toBe('number');
    expect(requests[0]?.body.gameDir).toBe('/project/.forgeax/games/game-a');
    expect(requests[0]?.secret).toBe('secret');
    expect(String(requests[0]?.body.scopeId)).toMatch(/^studio-[a-f0-9]{32}$/);
    expect(requests[1]?.body.gameId).toBe('game-b');
    expect(typeof requests[1]?.body.generation).toBe('number');
    expect(requests[1]?.body.gameDir).toBe('/project/.forgeax/games/game-b');
    expect(requests[1]?.secret).toBe('secret');
    expect(second.binding?.generation).toBeGreaterThan(first.binding?.generation ?? 0);
  });

  test('clears the previous binding when the sidecar cannot bind', async () => {
    const client = new RuntimeScopeClient({
      secret: 'secret',
      retries: 0,
      fetchImpl: (async () => new Response('unavailable', { status: 503 })) as unknown as typeof fetch,
    });
    const state = await client.bind('game-a', '/project/.forgeax/games/game-a');
    expect(state).toMatchObject({ status: 'unavailable' });
    expect(state.binding).toBeUndefined();
    expect(client.snapshot()).toEqual(state);
  });
});
