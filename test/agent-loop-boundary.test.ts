import { describe, test, expect, setSystemTime, afterEach } from 'bun:test';
import { runAgentLoop } from '../src/core/conscious-agent';
import { responseToAssistantMessage } from '../src/llm/stream';
import type { StreamEvent } from '../src/llm/types';
import autoCompaction from '../builtin/kits/compact/plugins/auto_compaction';

// agent loop 边界用例 —— 对照老项目优化 05.2(max_tokens 续写护栏)与
// 02.8(压缩失败放行不锁死/熔断不永久禁用)。

async function* fromArray(events: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const e of events) yield e;
}

interface LoopHarness {
  opts: Parameters<typeof runAgentLoop>[0];
  llmCalls: () => number;
  batchCalls: () => Array<{ toolCalls: unknown[] }>;
  hooks: () => Array<{ type: string; payload: Record<string, unknown> }>;
}

function makeHarness(
  turns: Array<StreamEvent[] | Error>,
  extra?: Partial<Parameters<typeof runAgentLoop>[0]>,
): LoopHarness {
  let call = 0;
  const hooks: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const batches: Array<{ toolCalls: unknown[] }> = [];

  const provider = {
    chatStream: () => {
      const item = turns[Math.min(call, turns.length - 1)]!;
      call++;
      if (item instanceof Error) {
        return (async function* (): AsyncIterable<StreamEvent> { throw item; })();
      }
      return fromArray(item);
    },
    materializeAssistantMessage: responseToAssistantMessage,
    materializePendingToolMessages: () => [],
    materializeToolResult: () => ({ role: 'tool' as const, content: [] }),
  };

  const opts: Parameters<typeof runAgentLoop>[0] = {
    agentId: 'forge',
    signal: new AbortController().signal,
    eventBus: {
      hook: (type: string, payload: Record<string, unknown>) => { hooks.push({ type, payload }); return {}; },
    } as never,
    blackboard: { set: () => {}, getAll: () => ({}) } as never,
    provider: provider as never,
    getTools: () => [],
    assemblePrompt: async (history) => ({ system: [], messages: history }),
    runToolBatch: async (params: { toolCalls: unknown[] }) => {
      batches.push({ toolCalls: params.toolCalls });
      return [];
    },
    modelSpec: {} as never,
    maxIterations: 6,
    contextWindow: {
      buildPrompt: async () => [],
      buildSystemSnapshot: async () => new Map(),
    } as never,
    turn: 1,
    ...extra,
  };

  return { opts, llmCalls: () => call, batchCalls: () => batches, hooks: () => hooks };
}

describe('runAgentLoop max_tokens guard', () => {
  test('max_tokens + complete-looking tool_call → suppressed, truncated returned for continuation', async () => {
    const h = makeHarness([[
      { type: 'text', text: 'half-written reply' },
      // args JSON 凑巧完整(多 tool_use 截断时靠前的块就是这样)—— 仍然不执行
      { type: 'tool_call', id: 't1', name: 'write_file', arguments: '{"path":"/a.ts","content":"x"}' },
      { type: 'finish', stopReason: 'max_tokens' },
    ]]);
    const ret = await runAgentLoop(h.opts);

    expect(h.batchCalls()).toHaveLength(0);            // 工具绝不执行
    expect(ret?.truncated).toBe(true);                 // process() 据此触发 breakpoint continuation
    expect(ret?.toolCalls).toBeUndefined();            // 半截调用被抑制
    expect(h.llmCalls()).toBe(1);                      // 本 runAgentLoop 内不重发(续写由外层 process 驱动)
  });

  test('end_turn + tool_call → executes normally (no regression)', async () => {
    const h = makeHarness([
      [
        { type: 'tool_call', id: 't1', name: 'read_file', arguments: '{"path":"/a.ts"}' },
        { type: 'finish', stopReason: 'tool_use' },
      ],
      [
        { type: 'text', text: 'done' },
        { type: 'finish', stopReason: 'end_turn' },
      ],
    ]);
    const ret = await runAgentLoop(h.opts);

    expect(h.batchCalls()).toHaveLength(1);
    expect((h.batchCalls()[0]!.toolCalls as Array<{ id: string }>)[0]!.id).toBe('t1');
    expect(ret?.truncated).toBeFalsy();
  });

  test('max_tokens with text only → truncated returned, no tool batch', async () => {
    const h = makeHarness([[
      { type: 'text', text: 'long reply cut off mid-sen' },
      { type: 'finish', stopReason: 'max_tokens' },
    ]]);
    const ret = await runAgentLoop(h.opts);
    expect(ret?.truncated).toBe(true);
    expect(h.batchCalls()).toHaveLength(0);
  });
});

