// Stateful translator: one OpenAI Codex CLI (`codex exec --json`) ndjson
// event → 0..N ChatEvents. Sibling of claude-code-mapper.ts; sits on top of
// the shared subprocess-jsonl adapter.
//
// Real shapes emitted by codex-cli (verified live against 0.139, 2026-06-15;
// schema unchanged since the 0.130 capture):
//   {type:"thread.started", thread_id}                       → capture as sessionId
//   {type:"turn.started"}                                    → ignore
//   {type:"item.completed", item:{id,type:"agent_message",text}}  → token (full text)
//   {type:"item.completed", item:{id,type:"reasoning",text}} → thinking
//   {type:"item.completed", item:{type:"command_execution"|"local_shell_call"
//                                  |"function_call"|"mcp_call", ...}} → tool-call + tool-result
//   {type:"turn.completed", usage}                           → done
//   {type:"turn.failed", error:{message}}                    → error (TERMINAL)
//   {type:"error", message}                                  → NON-terminal (see below)
//
// codex exec --json does not currently stream incremental message.delta;
// the assistant text arrives as one item.completed{agent_message}. The older
// {message.delta / thinking.delta / tool_use*} cases below are kept for
// forward compatibility with future codex releases that may add streaming.
//
// ── Reconnect-error handling (2026-06-15) ───────────────────────────────────
// codex emits *repeated, non-fatal* `{type:"error", message:"Reconnecting...
// 2/5 ..."}` frames while a transient connection drops and retries. These are
// NOT terminal — the turn may still succeed. The route (api/cli/chat.ts) breaks
// its SSE loop on the first ChatEvent `error`, so mapping a reconnect notice to
// a terminal error would misreport a blip as a failed turn. Therefore the
// top-level `error` frame is captured into `state.lastError` (and logged) but
// produces NO ChatEvent and does NOT set doneEmitted. Real termination comes
// only from `turn.completed` (done) / `turn.failed` (error) / a non-zero exit
// code (the provider falls back to state.lastError there). Mirrors claude-code's
// "trust the terminal event, fall back to exit code" contract.
//
// Defensive: unknown event types pass through silently. The mapper is pure —
// call mapCodexEvent(raw, state) for each line, then flushCodexMapper at
// end-of-stream.

import type { ChatEvent } from '../types';

type ToolUseBuffer = { id: string; name: string; partialArgs: string };

export interface CodexMapperState {
  sessionId?: string;
  toolUseById: Map<string, ToolUseBuffer>;
  doneEmitted: boolean;
  /** Latest non-fatal `error` frame text (e.g. "Reconnecting... 2/5"). The
   *  provider surfaces it ONLY as a fallback when the stream ends without a
   *  terminal event and the subprocess exited non-zero. */
  lastError?: string;
}

export function createCodexMapperState(): CodexMapperState {
  return { sessionId: undefined, toolUseById: new Map(), doneEmitted: false, lastError: undefined };
}

export interface CodexRawEvent {
  type?: string;
  session_id?: string;
  thread_id?: string;
  // codex item shapes seen in the wild:
  //   {type:'agent_message', text}                                 → token
  //   {type:'reasoning', text}                                     → thinking
  //   {type:'command_execution', command, output, exit_code, id}   → tool-call + tool-result
  //   {type:'function_call', name, arguments, output, id}          → tool-call + tool-result
  //   {type:'local_shell_call', action, output, status, id}        → tool-call + tool-result
  //   {type:'mcp_call', tool_name, server, arguments, output, id}  → tool-call + tool-result
  item?: {
    id?: string;
    type?: string;
    text?: string;
    content?: Array<{ type?: string; text?: string }>;
    // Tool item fields (codex emits a flat shape on the item itself):
    name?: string;
    tool_name?: string;
    server?: string;
    arguments?: unknown;
    command?: string | string[];
    action?: { command?: string | string[]; type?: string };
    output?: unknown;
    exit_code?: number;
    status?: string;
    error?: string;
  };
  error?: { message?: string };
  usage?: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number; reasoning_output_tokens?: number };
  delta?: {
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
    text?: string;
    input_json_delta?: string;
  };
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  output?: unknown;
  is_error?: boolean;
  stop_reason?: string;
  message?: string;
  [k: string]: unknown;
}

