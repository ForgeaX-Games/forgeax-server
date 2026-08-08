import { describe, expect, test } from 'bun:test';
import { editorTransportHostTools } from '../src/game/editor-transport-host-tools';
import { studioHostTools } from '../src/game/host-tools';

const ctx = { agentId: 'forge', projectRoot: '/tmp', game: 'spin-cube' };

/** 过渡期注册清单单源 —— 与 editor-gateway-host-tools.test.ts 共用同一份。 */
export const EXPECTED_STUDIO_TOOLS = [
      'list_games',
      'npc_wire',
      'query_world',
      'capture_frame',
      'editor_transport',
      'editor_gateway_eval',
      'editor_ui_browse',
    ];

describe('editorTransportHostTools', () => {
  test('is included in the Studio host-tool registration (dual-track transition)', () => {
    // 上游方向:typed editor_transport 取代 JS relay。行走协议 editor_ui_browse 的
    // 编辑器腿尚未迁移到 transport(显性债,见 docs/ai-native/agent-native-exemplar.md
    // 与 pending-team-handoffs),过渡期 relay 双轨保留 —— 本清单是过渡态契约,
    // 迁移完成后 editor_gateway_eval 从这里删除。
    expect(studioHostTools().map((tool) => tool.name)).toEqual(EXPECTED_STUDIO_TOOLS);
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
