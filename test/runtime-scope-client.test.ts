import { describe, expect, test } from 'bun:test';
import { DEFAULT_RUNTIME_SCOPE_TIMEOUT_MS, RuntimeScopeClient } from '../src/game/runtime-scope-client';
import type { RuntimeAssetBinding } from '../src/game/runtime-scope-client';

function timeoutOf(client: RuntimeScopeClient): number {
  return (client as unknown as { timeoutMs: number }).timeoutMs;
}

function binding(gameId: string, scopeId: string, generation: number): RuntimeAssetBinding {
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
  test('uses a cold-bind-safe default timeout and supports validated environment overrides', () => {
    const envName = 'FORGEAX_RUNTIME_SCOPE_TIMEOUT_MS';
    const previous = process.env[envName];
    try {
      delete process.env[envName];
      expect(timeoutOf(new RuntimeScopeClient())).toBe(DEFAULT_RUNTIME_SCOPE_TIMEOUT_MS);

      process.env[envName] = '1234.5';
      expect(timeoutOf(new RuntimeScopeClient())).toBe(1234.5);

      process.env[envName] = 'not-a-duration';
      expect(timeoutOf(new RuntimeScopeClient())).toBe(DEFAULT_RUNTIME_SCOPE_TIMEOUT_MS);

      process.env[envName] = '1';
      expect(timeoutOf(new RuntimeScopeClient({ timeoutMs: 2345 }))).toBe(2345);
    } finally {
      if (previous === undefined) delete process.env[envName];
      else process.env[envName] = previous;
    }
  });

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

  test('preserves a degraded binding across reads and observes same-generation recovery', async () => {
    let sidecar: RuntimeAssetBinding | undefined;
    const methods: string[] = [];
    const client = new RuntimeScopeClient({
      secret: 'secret',
      retries: 0,
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        methods.push(init?.method ?? 'GET');
        if (init?.method === 'GET') return Response.json(sidecar);
        const command = JSON.parse(String(init?.body));
        sidecar = { ...binding(command.gameId, command.scopeId, command.generation), status: 'degraded', authority: 'degraded' };
        return Response.json(sidecar);
      }) as typeof fetch,
    });
    const first = await client.bind('game-a', '/project/game-a');
    const second = await client.bind('game-a', '/project/game-a');
    const third = await client.bind('game-a', '/project/game-a');
    expect(first.status).toBe('degraded');
    expect(second.binding?.generation).toBe(first.binding?.generation);
    expect(third.binding?.generation).toBe(first.binding?.generation);
    sidecar = { ...sidecar!, status: 'ready', authority: 'authoritative' };
    const recovered = await client.bind('game-a', '/project/game-a');
    expect(recovered.status).toBe('ready');
    expect(recovered.binding?.generation).toBe(first.binding?.generation);
    expect(methods).toEqual(['POST', 'GET', 'GET', 'GET']);
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

  test('preserves the last committed binding when a different game fails to bind', async () => {
    let committed: RuntimeAssetBinding | undefined;
    let failedRequests = 0;
    const client = new RuntimeScopeClient({
      secret: 'secret',
      retries: 8,
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'GET') return Response.json(committed);
        const command = JSON.parse(String(init?.body)) as {
          gameId: string;
          scopeId: string;
          generation: number;
        };
        if (command.gameId === 'game-b') {
          failedRequests += 1;
          return Response.json({ detail: 'runtime-binding-mismatch' }, { status: 409 });
        }
        committed = binding(command.gameId, command.scopeId, command.generation);
        return Response.json(committed);
      }) as unknown as typeof fetch,
    });

    const first = await client.bind('game-a', '/project/.forgeax/games/game-a');
    const failed = await client.bind('game-b', '/project/.forgeax/games/game-b');
    const recovered = await client.bind('game-a', '/project/.forgeax/games/game-a');

    expect(first).toMatchObject({ status: 'ready', binding: { gameId: 'game-a' } });
    expect(failed).toMatchObject({
      status: 'degraded',
      binding: {
        gameId: 'game-a',
        status: 'degraded',
        authority: 'degraded',
      },
      error: 'runtime scope bind failed: runtime-binding-mismatch',
    });
    expect(failed.binding?.generation).toBe(committed?.generation);
    expect(failedRequests).toBe(1);
    expect(recovered).toMatchObject({ status: 'ready', binding: { gameId: 'game-a' } });
    expect(recovered.error).toBeUndefined();
    expect(client.snapshot()).toEqual(recovered);
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

  test('recovers a startup bind when the sidecar becomes reachable later', async () => {
    let requests = 0;
    const generations: number[] = [];
    const client = new RuntimeScopeClient({
      secret: 'secret',
      retries: 0,
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        requests += 1;
        const command = JSON.parse(String(init?.body)) as {
          gameId: string;
          scopeId: string;
          generation: number;
        };
        generations.push(command.generation);
        if (requests < 3) throw new TypeError('Unable to connect');
        return responseForBinding(command.gameId, command.scopeId, command.generation);
      }) as unknown as typeof fetch,
    });

    const state = await client.bindWhenAvailable(
      'game-a',
      '/project/.forgeax/games/game-a',
      { retryDelayMs: 0 },
    );

    expect(state.status).toBe('ready');
    expect(state.binding?.gameId).toBe('game-a');
    expect(requests).toBe(3);
    expect(generations).toHaveLength(3);
    expect(new Set(generations).size).toBe(1);
  });

  test('stops startup recovery when a newer active game supersedes it', async () => {
    let requests = 0;
    let current = true;
    const client = new RuntimeScopeClient({
      secret: 'secret',
      retries: 0,
      fetchImpl: (async () => {
        requests += 1;
        current = false;
        throw new TypeError('Unable to connect');
      }) as unknown as typeof fetch,
    });

    const state = await client.bindWhenAvailable(
      'game-a',
      '/project/.forgeax/games/game-a',
      { shouldContinue: () => current, retryDelayMs: 0 },
    );

    expect(state.status).toBe('unavailable');
    expect(requests).toBe(1);
  });

  test('an explicit bind cancels an older startup recovery before its next attempt', async () => {
    const requests: string[] = [];
    let releaseFirstAttempt: (() => void) | undefined;
    const firstAttemptStarted = new Promise<void>((resolve) => {
      releaseFirstAttempt = resolve;
    });
    let unblockFirstAttempt: (() => void) | undefined;
    const firstAttemptBlocked = new Promise<void>((resolve) => {
      unblockFirstAttempt = resolve;
    });
    const client = new RuntimeScopeClient({
      secret: 'secret',
      retries: 0,
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        const command = JSON.parse(String(init?.body)) as {
          gameId: string;
          scopeId: string;
          generation: number;
        };
        requests.push(command.gameId);
        if (command.gameId === 'game-a') {
          releaseFirstAttempt?.();
          await firstAttemptBlocked;
          throw new TypeError('Unable to connect');
        }
        return responseForBinding(command.gameId, command.scopeId, command.generation);
      }) as unknown as typeof fetch,
    });

    const recovery = client.bindWhenAvailable(
      'game-a',
      '/project/.forgeax/games/game-a',
      { retryDelayMs: 0 },
    );
    await firstAttemptStarted;
    const explicit = client.bind('game-b', '/project/.forgeax/games/game-b');
    unblockFirstAttempt?.();

    const [, explicitState] = await Promise.all([recovery, explicit]);
    expect(explicitState.binding?.gameId).toBe('game-b');
    expect(requests).toEqual(['game-a', 'game-b']);
  });
});

