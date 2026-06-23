import { describe, test, expect, afterEach } from 'bun:test';
import { assembleResponse } from '../src/llm/stream';
import { normalizeStopReason } from '../src/llm/types';
import type { StreamEvent } from '../src/llm/types';
import { isContextOverflowError } from '../src/llm/errors';
import { createAnthropicProvider } from '../src/llm/anthropic';

// 协议层边界用例 —— 对照老项目(agentic_os)优化 05.1/05.2/02.6:
// max_tokens 截断时 tool_use 的 args JSON 是半截,绝不能静默按 {} 执行;
// stop_reason 必须跨 provider 归一化上抛,供 agent loop 做续写护栏。

async function* fromArray(events: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const e of events) yield e;
}

describe('ResponseAccumulator boundary', () => {
  test('finish event → response.stopReason', async () => {
    const r = await assembleResponse(fromArray([
      { type: 'text', text: 'hi' },
      { type: 'finish', stopReason: 'max_tokens' },
    ]));
    expect(r.stopReason).toBe('max_tokens');
  });

  test('corrupt tool_call args (truncated JSON) is DROPPED, not executed as {}', async () => {
    const r = await assembleResponse(fromArray([
      { type: 'tool_call', id: 't1', name: 'write_file', arguments: '{"path":"/src/foo.t' },
      { type: 'finish', stopReason: 'max_tokens' },
    ]));
    // 半截 args 的调用整个丢弃 —— 此前静默 JSON.parse 失败 → arguments={} →
    // 副作用工具拿空参执行。
    expect(r.toolCalls).toBeUndefined();
  });

  test('valid tool_call kept alongside a corrupt one', async () => {
    const r = await assembleResponse(fromArray([
      { type: 'tool_call', id: 't1', name: 'read_file', arguments: '{"path":"/a.ts"}' },
      { type: 'tool_call', id: 't2', name: 'write_file', arguments: '{"path":"/b' },
    ]));
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls![0]!.id).toBe('t1');
    expect(r.toolCalls![0]!.arguments).toEqual({ path: '/a.ts' });
  });

  test('empty arguments string → {} (legit zero-arg tools unaffected)', async () => {
    const r = await assembleResponse(fromArray([
      { type: 'tool_call', id: 't1', name: 'list_models', arguments: '' },
    ]));
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls![0]!.arguments).toEqual({});
  });
});

describe('normalizeStopReason', () => {
  test('cross-provider mapping', () => {
    expect(normalizeStopReason('end_turn')).toBe('end_turn');     // anthropic
    expect(normalizeStopReason('max_tokens')).toBe('max_tokens');
    expect(normalizeStopReason('length')).toBe('max_tokens');     // openai
    expect(normalizeStopReason('stop')).toBe('end_turn');
    expect(normalizeStopReason('tool_calls')).toBe('tool_use');
    expect(normalizeStopReason('MAX_TOKENS')).toBe('max_tokens'); // gemini
    expect(normalizeStopReason('STOP')).toBe('end_turn');
    expect(normalizeStopReason('weird_new_reason')).toBe('other');
    expect(normalizeStopReason(undefined)).toBeUndefined();
    expect(normalizeStopReason(null)).toBeUndefined();
  });
});

describe('isContextOverflowError', () => {
  test('matches cross-provider overflow messages', () => {
    expect(isContextOverflowError(new Error('API 请求参数错误: prompt is too long: 250123 tokens > 200000 maximum'))).toBe(true);
    expect(isContextOverflowError(new Error("This model's maximum context length is 128000 tokens."))).toBe(true);
    expect(isContextOverflowError(new Error('error code: context_length_exceeded'))).toBe(true);
    expect(isContextOverflowError(new Error('Input is too long for requested model'))).toBe(true);
  });
  test('does not match unrelated 4xx', () => {
    expect(isContextOverflowError(new Error('API 认证失败'))).toBe(false);
    expect(isContextOverflowError(new Error('invalid tool schema'))).toBe(false);
    expect(isContextOverflowError(undefined)).toBe(false);
  });
});

// ── anthropic adapter: SSE 级边界(mock fetch) ──────────────────────────────

function sseBody(events: Array<{ event: string; data: Record<string, unknown> }>): string {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
}

function mockFetchOnce(body: string): void {
  globalThis.fetch = (async () =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe('anthropic adapter truncation boundary', () => {
  const provider = () => createAnthropicProvider({ model: 'claude-test', apiKey: 'k' });
  const signal = new AbortController().signal;

  test('max_tokens: stop_reason surfaces as finish event; tool_use filtered from sidecar', async () => {
    mockFetchOnce(sseBody([
      { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 10 } } } },
      { event: 'content_block_start', data: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu1', name: 'write_file' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"path":"/x.ts","content":"abc' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop' } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 99 } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]));
    const events = await collect(provider().chatStream(undefined, [], [], signal));

    const finish = events.find((e) => e.type === 'finish');
    expect(finish && finish.type === 'finish' ? finish.stopReason : undefined).toBe('max_tokens');

    // 半截 tool_use:event 流不吐 tool_call(args 不可解析,adapter 直接丢)
    expect(events.some((e) => e.type === 'tool_call')).toBe(false);

    // sidecar 里也不能残留 tool_use —— 否则回放历史出现无配对 tool_use → 400
    const sidecar = events.find((e) => e.type === 'provider_sidecar');
    const blocks = ((sidecar as any)?.providerSidecarData?.anthropic?.contentBlocks ?? []) as Array<{ type: string }>;
    expect(blocks.some((b) => b.type === 'tool_use')).toBe(false);
  });

  test('end_turn with complete tool_use: unchanged behavior + finish=end_turn', async () => {
    mockFetchOnce(sseBody([
      { event: 'content_block_start', data: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu1', name: 'read_file' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"path":"/a.ts"}' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop' } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]));
    const events = await collect(provider().chatStream(undefined, [], [], signal));

    const tc = events.find((e) => e.type === 'tool_call');
    expect(tc && tc.type === 'tool_call' ? tc.name : '').toBe('read_file');
    const finish = events.find((e) => e.type === 'finish');
    expect(finish && finish.type === 'finish' ? finish.stopReason : undefined).toBe('tool_use');
    const sidecar = events.find((e) => e.type === 'provider_sidecar');
    const blocks = ((sidecar as any)?.providerSidecarData?.anthropic?.contentBlocks ?? []) as Array<{ type: string }>;
    expect(blocks.some((b) => b.type === 'tool_use')).toBe(true);
  });
});
