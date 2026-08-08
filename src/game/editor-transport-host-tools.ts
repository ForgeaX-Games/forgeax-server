import type { HostToolSpec } from '@forgeax/orchestrator/orchestration-seams';
import { MAX_EDITOR_TRANSPORT_TIMEOUT_MS } from './editor-transport-carrier';

export const EDITOR_TRANSPORT_VERSION = 'editor-transport/v1' as const;

type TransportRequest = Record<string, unknown>;
type DispatchTransport = (request: TransportRequest) => Promise<unknown>;

export interface EditorTransportHostToolsDeps {
  readonly dispatch?: DispatchTransport;
  readonly idFactory?: () => string;
}

function id(prefix: string, factory?: () => string): string {
  return factory?.() ?? `${prefix}-${crypto.randomUUID()}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Project the typed Editor transport into the agent host-tool surface. */
export function editorTransportHostTools(deps: EditorTransportHostToolsDeps = {}): HostToolSpec[] {
  return [{
    name: 'editor_transport',
    description:
      'Call the versioned Editor transport in the connected Studio page. Start with "discover", use "query" for canonical facts, "run.dispatch" for one mutation, or "script.execute" for operation-scope JavaScript that composes gateway/query/_import. Scripts require execute permission and an idempotencyKey; they never receive raw world/renderer/assets. Do not use a relay eval endpoint.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', minLength: 1 },
        params: { type: 'object' },
        scope: { type: 'string', minLength: 1 },
        sessionId: { type: 'string', minLength: 1 },
        permission: { enum: ['read', 'write', 'execute'] },
        timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_EDITOR_TRANSPORT_TIMEOUT_MS },
      },
      required: ['method'],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const method = typeof args.method === 'string' ? args.method.trim() : '';
      if (!method) return { ok: false, error: { code: 'invalid-args', hint: 'editor_transport requires a non-empty method.' } };
      const timeoutMs = args.timeoutMs;
      if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_EDITOR_TRANSPORT_TIMEOUT_MS)) {
        return { ok: false, error: { code: 'invalid-args', hint: `timeoutMs must be an integer from 1 to ${MAX_EDITOR_TRANSPORT_TIMEOUT_MS}.` } };
      }
      const scope = typeof args.scope === 'string' && args.scope.trim()
        ? args.scope
        : ctx.game ? `game:${ctx.game}` : '';
      const sessionId = typeof args.sessionId === 'string' && args.sessionId.trim()
        ? args.sessionId
        : ctx.sid ?? `host:${ctx.agentId}`;
      if (!scope) return { ok: false, error: { code: 'invalid-args', hint: 'editor_transport requires scope or a game-bound host context.' } };
      if (!deps.dispatch) return {
        ok: false,
        error: {
          code: 'editor-carrier-unavailable',
          hint: 'No Studio Editor transport carrier is connected.',
          retryable: true,
          recoveryActions: ['editor.discover', 'request.retry'],
        },
      };
      const params = record(args.params) ?? {};
      return deps.dispatch({
        jsonrpc: '2.0',
        version: EDITOR_TRANSPORT_VERSION,
        id: id('editor-request', deps.idFactory),
        correlationId: id('editor-correlation', deps.idFactory),
        scope,
        method,
        ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
        params: {
          ...params,
          scope,
          sessionId,
          actor: { id: ctx.agentId, kind: 'ai' },
          ...(typeof args.permission === 'string' ? { permission: args.permission } : {}),
        },
      });
    },
  }];
}
