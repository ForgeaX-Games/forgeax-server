import { describe, expect, test } from 'bun:test';
import {
  EDITOR_TRANSPORT_PUBLIC_DISCOVERY,
  EDITOR_TRANSPORT_VERSION,
  editorTransportHostTools,
} from '../src/game/editor-transport-host-tools';
import { studioHostTools } from '../src/game/host-tools';

const ctx = { agentId: 'forge', projectRoot: '/tmp', game: 'spin-cube' };

/** Transitional registration list shared with editor-gateway-host-tools.test.ts. */
export const EXPECTED_STUDIO_TOOLS = [
      'deliver_summary',
      'list_games',
      'npc_wire',
      'search_game_assets',
      'editor_transport',
      'editor_gateway_eval',
      'editor_ui_browse',
    ];
export const HEALTHY_EDITOR_RELAY = {
  editorRelay: {
    available: true,
    baseUrl: 'http://127.0.0.1:15295',
    reason: 'available',
  },
} as const;

describe('editorTransportHostTools', () => {
  test('is included in the Studio host-tool registration (dual-track transition)', () => {
    // The typed editor_transport path is the destination. The legacy relay remains
    // in this registration list until the editor_ui_browse migration is complete.
    expect(studioHostTools(undefined, HEALTHY_EDITOR_RELAY).map((tool) => tool.name))
      .toEqual(EXPECTED_STUDIO_TOOLS);
  });

  test('declares the closed host method boundary without duplicating page operation discovery', () => {
    expect(EDITOR_TRANSPORT_PUBLIC_DISCOVERY.boundary).toBe('studio');
    expect(EDITOR_TRANSPORT_PUBLIC_DISCOVERY.baseUrl).toBe('http://localhost:18920');
    expect(EDITOR_TRANSPORT_PUBLIC_DISCOVERY.directEngine).toBe(false);
    expect(EDITOR_TRANSPORT_PUBLIC_DISCOVERY.methods).toEqual([
      'discover',
      'transport.describe',
      'query',
      'gameplay',
      'run.dispatch',
      'run.get',
      'run.wait',
      'run.list',
      'save',
      'reopen',
    ]);
    expect(EDITOR_TRANSPORT_PUBLIC_DISCOVERY).not.toHaveProperty('operations');
  });

  test('builds a typed discover request from the host context', async () => {
    const requests: unknown[] = [];
    const tools = editorTransportHostTools({
      idFactory: (() => {
        let next = 0;
        return () => `id-${++next}`;
      })(),
      dispatch: async (request) => { requests.push(request); return { ok: true }; },
    });

    expect(tools[0]!.inputSchema).toMatchObject({
      properties: { timeoutMs: { type: 'integer', minimum: 1, maximum: 300_000 } },
    });
    await expect(tools[0]!.run!({ method: 'discover', timeoutMs: 120_000 }, ctx)).resolves.toEqual({ ok: true });
    expect(requests).toEqual([{
      jsonrpc: '2.0',
      version: 'editor-transport/v1',
      id: 'id-1',
      correlationId: 'id-2',
      scope: 'game:spin-cube',
      method: 'discover',
      timeoutMs: 120_000,
      params: {
        scope: 'game:spin-cube',
        sessionId: 'host:forge',
        actor: { id: 'forge', kind: 'ai' },
      },
    }]);
  });

  test('resolves the legacy active-game scope alias from the host context', async () => {
    const requests: unknown[] = [];
    const tools = editorTransportHostTools({
      idFactory: (() => {
        let next = 0;
        return () => `alias-id-${++next}`;
      })(),
      dispatch: async (request) => { requests.push(request); return { ok: true }; },
    });

    await expect(tools[0]!.run!({ method: 'discover', scope: 'active-game' }, ctx)).resolves.toEqual({ ok: true });
    expect(requests).toEqual([{
      jsonrpc: '2.0',
      version: 'editor-transport/v1',
      id: 'alias-id-1',
      correlationId: 'alias-id-2',
      scope: 'game:spin-cube',
      method: 'discover',
      params: {
        scope: 'game:spin-cube',
        sessionId: 'host:forge',
        actor: { id: 'forge', kind: 'ai' },
      },
    }]);
  });

  test('routes discovered gameplay operations through the typed gameplay carrier', async () => {
    const requests: unknown[] = [];
    const tools = editorTransportHostTools({
      idFactory: (() => {
        let next = 0;
        return () => `gameplay-id-${++next}`;
      })(),
      dispatch: async (request) => { requests.push(request); return { ok: true }; },
    });

    await expect(tools[0]!.run!({
      method: 'run.dispatch',
      params: {
        operationId: 'editor.gameplay.describe',
        input: { version: 1, operation: 'describe' },
      },
    }, ctx)).resolves.toEqual({ ok: true });
    expect(requests).toEqual([{
      jsonrpc: '2.0',
      version: 'editor-transport/v1',
      id: 'gameplay-id-1',
      correlationId: 'gameplay-id-2',
      scope: 'game:spin-cube',
      method: 'gameplay',
      params: { version: 1, operation: 'describe' },
    }]);
  });

  test('keeps host metadata outside the strict direct gameplay request', async () => {
    const requests: Record<string, unknown>[] = [];
    const tools = editorTransportHostTools({ dispatch: async (request) => { requests.push(request); return { ok: true }; } });
    await tools[0]!.run!({ method: 'gameplay', permission: 'read',
      params: { version: 1, operation: 'describe' } }, ctx);
    expect(requests[0]).toMatchObject({ scope: 'game:spin-cube', method: 'gameplay' });
    expect(requests[0]!.params).toEqual({ version: 1, operation: 'describe' });
  });

  test('returns structured unavailable when the Studio page is not connected', async () => {
    const tools = editorTransportHostTools();
    await expect(tools[0]!.run!({ method: 'discover' }, ctx)).resolves.toMatchObject({
      error: { code: 'editor-carrier-unavailable', retryable: true },
    });
  });

  test('accepts the real page-owned play id and normalizes the legacy lifecycle alias', async () => {
    const requests: unknown[] = [];
    const tools = editorTransportHostTools({
      idFactory: (() => {
        let next = 0;
        return () => `play-id-${++next}`;
      })(),
      dispatch: async (request) => { requests.push(request); return { ok: true }; },
    });

    await tools[0]!.run!({
      method: 'run.dispatch',
      params: { operationId: 'editor.play', input: { dirtyPolicy: 'last-saved' } },
    }, ctx);
    await tools[0]!.run!({
      method: 'run.dispatch',
      params: { operationId: 'editor.lifecycle.stop', input: {} },
    }, ctx);

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ method: 'run.dispatch', params: { operationId: 'editor.play' } });
    expect(requests[1]).toMatchObject({ method: 'run.dispatch', params: { operationId: 'editor.stop' } });
  });

  test.each(['editor.captureFrame', 'editor.saveDocToDisk'])('forwards discovered %s with its unchanged authorization context', async (operationId) => {
    const requests: Record<string, unknown>[] = [];
    const tools = editorTransportHostTools({ dispatch: async (request) => { requests.push(request); return { ok: true }; } });
    const schema = tools[0]!.inputSchema as { properties: { params: { properties: { operationId: { pattern: string } } } } };
    expect(new RegExp(schema.properties.params.properties.operationId.pattern).test(operationId)).toBe(true);
    await tools[0]!.run!({ method: 'run.dispatch', permission: 'execute', params: {
      operationId, input: { requestId: 'capture-1' }, idempotencyKey: 'intent-1',
    } }, ctx);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'run.dispatch', scope: 'game:spin-cube', params: {
      operationId, input: { requestId: 'capture-1' }, idempotencyKey: 'intent-1',
      actor: { id: 'forge', kind: 'ai' }, sessionId: 'host:forge', permission: 'execute',
    } });
  });

  test.each(['editor.missingOperation', 'editor.gameplay.missingOperation'])('preserves the page rejection of %s without a fallback dispatch', async (operationId) => {
    const requests: Record<string, unknown>[] = [];
    const rejection = { error: { code: 'not-supported', retryable: false, recoveryActions: ['editor.discover'] } };
    const tools = editorTransportHostTools({ dispatch: async (request) => { requests.push(request); return rejection; } });
    expect(await tools[0]!.run!({ method: 'run.dispatch', params: { operationId, input: {} } }, ctx)).toBe(rejection);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'run.dispatch', params: { operationId } });
  });

  test('retains the method boundary and rejects malformed dispatch before contacting the page', async () => {
    let calls = 0;
    const tools = editorTransportHostTools({ dispatch: async () => { calls += 1; return {}; } });
    for (const args of [
      { method: 'script.execute', params: { code: 'anything' } },
      { method: 'run.dispatch', params: { operationId: 'captureFrame' } },
      { method: 'run.dispatch', params: { operationId: 'editor.' } },
    ]) expect(await tools[0]!.run!(args, ctx)).toMatchObject({ error: { code: 'not-supported' } });
    for (const params of [{}, { operationId: 'editor.captureFrame', input: [] }]) {
      expect(await tools[0]!.run!({ method: 'run.dispatch', params }, ctx)).toMatchObject({ error: { code: 'invalid-args' } });
    }
    expect(calls).toBe(0);
  });

  test('preserves permission denial from the page', async () => {
    const rejection = { error: { code: 'permission-denied', retryable: false } };
    const tools = editorTransportHostTools({ dispatch: async () => rejection });
    expect(await tools[0]!.run!({ method: 'run.dispatch', permission: 'read', params: {
      operationId: 'editor.saveDocToDisk', input: {},
    } }, ctx)).toBe(rejection);
  });

  test('unwraps query input so the page receives the projection contract directly', async () => {
    const requests: unknown[] = [];
    const tools = editorTransportHostTools({
      idFactory: (() => {
        let next = 0;
        return () => `query-id-${++next}`;
      })(),
      dispatch: async (request) => { requests.push(request); return { ok: true }; },
    });

    await tools[0]!.run!({ method: 'query', params: { input: { kind: 'world.snapshot', with: ['Name'] } } }, ctx);

    expect(requests).toEqual([{
      jsonrpc: '2.0',
      version: 'editor-transport/v1',
      id: 'query-id-1',
      correlationId: 'query-id-2',
      scope: 'game:spin-cube',
      method: 'query',
      params: { kind: 'world.snapshot', with: ['Name'] },
    }]);
  });

  test('rejects missing method and missing scope before dispatch', async () => {
    let calls = 0;
    const tools = editorTransportHostTools({ dispatch: async () => { calls += 1; return {}; } });
    await expect(tools[0]!.run!({}, { agentId: 'forge', projectRoot: '/tmp' })).resolves.toMatchObject({ error: { code: 'invalid-args' } });
    await expect(tools[0]!.run!({ method: 'discover' }, { agentId: 'forge', projectRoot: '/tmp' })).resolves.toMatchObject({ error: { code: 'invalid-args' } });
    await expect(tools[0]!.run!({ method: 'discover', scope: 'active-game' }, { agentId: 'forge', projectRoot: '/tmp' })).resolves.toMatchObject({
      error: {
        code: 'invalid-args',
        observed: { scope: 'active-game' },
        hint: expect.stringContaining('requires a game-bound host context'),
      },
    });
    expect(calls).toBe(0);
  });
});

