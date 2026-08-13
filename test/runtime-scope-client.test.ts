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

function responseForBinding(gameId: string, scopeId: string, generation: number): Response {
  return Response.json(binding(gameId, scopeId, generation));
}

describe('RuntimeScopeClient', () => {
  test('serializes exact-game binds and validates the sidecar generation', async () => {
    const requests: Array<{ body: Record<string, unknown>; secret: string | null }> = [];
    const client = new RuntimeScopeClient({
      enginePort: 15173,
      secret: 'secret',
      retries: 0,
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'GET') {
          const command = requests.at(-1)?.body;
          return responseForBinding(
            String(command?.gameId ?? 'unknown'),
            String(command?.scopeId ?? 'unknown'),
            Number(command?.generation ?? 1),
          );
        }
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

  test('repairs a cached ready state after the sidecar becomes unbound', async () => {
    let sidecar: unknown;
    const methods: string[] = [];
    const client = new RuntimeScopeClient({
      enginePort: 15173,
      secret: 'secret',
      retries: 0,
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        methods.push(init?.method ?? 'GET');
        if (init?.method === 'GET') {
          return sidecar === undefined
            ? new Response(JSON.stringify({ error: 'runtime-scope-unbound', status: 'unbound' }), { status: 503 })
            : Response.json(sidecar);
        }
        const command = JSON.parse(String(init?.body)) as {
          gameId: string;
          scopeId: string;
          generation: number;
        };
        sidecar = binding(command.gameId, command.scopeId, command.generation);
        return Response.json(sidecar);
      }) as unknown as typeof fetch,
    });

    const first = await client.bind('game-a', '/project/.forgeax/games/game-a');
    expect(first.status).toBe('ready');
    const firstGeneration = first.binding?.generation;
    methods.length = 0;
    sidecar = undefined;

    const repaired = await client.bind('game-a', '/project/.forgeax/games/game-a');

    expect(repaired.status).toBe('ready');
    expect(repaired.binding?.gameId).toBe('game-a');
    expect(repaired.binding?.generation).toBeGreaterThan(firstGeneration ?? 0);
    expect(methods).toEqual(['GET', 'POST']);
  });

  test('does not rebind when the sidecar confirms the cached generation', async () => {
    let sidecar: unknown;
    const methods: string[] = [];
    const client = new RuntimeScopeClient({
      secret: 'secret',
      retries: 0,
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        methods.push(init?.method ?? 'GET');
        if (init?.method === 'GET') return Response.json(sidecar);
        const command = JSON.parse(String(init?.body)) as {
          gameId: string;
          scopeId: string;
          generation: number;
        };
        sidecar = binding(command.gameId, command.scopeId, command.generation);
        return Response.json(sidecar);
      }) as unknown as typeof fetch,
    });

    const first = await client.bind('game-a', '/project/.forgeax/games/game-a');
    sidecar = first.binding;
    const second = await client.bind('game-a', '/project/.forgeax/games/game-a');

    expect(second).toEqual(first);
    expect(methods).toEqual(['POST', 'GET']);
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

  test('does not replay a long bind after the transport timeout', async () => {
    let requests = 0;
    const client = new RuntimeScopeClient({
      secret: 'secret',
      timeoutMs: 1,
      retries: 8,
      fetchImpl: (async () => {
        requests += 1;
        const error = new Error('runtime scope request timed out');
        error.name = 'AbortError';
        throw error;
      }) as unknown as typeof fetch,
    });

    const state = await client.bind('game-a', '/project/.forgeax/games/game-a');

    expect(state).toMatchObject({ status: 'unavailable', error: 'runtime scope request timed out' });
    expect(requests).toBe(1);
  });
});
