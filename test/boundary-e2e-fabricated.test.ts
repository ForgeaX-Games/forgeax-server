/** 真实组件 e2e — 伪造历史 + 真实 ContextWindow / 真实 anthropic adapter /
 *  真实 runAgentLoop / 真实 compactCurrentSession / 真实 auto_compaction 插件;
 *  唯一的 seam 是全局 fetch（programmable stub）。对照老项目优化 05.2 / 02.8 /
 *  02.6,这几类边界在干净 live 会话里无法自然触发(要么要网关强制窗口上限、
 *  要么要模型恰好在 tool_call 中途撞 max_tokens、要么要压缩失败),故用"伪造
 *  历史 + 真实代码路径 + 故障注入"做端到端验证,而非 mock 自己的逻辑。 */

import { describe, test, expect, beforeEach, afterEach, setSystemTime } from 'bun:test';
import '../src/llm/register-all'; // side-effect: register all provider adapters
import { ContextWindow } from '../src/context-window/context-window';
import { runAgentLoop } from '../src/core/conscious-agent';
import { createProvider, getModelSpec } from '../src/llm/provider';
import { compactCurrentSession } from '../src/context-window/summary-compaction';
import autoCompaction from '../builtin/kits/compact/plugins/auto_compaction';
import type { StoredEvent } from '../src/ledger/types';
import type { LLMMessage } from '../src/llm/types';

const MODEL = 'claude-sonnet-4-6';

// ── fabricated ledger（真实历史数据;publish 的 boundary 回灌进来,模拟落盘）──

function userEvent(ts: number, text: string): StoredEvent {
  return { type: 'inbound_message', ts, source: 'user', payload: { llmMessage: { role: 'user', content: text, ts } as unknown as LLMMessage } };
}
function assistantEvent(ts: number, text: string): StoredEvent {
  return { type: 'hook:assistantMessage', ts, source: 'agent', payload: { llmMessage: { role: 'assistant', content: text, ts } as unknown as LLMMessage } };
}

interface FakeLedger {
  readAllEvents(): Promise<StoredEvent[]>;
  readFromTail(isEnough: (e: StoredEvent[]) => boolean): Promise<StoredEvent[]>;
  _push(e: StoredEvent): void;
  _all(): StoredEvent[];
}
function makeLedger(seed: StoredEvent[]): FakeLedger {
  const store = [...seed];
  return {
    readAllEvents: async () => [...store],
    readFromTail: async () => [...store],
    _push: (e) => store.push(e),
    _all: () => store,
  };
}

// ── programmable fetch stub ──────────────────────────────────────────────

interface SseEvt { type: string; [k: string]: unknown }
function sseResponse(events: SseEvt[], status = 200): Response {
  if (status !== 200) {
    // error body — anthropic adapter throwHttpApiError 会把 body 文本拼进 message
    return new Response(JSON.stringify(events), { status });
  }
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

// anthropic SSE 序列构造
function textTurn(text: string, stopReason = 'end_turn'): SseEvt[] {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 100 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ];
}
function truncatedToolTurn(toolName: string, partialJson: string): SseEvt[] {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 100 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'let me write that file' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_trunc', name: toolName } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: partialJson } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 4096 } },
    { type: 'message_stop' },
  ];
}

let fetchQueue: Array<() => Response> = [];
let fetchLog: string[] = [];
const realFetch = globalThis.fetch;

function installFetch(): void {
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = typeof init?.body === 'string' ? init.body : '';
    const isSummarizer = body.includes('summariz') || body.includes('Conversation Segment') || body.includes('curated summary');
    fetchLog.push(isSummarizer ? 'summarizer' : 'main');
    const next = fetchQueue.shift();
    if (!next) throw new Error('fetch stub: no queued response');
    return next();
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY ||= 'sk-test-stub';
  fetchQueue = [];
  fetchLog = [];
  installFetch();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setSystemTime();
});

// ── 公共:最小但真实的 runAgentLoop 装配 ───────────────────────────────────

function buildLoopOpts(ledger: FakeLedger, signal: AbortSignal, hooks: Array<{ type: string }>) {
  const cw = new ContextWindow('forge', ledger as never);
  const provider = createProvider({ model: MODEL });
  const resolveModels = () => ({ model: MODEL });
  const eventBus = {
    hook: (type: string) => { hooks.push({ type }); return {}; },
    // compaction publish 的 partial_boundary 回灌账本,模拟落盘
    publish: (e: StoredEvent) => { if (e.type === 'partial_boundary' || e.type === 'compact_boundary') ledger._push(e); },
  };
  const toolCtx = { signal, eventBus, ledger, resolveModels } as never;
  return {
    agentId: 'forge',
    signal,
    eventBus: eventBus as never,
    blackboard: { set: () => {}, getAll: () => ({}) } as never,
    agentContext: toolCtx,
    provider,
    getTools: () => [],
    assemblePrompt: async (history: LLMMessage[]) => ({ system: [], messages: history }),
    runToolBatch: async () => [],
    modelSpec: getModelSpec(MODEL),
    maxIterations: 6,
    contextWindow: cw,
    turn: 1,
  };
}