describe('RuntimeScopeClient source recovery', () => {
  test('preserves structured producer diagnostics on failed startup bind', async () => {
    const diagnostic = { code: 'pack-orphan-meta', detail: { sourcePath: 'assets/kart.glb' }, hint: 'Restore the source.' };
    const client = new RuntimeScopeClient({ secret: 'secret', retries: 0,
      fetchImpl: (async () => Response.json({ detail: 'scan-failed', diagnostic }, { status: 409 })) as unknown as typeof fetch });
    expect(await client.bind('kart', '/project/kart')).toMatchObject({ status: 'unavailable', diagnostic });
  });

  test('recovery uses trusted game identity, control credential and a fresh generation before accepting ready', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const client = new RuntimeScopeClient({ secret: 'secret', retries: 0,
      fetchImpl: (async (url: unknown, init?: RequestInit) => {
        expect(String(url)).toEndWith('/__pack/control/recover-asset');
        expect(new Headers(init?.headers).get('x-forgeax-runtime-secret')).toBe('secret');
        const command = JSON.parse(String(init?.body)); seen.push(command);
        return Response.json({ ok: true, metadataRebuilt: true,
          binding: binding(command.gameId, command.scopeId, command.generation) });
      }) as unknown as typeof fetch });
    const result = await client.recoverAsset('kart', '/project/kart', 'assets/kart.glb');
    expect(result).toMatchObject({ ok: true, metadataRebuilt: true, runtime: { status: 'ready', binding: { gameId: 'kart' } } });
    expect(seen[0]).toMatchObject({ gameId: 'kart', gameDir: '/project/kart', sourcePath: 'assets/kart.glb' });
    await client.recoverAsset('kart', '/project/kart', 'assets/tree.glb');
    expect(Number(seen[1].generation)).toBeGreaterThan(Number(seen[0].generation));
  });

  test('metadata recovery is not success when another source still prevents scan', async () => {
    const diagnostic = { code: 'pack-orphan-meta', detail: { sourcePath: 'assets/tree.png' } };
    const client = new RuntimeScopeClient({ secret: 'secret', retries: 0,
      fetchImpl: (async () => Response.json({ metadataRebuilt: true, diagnostic }, { status: 409 })) as unknown as typeof fetch });
    expect(await client.recoverAsset('kart', '/project/kart', 'assets/kart.glb')).toMatchObject({
      ok: false, metadataRebuilt: true, diagnostic, runtime: { status: 'unavailable', diagnostic },
    });
  });

  test('a stale selected game cannot begin a queued recovery', async () => {
    const client = new RuntimeScopeClient({ secret: 'secret', retries: 0,
      fetchImpl: (async () => { throw new Error('must not write'); }) as unknown as typeof fetch });
    expect(await client.recoverAsset('kart', '/project/kart', 'assets/kart.glb', () => false)).toMatchObject({
      ok: false, metadataRebuilt: false, diagnostic: { code: 'asset-recovery-game-changed' },
    });
  });

  test('a mismatched producer binding cannot become active', async () => {
    const client = new RuntimeScopeClient({ secret: 'secret', retries: 0,
      fetchImpl: (async () => Response.json({ ok: true, binding: binding('other', 'wrong', 1) })) as unknown as typeof fetch });
    expect(await client.recoverAsset('kart', '/project/kart', 'assets/kart.glb')).toMatchObject({ ok: false, runtime: { status: 'unavailable' } });
  });
});

