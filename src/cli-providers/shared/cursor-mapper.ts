// Stateful translator: one cursor-agent ndjson event → 0..N ChatEvents.
//
// cursor-agent's `--output-format stream-json --stream-partial-output` wire is
// NOT the Anthropic stream_event/content_block_delta shape claude-code uses, so
// this is a dedicated mapper (schemas captured live, cursor-agent 2026.06.15).
// Event shapes:
//   {type:"system",subtype:"init",session_id,model,permissionMode}      → record session_id
//   {type:"user",message:{...}}                                          → ignore (echo)
//   {type:"assistant",message:{content:[{type:"text",text}]},timestamp_ms,model_call_id?} → token (see dedupe)
//   {type:"thinking",subtype:"delta",text}                               → thinking
//   {type:"thinking",subtype:"completed"}                                → ignore
//   {type:"tool_call",subtype:"started",call_id,tool_call:{<keyed>:{args}}}        → tool-call
//   {type:"tool_call",subtype:"completed",call_id,tool_call:{<keyed>:{result}}}    → tool-result
//   {type:"result",subtype:"success",is_error,result,usage,duration_ms}  → done | error
//
// ── assistant text dedupe (the central subtlety) ──
// With --stream-partial-output, assistant text arrives in THREE flavors:
//   • streaming delta       — has `timestamp_ms`, NO `model_call_id`
//   • per-model-call snapshot — has `model_call_id` (consolidates that call's deltas)
//   • final turn snapshot   — has NEITHER (full accumulated answer)
// Emitting a token for every assistant event would replay the whole answer 2x.
// Rule (verified live): emit a `token` ONLY when `timestamp_ms` is present AND
// `model_call_id` is absent. Drop the consolidated snapshots.

import type { ChatEvent } from '../types';

interface RawUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface CursorRawEvent {
  type: 'system' | 'user' | 'assistant' | 'thinking' | 'tool_call' | 'result' | string;
  subtype?: string;
  session_id?: string;
  // assistant
  message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
  model_call_id?: string;
  timestamp_ms?: number;
  // thinking
  text?: string;
  // tool_call
  call_id?: string;
  tool_call?: Record<string, unknown>;
  // result
  is_error?: boolean;
  result?: string;
  duration_ms?: number;
  usage?: RawUsage;
  [k: string]: unknown;
}

export interface MappedUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface CursorMapperState {
  sessionId?: string;
  doneEmitted: boolean;
  lastUsage?: MappedUsage;
}

export function createCursorMapperState(): CursorMapperState {
  return { sessionId: undefined, doneEmitted: false, lastUsage: undefined };
}

function captureUsage(state: CursorMapperState, raw: RawUsage | undefined): void {
  if (!raw) return;
  const cur: MappedUsage = state.lastUsage ?? {};
  if (typeof raw.inputTokens === 'number') cur.inputTokens = raw.inputTokens;
  if (typeof raw.outputTokens === 'number') cur.outputTokens = raw.outputTokens;
  if (typeof raw.cacheReadTokens === 'number') cur.cacheReadTokens = raw.cacheReadTokens;
  if (typeof raw.cacheWriteTokens === 'number') cur.cacheCreationTokens = raw.cacheWriteTokens;
  state.lastUsage = cur;
}

/** Map cursor's keyed tool-call type (e.g. "shellToolCall") to the display name
 *  the UI's tool chip expects (Bash/Edit/...), falling back to a PascalCase of
 *  the stripped prefix for tools we haven't special-cased. */
function toolDisplayName(keyed: string): string {
  const base = keyed.replace(/ToolCall$/, '');
  switch (base) {
    case 'shell':
      return 'Bash';
    case 'edit':
    case 'write':
      return 'Edit';
    case 'read':
      return 'Read';
    case 'search':
    case 'grep':
      return 'Grep';
    case 'mcp':
      return 'mcp';
    default:
      return base ? base.charAt(0).toUpperCase() + base.slice(1) : 'tool';
  }
}

