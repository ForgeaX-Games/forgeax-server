import { describe, expect, test } from 'bun:test';
import { editorGatewayHostTools } from '../src/game/editor-gateway-host-tools';
import { studioHostTools } from '../src/game/host-tools';

const relay = 'http://127.0.0.1:15295';
const ctx = { agentId: 'forge', projectRoot: '/tmp' };

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

    await expect(tools[0]!.run!({}, ctx)).resolves.toEqual([{ id: 'setSelection' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${relay}/eval`);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ code: 'gateway.listOps()' });
  });

  test('dispatches the supplied operation through the gateway as AI', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const result = { ok: true, result: { created: [] } };
    const { tools } = toolsFor({ ok: true, value: result }, calls);

    await expect(tools[1]!.run!({ kind: 'setSelection', id: null }, ctx)).resolves.toEqual(result);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      code: "gateway.dispatch({\"kind\":\"setSelection\",\"id\":null}, 'ai')",
    });
  });

  test('passes through a structured dispatch error from the relay', async () => {
    const failure = { ok: false, error: { code: 'INVALID_ARGS', hint: 'asset is required' } };
    const { tools } = toolsFor(failure);

    await expect(tools[1]!.run!({ kind: 'instantiateSceneAsset' }, ctx)).resolves.toEqual(failure);
  });

  test('normalizes a relay HTTP error', async () => {
    const tools = editorGatewayHostTools({
      bridgeUrl: relay,
      fetch: async () => new Response('', { status: 503 }),
    });

    await expect(tools[0]!.run!({}, ctx)).resolves.toEqual({
      ok: false,
      error: { code: 'RELAY_HTTP_ERROR', hint: 'editor gateway relay returned HTTP 503' },
    });
  });

  test('normalizes an invalid relay envelope', async () => {
    const { tools } = toolsFor({ value: 'missing ok' });

    await expect(tools[0]!.run!({}, ctx)).resolves.toEqual({
      ok: false,
      error: { code: 'RELAY_INVALID_RESPONSE', hint: 'editor gateway relay returned an invalid response' },
    });
  });

  test('normalizes a relay transport error', async () => {
    const tools = editorGatewayHostTools({
      bridgeUrl: relay,
      fetch: async () => { throw new Error('connect ECONNREFUSED'); },
    });

    await expect(tools[0]!.run!({}, ctx)).resolves.toEqual({
      ok: false,
      error: { code: 'RELAY_UNAVAILABLE', hint: 'editor gateway relay unavailable: connect ECONNREFUSED' },
    });
  });
});
