import type { HostToolSpec } from '@forgeax/orchestrator/seams';
import { MAX_EDITOR_TRANSPORT_TIMEOUT_MS } from './editor-transport-carrier';

export const EDITOR_TRANSPORT_VERSION = 'editor-transport/v1' as const;

const publicMethods: readonly string[] = Object.freeze([
  'discover',
  'transport.describe',
  'query',
  'gameplay',
  'run.dispatch',
  'run.get',
  'run.wait',
  'save',
  'reopen',
]);

/** Host method boundary only. Operation discovery and admission belong to the
 * connected page's capability registry; do not duplicate its operation IDs. */
export const EDITOR_TRANSPORT_PUBLIC_DISCOVERY = Object.freeze({
  version: EDITOR_TRANSPORT_VERSION,
  boundary: 'studio',
  baseUrl: 'http://localhost:18920',
  directEngine: false,
  methods: publicMethods,
  recoveryFields: Object.freeze(['code', 'category', 'phase', 'expected', 'observed', 'hint', 'safeRerun', 'firstFailure', 'teardown', 'recoveryActions']),
});

// Preserve the existing typed gameplay aliases without routing unknown
// gameplay-prefixed operations around the page's capability registry.
const gameplayOperationIds = new Set(['editor.gameplay.input', 'editor.gameplay.describe', 'editor.gameplay.projection']);

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
      'Call the versioned Editor transport in the connected Studio page. For live game input, state projections, or canvas capture, first call method "gameplay" with params {"version":1,"operation":"describe"}, then follow the returned live contract. For editing scene/assets, start with "discover" to read the page-owned capability manifest. For method "query", pass the projection object directly as params, for example {"kind":"assets.catalog"}; do not nest it under query or use the gameplay version/operation envelope. Use only the closed public methods and typed gameplay route. Omit scope to use the session game, or pass the canonical scope "game:<slug>"; the legacy "active-game" alias is resolved from the game-bound host context. To execute a discovered page operation, call run.dispatch with params {"operationId":"editor.game.select","input":{"slug":"gta-route-dev"}}. If the carrier is unavailable, call discover and retry only after a carrier is reported. Unsupported operations return a structured not-supported error. Do not use a relay eval endpoint.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: publicMethods },
        params: {
          type: 'object',
          properties: {
            kind: { type: 'string', description: 'For query, the page-owned projection kind. Put projection arguments alongside kind.' },
            operationId: { type: 'string', pattern: '^editor\\..+$' },
            input: { type: 'object' },
          },
          additionalProperties: true,
          description: 'For query, pass {"kind":"assets.catalog"} directly; additional fields follow the page projection contract. For run.dispatch, operationId is editor.<discovered-operation-id> and input is the operation input object.',
        },
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
      if (!method) return {
        ok: false,
        error: {
          code: 'invalid-args',
          expected: { method: 'non-empty public transport method' },
          observed: { method: args.method ?? null },
          hint: 'editor_transport requires a non-empty public method.',
          retryable: false,
          recoveryActions: ['transport.describe'],
        },
      };
      if (!publicMethods.includes(method)) return {
        ok: false,
        error: {
          code: 'not-supported',
          expected: { method: publicMethods },
          observed: { method },
          hint: 'Discover the connected Studio page and choose a method from its public capability inventory.',
          retryable: false,
          recoveryActions: ['transport.describe', 'editor.discover'],
        },
      };
      const timeoutMs = args.timeoutMs;
      if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_EDITOR_TRANSPORT_TIMEOUT_MS)) {
        return {
          ok: false,
          error: {
            code: 'invalid-args',
            expected: { timeoutMs: `integer from 1 to ${MAX_EDITOR_TRANSPORT_TIMEOUT_MS}` },
            observed: { timeoutMs },
            hint: `timeoutMs must be an integer from 1 to ${MAX_EDITOR_TRANSPORT_TIMEOUT_MS}.`,
            retryable: false,
            recoveryActions: ['transport.describe'],
          },
        };
      }
      const requestedScope = typeof args.scope === 'string' ? args.scope.trim() : '';
      const scope = requestedScope === 'active-game'
        ? ctx.game ? `game:${ctx.game}` : ''
        : requestedScope || (ctx.game ? `game:${ctx.game}` : '');
      const sessionId = typeof args.sessionId === 'string' && args.sessionId.trim()
        ? args.sessionId
        : ctx.sid ?? `host:${ctx.agentId}`;
      if (!scope) return {
        ok: false,
        error: {
          code: 'invalid-args',
          expected: { scope: 'explicit or game-bound' },
          observed: { scope: requestedScope || null },
          hint: requestedScope === 'active-game'
            ? 'The "active-game" scope alias requires a game-bound host context. Select a game, omit scope, or pass "game:<slug>".'
            : 'editor_transport requires scope or a game-bound host context.',
          retryable: false,
          recoveryActions: ['transport.describe', 'scope.select'],
        },
      };
      if (!deps.dispatch) return {
        ok: false,
        error: {
          code: 'editor-carrier-unavailable',
          expected: { scope, candidates: 1, authority: 'interactive' },
          observed: { scope, candidates: 0 },
          hint: 'No Studio Editor transport carrier is connected.',
          retryable: true,
          recoveryActions: ['editor.discover', 'request.retry'],
        },
      };
      const params = record(args.params) ?? {};
      if (method === 'run.dispatch') {
        const operationId = typeof params.operationId === 'string' ? params.operationId : '';
        if (!operationId.startsWith('editor.') || operationId.length === 'editor.'.length) return {
          ok: false,
          error: {
            code: operationId ? 'not-supported' : 'invalid-args',
            expected: { operationId: 'editor.<exact page-discovered operation id>', input: 'object' },
            observed: { operationId: operationId || null },
            hint: 'Use an exact editor-prefixed capability from the connected page discovery manifest.',
            retryable: false,
            recoveryActions: ['editor.discover'],
          },
        };
        // The page publishes and executes the same capability registry. Forward
        // its IDs unchanged (including camelCase) and preserve its structured
        // unavailable/unknown-operation and permission errors.
        if (params.input !== undefined && record(params.input) === null) return {
          ok: false,
          error: {
            code: 'invalid-args',
            expected: { input: 'object' },
            observed: { operationId, input: params.input },
            hint: 'run.dispatch input must be an object matching the discovered operation schema.',
            retryable: false,
            recoveryActions: ['editor.discover'],
          },
        };
      }
      const requestedOperationId = typeof params.operationId === 'string' ? params.operationId : '';
      const normalizedOperationId = requestedOperationId === 'editor.lifecycle.play'
        ? 'editor.play'
        : requestedOperationId === 'editor.lifecycle.stop'
          ? 'editor.stop'
          : requestedOperationId;
      if (method === 'gameplay' || (method === 'run.dispatch' && gameplayOperationIds.has(normalizedOperationId))) {
        return deps.dispatch({
          jsonrpc: '2.0',
          version: EDITOR_TRANSPORT_VERSION,
          id: id('editor-request', deps.idFactory),
          correlationId: id('editor-correlation', deps.idFactory),
          scope,
          method: 'gameplay',
          ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
          params: method === 'gameplay' ? params : record(params.input) ?? {},
        });
      }
      if (method === 'save' || method === 'reopen') {
        const input = record(params.input) ?? params;
        const requestId = typeof input.requestId === 'string' && input.requestId.trim() ? input.requestId : id(`${method}-request`, deps.idFactory);
        return deps.dispatch({
          jsonrpc: '2.0',
          version: EDITOR_TRANSPORT_VERSION,
          id: id('editor-request', deps.idFactory),
          correlationId: id('editor-correlation', deps.idFactory),
          scope,
          method,
          ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
          params: { requestId, ...(typeof input.sessionId === 'string' && input.sessionId.trim() ? { sessionId: input.sessionId } : {}) },
        });
      }
      if (method === 'query') {
        return deps.dispatch({
          jsonrpc: '2.0',
          version: EDITOR_TRANSPORT_VERSION,
          id: id('editor-request', deps.idFactory),
          correlationId: id('editor-correlation', deps.idFactory),
          scope,
          method,
          ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
          params: record(params.input) ?? params,
        });
      }
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
          ...(method === 'run.dispatch' ? { operationId: normalizedOperationId } : {}),
          scope,
          sessionId,
          actor: { id: ctx.agentId, kind: 'ai' },
          ...(typeof args.permission === 'string' ? { permission: args.permission } : {}),
        },
      });
    },
  }];
}
