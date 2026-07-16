import { describe, expect, test } from 'bun:test';
import { editorGatewayHostTools } from '../src/game/editor-gateway-host-tools';
import { studioHostTools } from '../src/game/host-tools';

const relay = 'http://127.0.0.1:15295';

function toolsFor(response: unknown, calls: Array<{ url: string; init?: RequestInit }> = []) {
  return {
    tools: editorGatewayHostTools({
      bridgeUrl: relay,
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify(response), { status: 200 });
      },
    }),
    calls,
  };
}

describe('editorGatewayHostTools', () => {
  test('is included in the Studio host-tool registration', () => {
    expect(studioHostTools().map((tool) => tool.name)).toEqual([
      'list_games',
      'query_world',
      'capture_frame',
      'editor_gateway_list_ops',
      'editor_gateway_dispatch',
    ]);
  });

  test('registers the live manifest and AI-origin dispatch tools', () => {
    const { tools } = toolsFor({ ok: true, value: [] });

    expect(tools.map((tool) => tool.name)).toEqual(['editor_gateway_list_ops', 'editor_gateway_dispatch']);
    expect(tools[0]?.inputSchema).toEqual({ type: 'object', properties: {} });
    expect(tools[1]?.inputSchema).toEqual({
      type: 'object',
      properties: { kind: { type: 'string' } },
      required: ['kind'],
      additionalProperties: true,
    });
  });

  test('lists operations through the relay without exposing raw eval', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const { tools } = toolsFor({ ok: true, value: [{ id: 'setSelection' }] }, calls);

    await expect(tools[0]!.run!({}, { agentId: 'forge', projectRoot: '/tmp' })).resolves.toEqual([{ id: 'setSelection' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${relay}/eval`);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ code: 'gateway.listOps()' });
  });

  test('dispatches the supplied operation through the gateway as AI', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const result = { ok: true, result: { created: [] } };
    const { tools } = toolsFor({ ok: true, value: result }, calls);

    await expect(tools[1]!.run!({ kind: 'setSelection', id: null }, { agentId: 'forge', projectRoot: '/tmp' })).resolves.toEqual(result);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      code: "gateway.dispatch({\"kind\":\"setSelection\",\"id\":null}, 'ai')",
    });
  });

  test('returns a structured unavailable result when the relay cannot be reached', async () => {
    const tools = editorGatewayHostTools({
      bridgeUrl: relay,
      fetch: async () => { throw new Error('connect ECONNREFUSED'); },
    });

    await expect(tools[0]!.run!({}, { agentId: 'forge', projectRoot: '/tmp' })).resolves.toEqual({
      unavailable: true,
      reason: 'editor gateway relay unavailable: connect ECONNREFUSED',
    });
  });
});
