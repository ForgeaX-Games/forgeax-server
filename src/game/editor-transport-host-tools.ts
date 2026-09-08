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

interface PublicSchema {
  readonly type: 'object';
  readonly properties: Record<string, unknown>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

interface PublicOperation {
  readonly id: string;
  readonly availability: 'page-owned';
  readonly unsupportedCode: 'not-supported';
  readonly inputSchema: PublicSchema;
  readonly outputSchema: PublicSchema;
}

function objectSchema(properties: Record<string, unknown> = {}, required: readonly string[] = []): PublicSchema {
  return {
    type: 'object',
    properties,
    ...(required.length === 0 ? {} : { required }),
    additionalProperties: false,
  };
}

function publicOperation(id: string, inputSchema: PublicSchema, outputSchema: PublicSchema): PublicOperation {
  return { id, availability: 'page-owned', unsupportedCode: 'not-supported', inputSchema, outputSchema };
}

const identitySchema = objectSchema({
  runtimeId: { type: 'string', minLength: 1 },
  pageIdentity: { type: 'string', minLength: 1 },
  canvasIdentity: { type: 'string', minLength: 1 },
  rendererGeneration: { type: 'integer', minimum: 0 },
});

/** Closed, public Studio discovery metadata. The page remains the capability SSOT. */
export const EDITOR_TRANSPORT_PUBLIC_DISCOVERY = Object.freeze({
  version: EDITOR_TRANSPORT_VERSION,
  boundary: 'studio',
  baseUrl: 'http://localhost:18920',
  directEngine: false,
  methods: publicMethods,
  recoveryFields: Object.freeze(['code', 'category', 'phase', 'expected', 'observed', 'hint', 'safeRerun', 'firstFailure', 'teardown', 'recoveryActions']),
  operations: Object.freeze([
    publicOperation('game.select', objectSchema({ slug: { type: 'string', minLength: 1 } }, ['slug']), objectSchema({ slug: { type: 'string', minLength: 1 }, available: { type: 'boolean' }})),
    publicOperation('persistence.save', objectSchema({ requestId: { type: 'string', minLength: 1 } }, ['requestId']), objectSchema({ status: { type: 'string' }, path: { type: 'string' }})),
    publicOperation('persistence.fresh-read', objectSchema({ sessionId: { type: 'string', minLength: 1 } }, ['sessionId']), objectSchema({ value: { type: 'object' }, identity: identitySchema })),
    publicOperation('play', objectSchema({ dirtyPolicy: { enum: ['last-saved', 'save-then-play', 'cancel'] } }), objectSchema({ status: { type: 'string' }, identity: identitySchema })),
    publicOperation('stop', objectSchema(), objectSchema({ status: { type: 'string' }, identity: identitySchema })),
    // Compatibility aliases retained for agents that learned the pre-runtime
    // host inventory. They are normalized to the page-owned operation ids
    // before crossing the carrier.
    publicOperation('lifecycle.play', objectSchema(), objectSchema({ status: { type: 'string' }, identity: identitySchema })),
    publicOperation('lifecycle.stop', objectSchema(), objectSchema({ status: { type: 'string' }, identity: identitySchema })),
    publicOperation('gameplay.input', objectSchema({ version: { type: 'integer', const: 1 }, operation: { const: 'input' }, action: { type: 'object' } }, ['version', 'operation', 'action']), objectSchema({ ok: { type: 'boolean' }, identity: identitySchema })),
    publicOperation('gameplay.describe', objectSchema({ version: { type: 'integer', const: 1 }, operation: { const: 'describe' } }, ['version', 'operation']), objectSchema({
      ok: { type: 'boolean' },
      data: {
        type: 'object',
        properties: {
          version: { type: 'integer', const: 1 },
          operations: { type: 'array', items: { type: 'object' } },
          projections: {
            type: 'object',
            properties: {
              actions: { type: 'array', items: { type: 'object' } },
              reads: { type: 'array', items: { type: 'object' } },
            },
            required: ['actions', 'reads'],
            additionalProperties: false,
          },
        },
        required: ['version', 'operations', 'projections'],
        additionalProperties: false,
      },
    }, ['ok', 'data'])),
    publicOperation('gameplay.projection', objectSchema({ version: { type: 'integer', const: 1 }, operation: { const: 'query' }, query: { type: 'string', minLength: 1 } }, ['version', 'operation', 'query']), objectSchema({ ok: { type: 'boolean' }, data: { type: 'object' }, identity: identitySchema })),
    publicOperation('carrier.identity', objectSchema(), objectSchema({ identity: identitySchema, carrierId: { type: 'string', minLength: 1 } }, ['identity'])),
    publicOperation('evidence.logs', objectSchema({ windowId: { type: 'string', minLength: 1 } }, ['windowId']), objectSchema({ windowId: { type: 'string' }, entries: { type: 'array' }, identity: identitySchema })),
    publicOperation('evidence.capture', objectSchema({ windowId: { type: 'string', minLength: 1 } }, ['windowId']), objectSchema({ windowId: { type: 'string' }, artifact: { type: 'object' }, identity: identitySchema })),
    publicOperation('evidence.trace', objectSchema({ windowId: { type: 'string', minLength: 1 } }, ['windowId']), objectSchema({ windowId: { type: 'string' }, events: { type: 'array' }, identity: identitySchema })),
    publicOperation('evidence.performance', objectSchema({ windowId: { type: 'string', minLength: 1 } }, ['windowId']), objectSchema({ windowId: { type: 'string' }, metrics: { type: 'object' }, identity: identitySchema })),
    publicOperation('evidence.diagnostics', objectSchema({ windowId: { type: 'string', minLength: 1 } }, ['windowId']), objectSchema({ windowId: { type: 'string' }, diagnostics: { type: 'array' }, identity: identitySchema })),
  ]),
});

const publicOperationIds = new Set(EDITOR_TRANSPORT_PUBLIC_DISCOVERY.operations.map((operation) => operation.id));

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
      'Call the versioned Editor transport in the connected Studio page. Start with "discover" to read the page-owned capability manifest, then use only the closed public methods and typed gameplay route. Omit scope to use the session game, or pass the canonical scope "game:<slug>"; the legacy "active-game" alias is resolved from the game-bound host context. To execute a discovered page operation, call run.dispatch with params {"operationId":"editor.game.select","input":{"slug":"gta-route-dev"}}. If the carrier is unavailable, call discover and retry only after a carrier is reported. Unsupported operations return a structured not-supported error. Do not use a relay eval endpoint.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: publicMethods },
        params: {
          type: 'object',
          properties: {
            operationId: { type: 'string', pattern: '^editor\\.[a-z0-9]+(?:[.-][a-z0-9]+)*$' },
            input: { type: 'object' },
          },
          additionalProperties: true,
          description: 'For run.dispatch, operationId is editor.<discovered-operation-id> and input is the operation input object.',
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
        const operation = operationId.startsWith('editor.') ? operationId.slice('editor.'.length) : '';
        if (!publicOperationIds.has(operation)) {
          // 权威列表就在宿主手里(publicOperationIds 由 EDITOR_TRANSPORT_PUBLIC_DISCOVERY
          // 派生),上面那个 method 校验也照实回了 publicMethods —— 只有这里回占位符
          // `editor.<operation from discover>`,把 agent 打发去 discover。代价实测过:
          // 2026-08-24,forge 与 audio-designer 都猜了 `editor.play`(真名
          // `editor.lifecycle.play`,只差一个命名段),两个都没去 discover;同一个猜测
          // 重复两次就撞上断路器,一趟已经做完九成音频活的 run 被整轮终止。
          // 知道答案就直接说出来,近似命中还要点名 —— 一次回执换一次纠正,不用往返。
          const suffix = operation.split('.').pop() ?? '';
          const ids = [...publicOperationIds].map((id) => `editor.${id}`);
          const near = suffix ? ids.filter((id) => id.split('.').pop() === suffix) : [];
          return {
            ok: false,
            error: {
              code: operationId ? 'not-supported' : 'invalid-args',
              expected: { operationId: ids, input: 'object' },
              observed: { operationId: operationId || null, input: params.input ?? null },
              ...(near.length ? { didYouMean: near } : {}),
              hint: (near.length ? `Unknown operation — did you mean ${near.join(' / ')}? ` : 'Unknown operation. ')
                + 'Dispatch one of the exact ids listed in expected.operationId. Do not repeat this identifier:'
                + ' guessing it again is what trips the repeated-failure breaker and ends the turn.',
              retryable: false,
              recoveryActions: ['editor.discover'],
            },
          };
        }
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
      const dispatchedOperation = normalizedOperationId.startsWith('editor.')
        ? normalizedOperationId.slice('editor.'.length)
        : '';
      if (method === 'run.dispatch' && dispatchedOperation.startsWith('gameplay.')) {
        return deps.dispatch({
          jsonrpc: '2.0',
          version: EDITOR_TRANSPORT_VERSION,
          id: id('editor-request', deps.idFactory),
          correlationId: id('editor-correlation', deps.idFactory),
          scope,
          method: 'gameplay',
          ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
          params: record(params.input) ?? {},
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