test('trusted caller context stays out of the page request and reaches the carrier separately', async () => {
  const context = { ...ctx, sid: 'original-session' };
  let owner: unknown, wire: any;
  const tool = editorTransportHostTools({ dispatch: async (request, trusted) => { wire = request; owner = trusted; return {}; } })[0]!;
  await tool.run!({ method: 'run.dispatch', params: { operationId: 'editor.play' } }, context);
  expect(owner).toBe(context);
  expect(wire).not.toHaveProperty('context');
});


test('failed dispatch exposes the outer queryable run after host error flattening', async () => {
  const requests: Record<string, unknown>[] = [];
  const failure = { code: 'produce-failed', hint: 'repair producer', runId: 'operation-run-2', cause: { code: 'pack-source-external-closure-mismatch', detail: { unusedDeclaredGuids: ['unused'] } } };
  const tool = editorTransportHostTools({
    idFactory: (() => { let n = 0; return () => `receipt-${++n}`; })(),
    dispatch: async request => {
      requests.push(request);
      if (request.method === 'run.dispatch') return { jsonrpc: '2.0', version: 'editor-transport/v1', id: request.id, correlationId: request.correlationId, runId: `transport-${request.id}`, error: failure };
      return { result: { runId: (request.params as Record<string, unknown>).runId, status: 'failed', error: failure } };
    },
  })[0]!;
  const ctx = { agentId: 'forge', game: 'spin-cube', sid: 'session-a', projectRoot: '/tmp' };
  const result = await tool.run!({ method: 'run.dispatch', permission: 'execute', params: { operationId: 'editor.asset-source.cold-cook', input: { requestId: 'cook-a' } } }, ctx) as { error: Record<string, unknown> };
  // The existing host-tool bridge serializes only .error on failure.
  const visible = JSON.parse(JSON.stringify(result.error));
  expect(visible).toMatchObject({ ...failure, runId: 'transport-receipt-1', sourceRunId: 'operation-run-2', transport: { requestId: 'receipt-1', correlationId: 'receipt-2', scope: 'game:spin-cube' } });
  expect(await tool.run!({ method: 'run.get', permission: 'read', params: { runId: visible.runId } }, ctx)).toMatchObject({ result: { runId: visible.runId, status: 'failed' } });
  expect(requests[1]).toMatchObject({ scope: 'game:spin-cube', params: { sessionId: 'session-a', permission: 'read' } });
});