test('failed recovery cannot reuse a previously ready catalog after the producer advanced', async () => {
  const diagnostic = { code: 'scan-failed', detail: { sourcePath: 'assets/other.png' } };
  const client = new RuntimeScopeClient({ secret: 'secret', retries: 0,
    fetchImpl: (async (url: unknown, init?: RequestInit) => {
      const command = JSON.parse(String(init?.body));
      if (String(url).endsWith('/recover-asset')) return Response.json({ metadataRebuilt: true, diagnostic }, { status: 409 });
      return Response.json(binding(command.gameId, command.scopeId, command.generation));
    }) as unknown as typeof fetch });
  expect(await client.bind('kart', '/project/kart')).toMatchObject({ status: 'ready' });
  const result = await client.recoverAsset('kart', '/project/kart', 'assets/kart.glb');
  expect(result).toMatchObject({ ok: false, metadataRebuilt: true, runtime: { status: 'unavailable', diagnostic } });
  expect(result.runtime.binding).toBeUndefined();
  expect(client.snapshot().binding).toBeUndefined();
});

test.each(['success', 'failure'] as const)('a late %s from recovery cannot publish after a newer game bind', async (outcome) => {
  let finish!: (response: Response) => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  let command: Record<string, any> = {};
  const client = new RuntimeScopeClient({ secret: 'secret', retries: 0,
    fetchImpl: (async (url: unknown, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body));
      if (String(url).endsWith('/recover-asset')) {
        command = input; started();
        return new Promise<Response>((resolve) => { finish = resolve; });
      }
      return Response.json(binding(input.gameId, input.scopeId, input.generation));
    }) as unknown as typeof fetch });
  const states: Array<{ status: string; game?: string }> = [];
  client.subscribe((state) => states.push({ status: state.status, game: state.binding?.gameId }));
  const recovery = client.recoverAsset('kart', '/project/kart', 'assets/kart.glb');
  await entered;
  const next = client.bind('other', '/project/other');
  finish(outcome === 'success'
    ? Response.json({ ok: true, metadataRebuilt: true, binding: binding(command.gameId, command.scopeId, command.generation) })
    : Response.json({ metadataRebuilt: true, diagnostic: { code: 'scan-failed' } }, { status: 409 }));
  expect(await recovery).toMatchObject({ ok: false, metadataRebuilt: true, diagnostic: { code: 'asset-recovery-game-changed' } });
  expect(await next).toMatchObject({ status: 'ready', binding: { gameId: 'other' } });
  expect(states.some((state) => state.game === 'kart')).toBe(false);
  expect(states.some((state) => state.status === 'unavailable')).toBe(false);
  expect(client.snapshot().binding?.gameId).toBe('other');
});