function asText(content: Array<{ type?: string; text?: string }> | undefined): string {
  if (!content) return '';
  return content.map((c) => (c.type === 'text' ? c.text ?? '' : '')).join('');
}

function safeJSON(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

function mapStopReason(r: string | undefined): 'end_turn' | 'tool_use' | 'max_tokens' | 'cancelled' {
  switch (r) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
    case 'length':
      return 'max_tokens';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'end_turn';
  }
}

export function mapCodexEvent(raw: CodexRawEvent, state: CodexMapperState): ChatEvent[] {
  const out: ChatEvent[] = [];
  if (typeof raw.session_id === 'string' && !state.sessionId) state.sessionId = raw.session_id;
  // codex ships thread_id on thread.started — treat it as the session id so
  // consumers can correlate the turn with its codex log.
  if (typeof raw.thread_id === 'string' && !state.sessionId) state.sessionId = raw.thread_id;

  // After a turn-final event (turn.completed / turn.failed / message.completed)
  // any late events are stragglers — codex's ndjson stream sometimes ships a
  // trailing delta after the completion marker on cancel paths. Drop them so
  // consumers never see tokens *after* done.
  if (state.doneEmitted) return out;

  switch (raw.type) {
    case undefined:
    case 'session.created':
    case 'thread.started':
    case 'turn.started':
    case 'item.started':
    case 'message.start':
    case 'content_block.start':
      return out;

    case 'item.completed': {
      const item = raw.item;
      if (!item) return out;
      const itype = item.type ?? '';

      // codex emits its tool items ('command_execution' / 'function_call' /
      // 'local_shell_call' / 'mcp_call') through item.completed with no
      // streaming for the call/result pair (unlike claude-code which streams
      // via content_block_*). Recognize each type and emit a synthetic
      // tool-call followed by tool-result so the chip renders a call + a
      // result body the same way it does for claude-code. Prior behavior:
      // ANY non-reasoning item.completed was pushed as a single token —
      // burying tool calls in the text body.
      if (itype === 'command_execution' || itype === 'local_shell_call') {
        const id = item.id ?? `cmd-${state.toolUseById.size}`;
        const command = item.command ?? item.action?.command ?? '';
        const args = { command };
        const out_str =
          typeof item.output === 'string' ? item.output
          : item.output != null ? safeJSON(item.output) : '';
        const ok = item.exit_code === undefined ? item.status !== 'error' : item.exit_code === 0;
        out.push({ type: 'tool-call', name: 'Bash', args, callId: id });
        out.push(ok
          ? { type: 'tool-result', callId: id, ok: true, result: out_str }
          : { type: 'tool-result', callId: id, ok: false, error: item.error ?? out_str });
        return out;
      }
      if (itype === 'function_call') {
        const id = item.id ?? `fn-${state.toolUseById.size}`;
        let args: unknown = item.arguments ?? {};
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch { /* keep raw string */ }
        }
        const out_str =
          typeof item.output === 'string' ? item.output
          : item.output != null ? safeJSON(item.output) : '';
        out.push({ type: 'tool-call', name: item.name ?? 'function', args, callId: id });
        out.push({ type: 'tool-result', callId: id, ok: item.error == null, result: out_str, error: item.error });
        return out;
      }
      if (itype === 'mcp_call') {
        const id = item.id ?? `mcp-${state.toolUseById.size}`;
        let args: unknown = item.arguments ?? {};
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch { /* keep raw string */ }
        }
        const toolName = item.tool_name ?? item.name ?? 'mcp';
        const fqName = item.server ? `${item.server}:${toolName}` : toolName;
        const out_str =
          typeof item.output === 'string' ? item.output
          : item.output != null ? safeJSON(item.output) : '';
        out.push({ type: 'tool-call', name: fqName, args, callId: id });
        out.push({ type: 'tool-result', callId: id, ok: item.error == null, result: out_str, error: item.error });
        return out;
      }

      // Text-bearing items (agent_message / reasoning / etc).
      const itemText = item.text ?? asText(item.content);
      if (!itemText) return out;
      if (itype === 'reasoning' || itype === 'thinking') {
        out.push({ type: 'thinking', text: itemText });
      } else {
        out.push({ type: 'token', text: itemText });
      }
      return out;
    }

    case 'turn.completed': {
      if (state.doneEmitted) return out;
      out.push({ type: 'done', stopReason: 'end_turn' });
      state.doneEmitted = true;
      return out;
    }

    case 'turn.failed': {
      if (state.doneEmitted) return out;
      const msg = raw.error?.message ?? raw.message ?? state.lastError ?? 'codex turn failed';
      out.push({ type: 'error', message: String(msg) });
      state.doneEmitted = true;
      return out;
    }

    case 'message.delta': {
      const inline = raw.delta?.text;
      const text = inline ?? asText(raw.delta?.content);
      if (text) out.push({ type: 'token', text });
      return out;
    }

    case 'thinking.delta': {
      const text = raw.delta?.text ?? raw.text ?? '';
      if (text) out.push({ type: 'thinking', text });
      return out;
    }

    case 'tool_use':
    case 'tool_use.start': {
      const id = String(raw.id ?? '');
      const name = String(raw.name ?? 'tool');
      let initialArgs = '';
      if (raw.input !== undefined) {
        try { initialArgs = JSON.stringify(raw.input); } catch { /* ignore */ }
      }
      state.toolUseById.set(id, { id, name, partialArgs: initialArgs });
      return out;
    }

    case 'tool_use.delta': {
      const id = String(raw.id ?? '');
      const buf = state.toolUseById.get(id);
      if (buf && typeof raw.delta?.input_json_delta === 'string') {
        buf.partialArgs += raw.delta.input_json_delta;
      }
      return out;
    }

    case 'tool_use.completed':
    case 'tool_use.stop': {
      const id = String(raw.id ?? '');
      const buf = state.toolUseById.get(id);
      if (buf) {
        let args: unknown = {};
        try {
          args = buf.partialArgs ? JSON.parse(buf.partialArgs) : {};
        } catch {
          args = { _raw: buf.partialArgs };
        }
        out.push({ type: 'tool-call', name: buf.name, args, callId: buf.id });
        state.toolUseById.delete(id);
      }
      return out;
    }

    case 'tool_result': {
      const callId = String(raw.tool_use_id ?? '');
      const ok = raw.is_error !== true;
      const result =
        typeof raw.output === 'string' ? raw.output : raw.output != null ? JSON.stringify(raw.output) : undefined;
      out.push(
        ok
          ? { type: 'tool-result', callId, ok: true, result }
          : { type: 'tool-result', callId, ok: false, error: result ?? 'tool failed' },
      );
      return out;
    }

    case 'message.completed':
    case 'message.stop': {
      if (state.doneEmitted) return out;
      out.push({ type: 'done', stopReason: mapStopReason(raw.stop_reason) });
      state.doneEmitted = true;
      return out;
    }

    case 'error': {
      // NON-terminal: codex emits repeated `error` frames during transient
      // reconnects ("Reconnecting... 2/5"). Capture the latest message for the
      // provider's non-zero-exit fallback, but do NOT emit a ChatEvent and do
      // NOT mark done — that would let a blip break the SSE loop. Real failures
      // arrive as `turn.failed` or a non-zero subprocess exit.
      const msg = String(raw.message ?? raw.error?.message ?? 'codex emitted an error');
      state.lastError = msg;
      console.warn(`[codex] non-terminal error frame: ${msg}`);
      return out;
    }

    default:
      return out;
  }
}

export function flushCodexMapper(state: CodexMapperState): ChatEvent[] {
  if (state.doneEmitted) return [];
  state.doneEmitted = true;
  return [{ type: 'done', stopReason: 'end_turn' }];
}