test('run.list recovery is callable through the same scoped dispatch', async () => {
  const requests: Record<string, unknown>[] = [];
  const tool = editorTransportHostTools({ dispatch: async request => { requests.push(request); return { result: { items: [] } }; } })[0]!;
  expect(await tool.run!({ method: 'run.list', permission: 'read', params: { limit: 2 } }, { agentId: 'forge', game: 'spin-cube', projectRoot: '/tmp' })).toMatchObject({ result: { items: [] } });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ method: 'run.list', scope: 'game:spin-cube', params: { limit: 2, permission: 'read' } });
});

test('an inner run without a transport journal receipt is not advertised as queryable', async () => {
  const tool = editorTransportHostTools({ dispatch: async request => ({
    version: EDITOR_TRANSPORT_VERSION, id: request.id, correlationId: request.correlationId,
    error: { code: 'produce-failed', hint: 'repair source', runId: 'operation-run-local' },
  }) })[0]!;
  const result = await tool.run!({ method: 'run.dispatch', permission: 'execute', params: {
    operationId: 'editor.asset-source.cold-cook', input: {},
  } }, { agentId: 'forge', game: 'spin-cube', projectRoot: '/tmp' }) as { error: Record<string, unknown> };
  expect(result.error).toMatchObject({ sourceRunId: 'operation-run-local', transport: { scope: 'game:spin-cube' } });
  expect(result.error).not.toHaveProperty('runId');
});
