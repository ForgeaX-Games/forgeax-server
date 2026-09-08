import type { RuntimeCarrierIdentity } from '../runtime-carrier/supervisor';

export const GAMEPLAY_OPERATION_CONTRACT_VERSION = 'GameplayOperationRequest/v1' as const;
export const GAMEPLAY_OPERATION_RESULT_VERSION = 'GameplayOperationResult/v1' as const;
export const CARRIER_STOP_OPERATION = 'carrier.stop' as const;

export type GameplayOperation = 'play' | 'gameplayStop' | 'input' | 'query' | 'capture' | 'logs' | 'frames';

export interface GameplayScope {
  readonly projectId: string;
  readonly gameId: string;
}

export interface GameplayIdentity {
  readonly carrierId: string;
  readonly runtimeId: string;
  readonly scope: GameplayScope;
  readonly pageIdentity: string;
  readonly canvasIdentity: string;
  readonly rendererIdentity: string;
  readonly rendererGeneration: number;
}

interface GameplayRequestBase {
  readonly version: 1;
  readonly requestId: string;
  readonly scope: GameplayScope;
  readonly identity?: GameplayIdentity;
}

export type GameplayOperationRequest =
  | (GameplayRequestBase & { readonly operation: 'play' | 'gameplayStop' | 'capture' | 'logs' | 'frames'; readonly windowId?: string })
  | (GameplayRequestBase & { readonly operation: 'input'; readonly action: Record<string, unknown> })
  | (GameplayRequestBase & { readonly operation: 'query'; readonly query: string });

export interface GameplayOperationError {
  readonly code: string;
  readonly category: 'contract' | 'identity' | 'lifecycle' | 'transport' | 'provenance';
  readonly hint: string;
  readonly retryable: boolean;
  readonly expected: Record<string, unknown>;
  readonly observed: Record<string, unknown>;
  readonly recoveryActions: readonly string[];
}

export type GameplayOperationResult =
  | {
    readonly ok: true;
    readonly version: typeof GAMEPLAY_OPERATION_RESULT_VERSION;
    readonly requestId: string;
    readonly operation: GameplayOperation;
    readonly identity: GameplayIdentity;
    readonly data: Record<string, unknown>;
  }
  | {
    readonly ok: false;
    readonly version: typeof GAMEPLAY_OPERATION_RESULT_VERSION;
    readonly requestId: string;
    readonly operation: GameplayOperation | null;
    readonly error: GameplayOperationError;
  };

export interface ParsedGameplayRequest {
  readonly ok: true;
  readonly value: GameplayOperationRequest;
}

export interface InvalidGameplayRequest {
  readonly ok: false;
  readonly error: GameplayOperationError;
}

const RECOVERY_ACTIONS = Object.freeze(['carrier.discover', 'game.select', 'carrier.focus', 'request.inspect', 'request.retry', 'carrier.stop']);
const OPERATIONS = new Set<GameplayOperation>(['play', 'gameplayStop', 'input', 'query', 'capture', 'logs', 'frames']);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function fail(code: string, hint: string, expected: Record<string, unknown>, observed: Record<string, unknown>): InvalidGameplayRequest {
  return {
    ok: false,
    error: {
      code,
      category: 'contract',
      hint,
      retryable: false,
      expected,
      observed,
      recoveryActions: RECOVERY_ACTIONS,
    },
  };
}

function validIdentity(value: unknown): value is GameplayIdentity {
  const candidate = record(value);
  const scope = candidate === null ? null : record(candidate.scope);
  return candidate !== null
    && scope !== null
    && typeof candidate.carrierId === 'string'
    && typeof candidate.runtimeId === 'string'
    && typeof scope.projectId === 'string'
    && typeof scope.gameId === 'string'
    && typeof candidate.pageIdentity === 'string'
    && typeof candidate.canvasIdentity === 'string'
    && typeof candidate.rendererIdentity === 'string'
    && typeof candidate.rendererGeneration === 'number'
    && Number.isInteger(candidate.rendererGeneration)
    && candidate.rendererGeneration >= 0;
}

