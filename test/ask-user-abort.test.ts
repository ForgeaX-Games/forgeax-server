import { describe, test, expect } from 'bun:test';
import { registerAsk, resolveAsk } from '../src/core/ask-user-registry';
import { runToolBatch } from '../src/kits/tool/tool-batch-runner';
import { Hook } from '../src/hooks/types';
import type { ToolDefinition, AgentContext } from '../src/core/types';
import askUserTool from '../builtin/kits/workspace/tools/ask_user';

// 用户点「终止」（POST /:sid/abort → abortController.abort()）时，turn 必须
// 能收尾 —— 这是 UI 终止操作永不被挂死的硬保证。曾经的事故链：ask_user 的
// abort 处理只 dispose() 不 settle promise → execute() 永挂 → tool batch 永
// 挂 → TurnEnd 不发 → 前端 spinner 永转、agent 整个卡死只能重启 server。
// 这组用例锁两道闸门：① AskHandle.cancel() 真 settle；② tool-batch-runner
// 对任何悬挂工具的 abort 兜底竞速。

describe('ask-user-registry cancel()', () => {
  test('cancel settles the promise with null and unregisters the pending entry', async () => {
    const h = registerAsk('s-cancel', 'forge', 60_000);
    h.cancel();
    expect(await h.promise).toBeNull();
    // 表项已删 —— 之后 UI 迟到的作答不再有挂靠点。
    expect(resolveAsk('s-cancel', 'forge', ['A'])).toBe(false);
    h.dispose(); // finally 路径的 dispose 在 cancel 后必须无害
  });

  test('normal resolveAsk path still works', async () => {
    const h = registerAsk('s-ok', 'forge', 60_000);
    expect(resolveAsk('s-ok', 'forge', ['选项一'])).toBe(true);
    expect(await h.promise).toEqual(['选项一']);
    h.dispose();
  });

  test('user answer beats a later cancel (first settle wins)', async () => {
    const h = registerAsk('s-race', 'forge', 60_000);
    resolveAsk('s-race', 'forge', ['B']);
    h.cancel();
    expect(await h.promise).toEqual(['B']);
  });
});

describe('ask_user tool abort', () => {
  const askCtx = (signal: AbortSignal): AgentContext =>
    ({ tree: { sid: 's-tool' }, agentPath: 'forge', signal } as unknown as AgentContext);

  test('abort mid-wait → execute returns 中断回执 immediately', async () => {
    const ac = new AbortController();
    const p = askUserTool.execute(
      { question: 'pick?', options: [{ label: 'A' }, { label: 'B' }] },
      askCtx(ac.signal),
    );
    setTimeout(() => ac.abort(), 10);
    expect(await p).toBe('(用户中断,未作答)');
  });

  test('already-aborted signal → immediate 中断回执, no dangling pending', async () => {
    const ac = new AbortController();
    ac.abort();
    const out = await askUserTool.execute(
      { question: 'pick?', options: [{ label: 'A' }] },
      askCtx(ac.signal),
    );
    expect(out).toBe('(用户中断,未作答)');
    expect(resolveAsk('s-tool', 'forge', ['A'])).toBe(false);
  });
});

describe('tool-batch-runner abort race', () => {
  const hangTool: ToolDefinition = {
    name: 'hang_forever',
    description: 'never resolves',
    input_schema: { type: 'object', properties: {} },
    execute: () => new Promise<never>(() => {}),
  } as unknown as ToolDefinition;

  const makeCtx = (signal: AbortSignal, hooks: Array<{ type: string; payload: Record<string, unknown> }>) =>
    ({
      signal,
      eventBus: {
        hook: (type: string, payload: Record<string, unknown>) => {
          hooks.push({ type, payload });
          return {};
        },
      },
    } as unknown as AgentContext);

  const batchParams = (toolCalls: { id: string; name: string }[], toolCtx: AgentContext, tools: ToolDefinition[], signal: AbortSignal) => ({
    toolCalls: toolCalls.map((t) => ({ ...t, arguments: {} })),
    tools,
    toolCtx,
    materializePending: () => [],
    materializeResult: () => ({ role: 'tool', content: '' }) as never,
    turn: 1,
    signal,
  });

  test('hanging tool + abort → batch resolves with aborted error and emits ToolResult', async () => {
    const ac = new AbortController();
    const hooks: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const ctx = makeCtx(ac.signal, hooks);

    const p = runToolBatch(batchParams([{ id: 't1', name: 'hang_forever' }], ctx, [hangTool], ac.signal));
    setTimeout(() => ac.abort(), 10);
    const outcomes = await p; // 永挂工具绝不能把这里挂死

    expect(outcomes).toHaveLength(1);
    expect((outcomes[0]!.result as { error: string }).error).toContain('(aborted)');
    // tool_use ↔ tool_result 配对：中断也要 commit ToolResult。
    const results = hooks.filter((h) => h.type === Hook.ToolResult);
    expect(results).toHaveLength(1);
    expect(String(results[0]!.payload.error)).toContain('(aborted)');
  });

  test('already-aborted signal → remaining tools are not executed, all calls still get results', async () => {
    const ac = new AbortController();
    ac.abort();
    let executed = false;
    const spyTool: ToolDefinition = {
      name: 'spy',
      description: '',
      input_schema: { type: 'object', properties: {} },
      execute: () => {
        executed = true;
        return Promise.resolve('ran');
      },
    } as unknown as ToolDefinition;
    const hooks: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const ctx = makeCtx(ac.signal, hooks);

    const outcomes = await runToolBatch(
      batchParams([{ id: 't1', name: 'spy' }, { id: 't2', name: 'spy' }], ctx, [spyTool], ac.signal),
    );

    expect(executed).toBe(false);
    expect(outcomes).toHaveLength(2);
    for (const o of outcomes) {
      expect((o.result as { error: string }).error).toContain('(aborted)');
    }
    expect(hooks.filter((h) => h.type === Hook.ToolResult)).toHaveLength(2);
  });

  test('no abort → normal execution unaffected', async () => {
    const ac = new AbortController();
    const okTool: ToolDefinition = {
      name: 'ok',
      description: '',
      input_schema: { type: 'object', properties: {} },
      execute: () => Promise.resolve('done!'),
    } as unknown as ToolDefinition;
    const hooks: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const ctx = makeCtx(ac.signal, hooks);

    const outcomes = await runToolBatch(batchParams([{ id: 't1', name: 'ok' }], ctx, [okTool], ac.signal));
    expect(outcomes[0]!.result).toBe('done!');
  });
});
