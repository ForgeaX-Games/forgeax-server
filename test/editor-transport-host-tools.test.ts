import { describe, expect, test } from 'bun:test';
import {
  EDITOR_TRANSPORT_PUBLIC_DISCOVERY,
  editorTransportHostTools,
} from '../src/game/editor-transport-host-tools';
import { studioHostTools } from '../src/game/host-tools';

const ctx = { agentId: 'forge', projectRoot: '/tmp', game: 'spin-cube' };

/** Transitional registration list shared with editor-gateway-host-tools.test.ts. */
export const EXPECTED_STUDIO_TOOLS = [
      'deliver_summary',
      'list_games',
      'npc_wire',
      'query_world',
      'capture_frame',
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

  test('declares a closed public discovery inventory with typed schemas and recovery', () => {
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
      'save',
      'reopen',
    ]);
    for (const operation of EDITOR_TRANSPORT_PUBLIC_DISCOVERY.operations) {
      expect(Object.keys(operation).sort()).toEqual(['availability', 'id', 'inputSchema', 'outputSchema', 'unsupportedCode']);
      expect(operation.availability).toBe('page-owned');
      expect(operation.unsupportedCode).toBe('not-supported');
      expect(operation.inputSchema.type).toBe('object');
      expect(operation.outputSchema.type).toBe('object');
    }
    expect(EDITOR_TRANSPORT_PUBLIC_DISCOVERY.operations.map((operation) => operation.id)).toEqual([
      'game.select',
      'persistence.save',
      'persistence.fresh-read',
      'play',
      'stop',
      'lifecycle.play',
      'lifecycle.stop',
      'gameplay.input',
      'gameplay.describe',
      'gameplay.projection',
      'carrier.identity',
      'evidence.logs',
      'evidence.capture',
      'evidence.trace',
      'evidence.performance',
      'evidence.diagnostics',
    ]);
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

  test('an unknown operationId answers with the real id list and names the near miss', async () => {
    let calls = 0;
    const tools = editorTransportHostTools({ dispatch: async () => { calls += 1; return {}; } });

    const result = await tools[0]!.run!({
      method: 'run.dispatch',
      params: { operationId: 'editor.start', input: { dirtyPolicy: 'last-saved' } },
    }, ctx);

    expect(calls).toBe(0);
    expect(result).toMatchObject({
      error: {
        code: 'not-supported',
        retryable: false,
      },
    });
    const { error } = result as { error: { expected: { operationId: string[] }; hint: string } };
    expect(error.expected.operationId).toContain('editor.play');
    expect(error.expected.operationId).not.toContain('editor.<operation from discover>');
    expect(error.hint).toContain('Do not repeat this identifier');
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
