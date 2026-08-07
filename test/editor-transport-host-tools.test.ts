import { describe, expect, test } from 'bun:test';
import { editorTransportHostTools } from '../src/game/editor-transport-host-tools';
import { studioHostTools } from '../src/game/host-tools';

const ctx = { agentId: 'forge', projectRoot: '/tmp', game: 'spin-cube' };

describe('editorTransportHostTools', () => {
  test('is included in the Studio host-tool registration without the eval relay', () => {
    expect(studioHostTools().map((tool) => tool.name)).toEqual([
      'list_games',
      'npc_wire',
      'query_world',
      'capture_frame',
      'editor_transport',
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

    await expect(tools[0]!.run!({ method: 'discover' }, ctx)).resolves.toEqual({ ok: true });
    expect(requests).toEqual([{
      jsonrpc: '2.0',
      version: 'editor-transport/v1',
      id: 'id-1',
      correlationId: 'id-2',
      scope: 'game:spin-cube',
      method: 'discover',
      params: {
        scope: 'game:spin-cube',
        sessionId: 'host:forge',
        actor: { id: 'forge', kind: 'ai' },
      },
    }]);
  });

  test('returns structured unavailable when the Studio page is not connected', async () => {
    const tools = editorTransportHostTools();
    await expect(tools[0]!.run!({ method: 'discover' }, ctx)).resolves.toMatchObject({
      error: { code: 'editor-carrier-unavailable', retryable: true },
    });
  });

  test('rejects missing method and missing scope before dispatch', async () => {
    let calls = 0;
    const tools = editorTransportHostTools({ dispatch: async () => { calls += 1; return {}; } });
    await expect(tools[0]!.run!({}, { agentId: 'forge', projectRoot: '/tmp' })).resolves.toMatchObject({ error: { code: 'invalid-args' } });
    await expect(tools[0]!.run!({ method: 'discover' }, { agentId: 'forge', projectRoot: '/tmp' })).resolves.toMatchObject({ error: { code: 'invalid-args' } });
    expect(calls).toBe(0);
  });
});