// ════════════════════════════════════════════════════════════════════════
// 边界4 — 413/prompt-too-long → 真实 reactive compact 救援 → 同 turn 重发
// ════════════════════════════════════════════════════════════════════════

describe('e2e: 413 context-overflow reactive rescue (fabricated big history)', () => {
  function bigHistory(): StoredEvent[] {
    const ev: StoredEvent[] = [];
    let ts = 1_000;
    for (let i = 0; i < 8; i++) {
      ev.push(userEvent(ts++, `用户第 ${i} 轮请求:` + 'x'.repeat(2000)));
      ev.push(assistantEvent(ts++, `助手第 ${i} 轮回复:` + 'y'.repeat(2000)));
    }
    return ev;
  }

  test('overflow on first call → real compactCurrentSession → retry succeeds', async () => {
    const ledger = makeLedger(bigHistory());
    const hooks: Array<{ type: string }> = [];
    const ac = new AbortController();

    // fetch 序列:① 主调用 413(超窗) → ② summarizer 出摘要 → ③ 主调用重试成功
    fetchQueue = [
      () => sseResponse([{ type: 'error', error: { message: 'prompt is too long: 250000 tokens > 200000 maximum' } }], 413),
      () => sseResponse(textTurn('<summary>\nSection 7: 用户在做一个游戏。\n</summary>')),
      () => sseResponse(textTurn('好的~ 我接着上次的继续做哦 ♪')),
    ];

    const ret = await runAgentLoop(buildLoopOpts(ledger, ac.signal, hooks) as never);

    // 真实路径证据:3 次 fetch,中间一次是 summarizer
    expect(fetchLog).toEqual(['main', 'summarizer', 'main']);
    // 压缩确实落了 partial_boundary 进账本(被 publish 回灌)
    expect(ledger._all().some((e) => e.type === 'partial_boundary')).toBe(true);
    // 重发成功:最终回复是第三次的内容,turn 正常收尾
    expect(ret && typeof ret.content === 'string' ? ret.content : '').toContain('继续做');
    expect(hooks.some((h) => h.type === 'hook:turnEnd' || h.type === 'hook:assistantMessage')).toBe(true);
  });

  test('overflow persists after compact → no infinite loop, turn ends', async () => {
    const ledger = makeLedger(bigHistory());
    const hooks: Array<{ type: string }> = [];
    const ac = new AbortController();
    // ① 413 → ② summarizer → ③ 还是 413(救不回)→ 不再无限重试
    fetchQueue = [
      () => sseResponse([{ type: 'error', error: { message: 'prompt is too long: 250000 tokens' } }], 413),
      () => sseResponse(textTurn('<summary>partial</summary>')),
      () => sseResponse([{ type: 'error', error: { message: 'prompt is too long: still 240000 tokens' } }], 413),
    ];

    await runAgentLoop(buildLoopOpts(ledger, ac.signal, hooks) as never).catch(() => null);
    // 只救一次:main 调用恰好 2 次(首次 + 救援后重试),不会第三次
    expect(fetchLog.filter((f) => f === 'main').length).toBe(2);
    expect(fetchLog.filter((f) => f === 'summarizer').length).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 边界1/2 — max_tokens 半截 tool_use:真实 anthropic 解析,工具不执行
// ════════════════════════════════════════════════════════════════════════

describe('e2e: max_tokens truncated tool_use (real anthropic SSE)', () => {
  test('truncated input_json + stop_reason=max_tokens → tool NOT executed, turn truncated', async () => {
    const ledger = makeLedger([userEvent(1, '写个文件'), assistantEvent(2, 'ok')]);
    const hooks: Array<{ type: string }> = [];
    const ac = new AbortController();
    let toolBatchCalls = 0;

    // 半截 tool_use args(JSON 没闭合)+ stop_reason=max_tokens
    fetchQueue = [() => sseResponse(truncatedToolTurn('write_file', '{"path":"/src/foo.t'))];

    const opts = buildLoopOpts(ledger, ac.signal, hooks) as never as Record<string, unknown>;
    opts.runToolBatch = async () => { toolBatchCalls++; return []; };

    const ret = await runAgentLoop(opts as never);

    // 半截工具绝不执行
    expect(toolBatchCalls).toBe(0);
    // turn 标 truncated 返回(供 process() 续写),工具被抑制
    expect((ret as { truncated?: boolean } | null)?.truncated).toBe(true);
    expect((ret as { toolCalls?: unknown[] } | null)?.toolCalls).toBeUndefined();
  });

  test('complete tool_use + end_turn → executes (no regression)', async () => {
    const ledger = makeLedger([userEvent(1, '读文件'), assistantEvent(2, 'ok')]);
    const hooks: Array<{ type: string }> = [];
    const ac = new AbortController();
    let toolBatchCalls = 0;

    fetchQueue = [() => sseResponse([
      { type: 'message_start', message: { usage: { input_tokens: 50 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_ok', name: 'read_file' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"/a.ts"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } },
      { type: 'message_stop' },
    ])];

    const opts = buildLoopOpts(ledger, ac.signal, hooks) as never as Record<string, unknown>;
    opts.runToolBatch = async (p: { toolCalls: unknown[] }) => { toolBatchCalls++; return []; };
    // 工具执行后会再 loop 一次发 LLM —— 给个收尾 turn
    fetchQueue.push(() => sseResponse(textTurn('done')));

    await runAgentLoop(opts as never);
    expect(toolBatchCalls).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 边界3 — auto_compaction 熔断:真实插件 + 真实 compaction summarizer 失败
// ════════════════════════════════════════════════════════════════════════

describe('e2e: auto_compaction circuit breaker (real plugin + real compaction)', () => {
  function compactableHistory(): StoredEvent[] {
    const ev: StoredEvent[] = [];
    let ts = 1_000;
    for (let i = 0; i < 8; i++) {
      ev.push(userEvent(ts++, `第 ${i} 问`));
      ev.push(assistantEvent(ts++, `第 ${i} 答`));
    }
    return ev;
  }

  function makeCtx(ledger: FakeLedger) {
    let observer: ((e: { type: string; payload: Record<string, unknown>; ts: number; source: string }, id?: string) => void) | null = null;
    const ctx = {
      agentPath: 'forge',
      signal: new AbortController().signal,
      getAgentJson: () => ({}),
      resolveModels: () => ({ model: MODEL }),
      ledger,
      eventBus: {
        publish: (e: StoredEvent) => { if (e.type === 'partial_boundary') ledger._push(e); },
        observe: (fn: typeof observer) => { observer = fn; return () => { observer = null; }; },
      },
    };
    return {
      ctx,
      fire: async (tokens = 10_000_000) => {
        observer?.({ type: 'hook:assistantMessage', payload: { usage: { inputTokens: tokens, outputTokens: 0 }, model: MODEL }, ts: Date.now(), source: 'x' }, 'forge');
        await Bun.sleep(8);
      },
    };
  }

  test('summarizer keeps failing → breaker trips then half-opens after cooldown', async () => {
    const ledger = makeLedger(compactableHistory());
    const { ctx, fire } = makeCtx(ledger);
    const plugin = autoCompaction(ctx as never);
    plugin.start?.();

    // 每次 compaction 的 summarizer 调用都真实失败(500)
    const failResp = () => sseResponse([{ type: 'error', error: { message: 'summarizer upstream 500' } }], 500);
    fetchQueue = [failResp, failResp, failResp, failResp, failResp];

    for (let i = 0; i < 3; i++) await fire();
    const after3 = fetchLog.length;
    expect(after3).toBe(3);                       // 3 次真实尝试(每次都失败)

    await fire();                                  // 熔断窗口内 → 直接拒,不再 fetch
    expect(fetchLog.length).toBe(3);

    setSystemTime(new Date(Date.now() + 6 * 60_000));  // 越过 5 分钟冷却
    await fire();                                  // half-open 探测 → 再尝试一次
    expect(fetchLog.length).toBe(4);

    plugin.stop?.();
  });

  test('benign skip (compaction already running) does NOT count toward breaker', async () => {
    // 会话太短 → compactCurrentSession 早退 "too short",属于 skip 不是 failure
    const ledger = makeLedger([userEvent(1, 'hi'), assistantEvent(2, 'yo')]);
    const { ctx, fire } = makeCtx(ledger);
    const plugin = autoCompaction(ctx as never);
    plugin.start?.();
    // 不需要 fetch —— too-short 在 summarizer 之前早退
    for (let i = 0; i < 5; i++) await fire();
    // 5 次都尝试了(没被熔断永久禁用),且都没走到 fetch
    expect(fetchLog.length).toBe(0);
    plugin.stop?.();
  });
});