/** First key on the tool_call object that looks like a "<x>ToolCall" envelope. */
function keyedToolEnvelope(tc: Record<string, unknown> | undefined): { keyed: string; body: Record<string, unknown> } | null {
  if (!tc || typeof tc !== 'object') return null;
  for (const k of Object.keys(tc)) {
    if (k.endsWith('ToolCall') && tc[k] && typeof tc[k] === 'object') {
      return { keyed: k, body: tc[k] as Record<string, unknown> };
    }
  }
  return null;
}

/** Flatten a tool result `{success:{...}} | {rejected:{...}} | {error:{...}}` to
 *  { ok, text }. shell→stdout, edit→message; rejected→reason. */
function flattenToolResult(result: unknown): { ok: boolean; text: string } {
  if (!result || typeof result !== 'object') return { ok: true, text: '' };
  const r = result as Record<string, any>;
  if (r.success && typeof r.success === 'object') {
    const s = r.success;
    const text =
      (typeof s.stdout === 'string' && s.stdout) ||
      (typeof s.message === 'string' && s.message) ||
      '';
    return { ok: true, text };
  }
  if (r.rejected && typeof r.rejected === 'object') {
    const reason = typeof r.rejected.reason === 'string' ? r.rejected.reason : 'rejected';
    return { ok: false, text: reason || 'rejected' };
  }
  if (r.error) {
    const text = typeof r.error === 'string' ? r.error : (r.error.message ?? 'error');
    return { ok: false, text };
  }
  return { ok: true, text: '' };
}

/** Translate one raw cursor ndjson event. Mutates `state`. Returns 0..N ChatEvents. */
export function mapCursorEvent(raw: CursorRawEvent, state: CursorMapperState): ChatEvent[] {
  const out: ChatEvent[] = [];

  if (typeof raw.session_id === 'string' && !state.sessionId) state.sessionId = raw.session_id;
  if (state.doneEmitted) return out;

  switch (raw.type) {
    case 'system':
    case 'user':
      return out;

    case 'assistant': {
      // Dedupe: only streaming deltas (timestamp_ms present, model_call_id
      // absent) carry NEW text; the per-call + final snapshots repeat it.
      if (typeof raw.timestamp_ms !== 'number' || raw.model_call_id) return out;
      const content = raw.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
            out.push({ type: 'token', text: block.text });
          }
        }
      }
      return out;
    }

    case 'thinking': {
      if (raw.subtype === 'delta' && typeof raw.text === 'string' && raw.text) {
        out.push({ type: 'thinking', text: raw.text });
      }
      return out;
    }

    case 'tool_call': {
      const env = keyedToolEnvelope(raw.tool_call);
      const callId = raw.call_id ?? '';
      if (!env || !callId) return out;
      if (raw.subtype === 'started') {
        const args = (env.body.args as unknown) ?? {};
        out.push({ type: 'tool-call', name: toolDisplayName(env.keyed), args, callId });
      } else if (raw.subtype === 'completed') {
        const { ok, text } = flattenToolResult(env.body.result);
        out.push(
          ok
            ? { type: 'tool-result', callId, ok: true, result: text }
            : { type: 'tool-result', callId, ok: false, error: text },
        );
      }
      return out;
    }

    case 'result': {
      captureUsage(state, raw.usage);
      if (raw.is_error || (raw.subtype && raw.subtype !== 'success')) {
        out.push({ type: 'error', message: raw.result || `cursor-agent exited with subtype=${raw.subtype ?? 'unknown'}` });
      } else {
        out.push({
          type: 'done',
          stopReason: 'end_turn',
          ...(typeof raw.duration_ms === 'number' ? { durationMs: raw.duration_ms } : {}),
          ...(state.lastUsage ? { usage: { ...state.lastUsage } } : {}),
        });
      }
      state.doneEmitted = true;
      return out;
    }

    default:
      return out; // tolerate unknown event types
  }
}

/** Drain a final 'done' if the stream ended without a `result` event. */
export function flushCursorMapper(state: CursorMapperState): ChatEvent[] {
  if (state.doneEmitted) return [];
  state.doneEmitted = true;
  return [{ type: 'done', stopReason: 'end_turn' }];
}
