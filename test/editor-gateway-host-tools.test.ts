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
      'editor_gateway_eval',
    ]);
  });

  test('registers one direct code-evaluation tool', () => {
    const { tools } = toolsFor({ ok: true, value: [] });

    expect(tools.map((tool) => tool.name)).toEqual(['editor_gateway_eval']);
    expect(tools[0]?.inputSchema).toEqual({
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'JavaScript expression or program evaluated in the live editor gateway page.',
        },
      },
      required: ['code'],
      additionalProperties: false,
    });
  });

  test('passes direct code through the relay', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const { tools } = toolsFor({ ok: true, value: 51 }, calls);

    await expect(tools[0]!.run!({ code: 'gateway.listOps().length' }, ctx)).resolves.toEqual(51);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${relay}/eval`);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ code: 'gateway.listOps().length' });
  });

  test('rejects an empty code payload before reaching the relay', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const { tools } = toolsFor({ ok: true, value: 51 }, calls);

    await expect(tools[0]!.run!({ code: '  ' }, ctx)).resolves.toEqual({
      ok: false,
      error: { code: 'INVALID_ARGS', hint: 'editor_gateway_eval requires a non-empty string "code"' },
    });
    expect(calls).toHaveLength(0);
  });

  test('normalizes a relay HTTP error', async () => {
    const tools = editorGatewayHostTools({
      bridgeUrl: relay,
      fetch: async () => new Response('', { status: 503 }),
    });

    await expect(tools[0]!.run!({ code: 'gateway.listOps()' }, ctx)).resolves.toEqual({
      ok: false,
      error: { code: 'RELAY_HTTP_ERROR', hint: 'editor gateway relay returned HTTP 503' },
    });
  });

  test('normalizes an invalid relay envelope', async () => {
    const { tools } = toolsFor({ value: 'missing ok' });

    await expect(tools[0]!.run!({ code: 'gateway.listOps()' }, ctx)).resolves.toEqual({
      ok: false,
      error: { code: 'RELAY_INVALID_RESPONSE', hint: 'editor gateway relay returned an invalid response' },
    });
  });

  test('normalizes a relay transport error', async () => {
    const tools = editorGatewayHostTools({
      bridgeUrl: relay,
      fetch: async () => { throw new Error('connect ECONNREFUSED'); },
    });

    await expect(tools[0]!.run!({ code: 'gateway.listOps()' }, ctx)).resolves.toEqual({
      ok: false,
      error: { code: 'RELAY_UNAVAILABLE', hint: 'editor gateway relay unavailable: connect ECONNREFUSED' },
    });
  });
});
