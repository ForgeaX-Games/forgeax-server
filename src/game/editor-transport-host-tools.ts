import type { HostToolSpec } from '@forgeax/orchestrator/orchestration-seams';

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
      'Call the versioned Editor transport in the connected Studio page. Start with method "discover", use "query" for canonical editor facts, and use "run.dispatch" with an idempotencyKey for a mutation. The result preserves the typed result/error envelope; do not send JavaScript or use a relay eval endpoint.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', minLength: 1 },
        params: { type: 'object' },
        scope: { type: 'string', minLength: 1 },
        sessionId: { type: 'string', minLength: 1 },
        permission: { enum: ['read', 'write', 'execute'] },
      },
      required: ['method'],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const method = typeof args.method === 'string' ? args.method.trim() : '';
      if (!method) return { ok: false, error: { code: 'invalid-args', hint: 'editor_transport requires a non-empty method.' } };
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