test('a same-game UI refresh preserves the in-flight source recovery result', async () => {
  let finish!: (response: Response) => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  let recovered!: RuntimeAssetBinding;
  const client = new RuntimeScopeClient({ secret: 'secret', retries: 0,
    fetchImpl: (async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith('/runtime-binding.json')) return Response.json(recovered);
      const input = JSON.parse(String(init?.body));
      if (String(url).endsWith('/recover-asset')) {
        recovered = binding(input.gameId, input.scopeId, input.generation);
        started();
        return new Promise<Response>((resolve) => { finish = resolve; });
      }
      return Response.json(binding(input.gameId, input.scopeId, input.generation));
    }) as unknown as typeof fetch });
  const recovery = client.recoverAsset('kart', '/project/kart', 'assets/kart.glb');
  await entered;
  const refresh = client.bind('kart', '/project/kart');
  finish(Response.json({ ok: true, metadataRebuilt: true, binding: recovered }));
  const result = await recovery;
  expect(result.ok).toBe(true);
  expect(result.runtime.binding).toEqual(recovered);
  expect((await refresh).binding).toEqual(recovered);
});

test('two same-game source recoveries each run in order and return their actual scan results', async () => {
  const sources: string[] = [];
  const client = new RuntimeScopeClient({ secret: 'secret', retries: 0,
    fetchImpl: (async (_url: unknown, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body));
      sources.push(input.sourcePath);
      if (sources.length === 1) return Response.json({ metadataRebuilt: true,
        diagnostic: { code: 'scan-failed', detail: { sourcePath: 'assets/tree.glb' } } }, { status: 409 });
      return Response.json({ ok: true, metadataRebuilt: true,
        binding: binding(input.gameId, input.scopeId, input.generation) });
    }) as unknown as typeof fetch });
  const first = client.recoverAsset('kart', '/project/kart', 'assets/kart.glb');
  const second = client.recoverAsset('kart', '/project/kart', 'assets/tree.glb');
  expect(await first).toMatchObject({ ok: false, metadataRebuilt: true, diagnostic: { code: 'scan-failed' } });
  expect(await second).toMatchObject({ ok: true, metadataRebuilt: true, runtime: { status: 'ready' } });
  expect(sources).toEqual(['assets/kart.glb', 'assets/tree.glb']);
});


test('an already expired startup attempt cannot cancel the current game recovery', async () => {
  let finish!: (response: Response) => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  let command: Record<string, any> = {};
  let calls = 0;
  const client = new RuntimeScopeClient({ secret: 'secret', retries: 0,
    fetchImpl: (async (_url: unknown, init?: RequestInit) => {
      calls += 1;
      command = JSON.parse(String(init?.body));
      started();
      return new Promise<Response>((resolve) => { finish = resolve; });
    }) as unknown as typeof fetch });
  const recovery = client.recoverAsset('current', '/project/current', 'assets/kart.glb');
  await entered;
  await client.bindWhenAvailable('old', '/project/old', { shouldContinue: () => false });
  finish(Response.json({ ok: true, metadataRebuilt: true,
    binding: binding(command.gameId, command.scopeId, command.generation) }));
  expect(await recovery).toMatchObject({ ok: true, runtime: { status: 'ready', binding: { gameId: 'current' } } });
  expect(calls).toBe(1);
});


test.each(['degraded', 'blocking', 'degraded-authority'] as const)('recovery rejects a %s catalog even when the control response says ok', async (state) => {
  const diagnostic = { code: 'scan-failed', severity: 'blocking', hint: 'Repair assets/other.png' };
  const client = new RuntimeScopeClient({ secret: 'secret', retries: 0,
    fetchImpl: (async (_url: unknown, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body));
      return Response.json({ ok: true, metadataRebuilt: true, binding: {
        ...binding(input.gameId, input.scopeId, input.generation),
        ...(state === 'degraded' ? { status: 'degraded' } : {}),
        ...(state === 'degraded-authority' ? { authority: 'degraded' } : {}),
        diagnostics: state === 'blocking' ? [diagnostic] : [],
      } });
    }) as unknown as typeof fetch });
  const result = await client.recoverAsset('kart', '/project/kart', 'assets/kart.glb');
  expect(result).toMatchObject({ ok: false, metadataRebuilt: true, runtime: { status: 'unavailable' } });
  expect(result.runtime.binding).toBeUndefined();
  if (state === 'blocking') expect(result.diagnostic).toMatchObject({ detail: { diagnostics: [diagnostic] } });
});