export function identityFromRuntime(identity: RuntimeCarrierIdentity): GameplayIdentity {
  return {
    carrierId: identity.carrierId,
    runtimeId: identity.runtimeId,
    scope: { projectId: identity.scope.projectId, gameId: identity.scope.gameId ?? '' },
    pageIdentity: identity.pageIdentity,
    canvasIdentity: identity.canvasIdentity,
    rendererIdentity: identity.rendererIdentity,
    rendererGeneration: identity.rendererGeneration,
  };
}

export function sameGameplayIdentity(left: GameplayIdentity, right: GameplayIdentity): boolean {
  return left.carrierId === right.carrierId
    && left.runtimeId === right.runtimeId
    && left.scope.projectId === right.scope.projectId
    && left.scope.gameId === right.scope.gameId
    && left.pageIdentity === right.pageIdentity
    && left.canvasIdentity === right.canvasIdentity
    && left.rendererIdentity === right.rendererIdentity
    && left.rendererGeneration === right.rendererGeneration;
}

export function parseGameplayOperationRequest(input: unknown): ParsedGameplayRequest | InvalidGameplayRequest {
  const value = record(input);
  if (value === null) return fail('malformed-envelope', 'Gameplay requests must be JSON objects.', { type: 'object' }, { type: Array.isArray(input) ? 'array' : typeof input });
  const scope = record(value.scope);
  const operation = value.operation;
  if (value.version !== 1 || typeof value.requestId !== 'string' || !value.requestId.trim() || scope === null || typeof scope.projectId !== 'string' || !scope.projectId.trim() || typeof scope.gameId !== 'string' || !scope.gameId.trim() || typeof operation !== 'string' || !OPERATIONS.has(operation as GameplayOperation)) {
    return fail('malformed-envelope', 'Gameplay requests require version 1, requestId, scope, and a published operation.', { version: 1, operation: [...OPERATIONS] }, { version: value.version ?? null, operation: operation ?? null, requestId: value.requestId ?? null, scope: value.scope ?? null });
  }
  if (value.identity !== undefined && !validIdentity(value.identity)) return fail('malformed-identity', 'Identity must contain the complete carrier, runtime, page, canvas, and renderer generation.', { identity: 'GameplayIdentity/v1' }, { identity: value.identity });
  const allowedKeys = new Set(['version', 'requestId', 'scope', 'operation', ...(value.identity === undefined ? [] : ['identity'])]);
  if (operation === 'input') allowedKeys.add('action');
  if (operation === 'query') allowedKeys.add('query');
  if (operation === 'capture' || operation === 'logs' || operation === 'frames') allowedKeys.add('windowId');
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) return fail('unknown-field', 'Gameplay requests reject fields outside the published public contract.', { allowedKeys: [...allowedKeys].sort() }, { unknownKeys });
  if (operation === 'input' && (record(value.action) === null || Object.keys(value.action as object).length === 0)) return fail('malformed-input', 'Input requires a non-empty canonical action object.', { action: 'object' }, { action: value.action ?? null });
  if (operation === 'query' && (typeof value.query !== 'string' || !value.query.trim())) return fail('malformed-query', 'Query requires a published read identifier.', { query: 'non-empty string' }, { query: value.query ?? null });
  if ((operation === 'logs' || operation === 'frames' || operation === 'capture') && value.windowId !== undefined && (typeof value.windowId !== 'string' || !value.windowId.trim())) return fail('malformed-window', 'Evidence operations require a non-empty windowId when supplied.', { windowId: 'non-empty string' }, { windowId: value.windowId ?? null });
  return { ok: true, value: value as unknown as GameplayOperationRequest };
}

export function gameplayFailure(input: {
  readonly requestId: string;
  readonly operation?: GameplayOperation | null;
  readonly code: string;
  readonly category: GameplayOperationError['category'];
  readonly hint: string;
  readonly retryable: boolean;
  readonly expected?: Record<string, unknown>;
  readonly observed?: Record<string, unknown>;
}): GameplayOperationResult {
  return {
    ok: false,
    version: GAMEPLAY_OPERATION_RESULT_VERSION,
    requestId: input.requestId,
    operation: input.operation ?? null,
    error: {
      code: input.code,
      category: input.category,
      hint: input.hint,
      retryable: input.retryable,
      expected: input.expected ?? {},
      observed: input.observed ?? {},
      recoveryActions: RECOVERY_ACTIONS,
    },
  };
}

export function carrierStopIsNotGameplay(operation: string): boolean {
  return operation === CARRIER_STOP_OPERATION;
}