describe('runAgentLoop reactive overflow rescue', () => {
  const overflowErr = () =>
    new Error('API 请求参数错误: prompt is too long: 250123 tokens > 200000 maximum');

  test('overflow → rescue succeeds → same turn retried', async () => {
    let rescueCalls = 0;
    const h = makeHarness(
      [overflowErr(), [{ type: 'text', text: 'recovered' }, { type: 'finish', stopReason: 'end_turn' }]],
      { reactiveOverflowRescue: async () => { rescueCalls++; return true; } },
    );
    const ret = await runAgentLoop(h.opts);

    expect(rescueCalls).toBe(1);
    expect(h.llmCalls()).toBe(2);                      // 失败 1 次 + 救援后重发 1 次
    expect(ret && typeof ret.content === 'string' ? ret.content : '').toBe('recovered');
  });

  test('overflow → rescue fails → no infinite retry, loop exits', async () => {
    let rescueCalls = 0;
    const h = makeHarness(
      [overflowErr()],
      { reactiveOverflowRescue: async () => { rescueCalls++; return false; } },
    );
    // 救不回时按原错误路径收尾(throw 或 retryable break 均可,关键是不无限重试)
    await runAgentLoop(h.opts).catch(() => null);

    expect(rescueCalls).toBe(1);
    expect(h.llmCalls()).toBe(1);
  });

  test('second overflow in same run → rescue NOT re-attempted (one-shot)', async () => {
    let rescueCalls = 0;
    const h = makeHarness(
      [overflowErr(), overflowErr()],
      { reactiveOverflowRescue: async () => { rescueCalls++; return true; } },
    );
    await runAgentLoop(h.opts).catch(() => null);

    expect(rescueCalls).toBe(1);                       // 只救一次,防压缩-失败死循环
    expect(h.llmCalls()).toBe(2);
  });

  test('non-overflow client error → rescue not consulted', async () => {
    let rescueCalls = 0;
    const h = makeHarness(
      [new Error('invalid tool schema')],
      { reactiveOverflowRescue: async () => { rescueCalls++; return true; } },
    );
    await runAgentLoop(h.opts).catch(() => null);
    expect(rescueCalls).toBe(0);
  });
});

// ── auto_compaction 熔断边界(02.8: 永不永久禁用;skip 不计失败) ────────────

interface CompactionHarness {
  fire: (tokens?: number) => Promise<void>;
  attempts: () => number;
  stop: () => void;
}

function makeCompactionHarness(ledgerBehavior: 'short' | 'throw'): CompactionHarness {
  let attempts = 0;
  let observer: ((event: { type: string; payload: Record<string, unknown>; ts: number; source: string }, emitterId?: string) => void) | null = null;

  const ledger = {
    readFromTail: async () => {
      attempts++;
      if (ledgerBehavior === 'throw') throw new Error('ledger IO error (simulated)');
      return [];                                      // 0 条 → "Session too short" skip
    },
    readAllEvents: async () => [],
    readLastEvents: async () => [],
  };

  const ctx = {
    agentPath: 'forge',
    signal: new AbortController().signal,
    getAgentJson: () => ({}),
    resolveModels: () => ({ model: 'claude-test' }),
    ledger,
    eventBus: {
      publish: () => {},
      observe: (fn: typeof observer) => { observer = fn; return () => { observer = null; }; },
    },
  };

  const plugin = autoCompaction(ctx as never);
  plugin.start?.();

  return {
    fire: async (tokens = 10_000_000) => {
      observer?.(
        { type: 'hook:assistantMessage', payload: { usage: { inputTokens: tokens, outputTokens: 0 }, model: 'claude-test' }, ts: Date.now(), source: 'test' },
        'forge',
      );
      await Bun.sleep(5);                              // flush void runCompaction
    },
    attempts: () => attempts,
    stop: () => plugin.stop?.(),
  };
}

afterEach(() => setSystemTime());                      // 恢复真实时钟

describe('auto_compaction circuit breaker', () => {
  test('benign skips do NOT trip the breaker (attempts keep flowing)', async () => {
    const h = makeCompactionHarness('short');
    for (let i = 0; i < 5; i++) await h.fire();
    // 旧逻辑 skip 也计失败,3 次后永久禁用 → attempts 停在 3;新逻辑 5 次全部尝试
    expect(h.attempts()).toBe(5);
    h.stop();
  });

  test('real failures trip the breaker, but it half-opens after cooldown (never permanent)', async () => {
    const h = makeCompactionHarness('throw');
    for (let i = 0; i < 3; i++) await h.fire();
    expect(h.attempts()).toBe(3);

    await h.fire();                                    // 熔断窗口内 → 拒绝
    expect(h.attempts()).toBe(3);

    setSystemTime(new Date(Date.now() + 6 * 60_000));  // 越过 5 分钟冷却
    await h.fire();                                    // half-open 探测放行
    expect(h.attempts()).toBe(4);
    h.stop();
  });
});
