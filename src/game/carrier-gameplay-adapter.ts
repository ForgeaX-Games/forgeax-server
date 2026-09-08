import {
  projectRuntimeCarrierIdentity,
  type RuntimeCarrierIdentity,
  type RuntimeSnapshot,
} from '../runtime-carrier/supervisor';
import type { RuntimeScope } from '../runtime-carrier/supervisor';
import {
  gameplayFailure,
  identityFromRuntime,
  parseGameplayOperationRequest,
  sameGameplayIdentity,
  type GameplayIdentity,
  type GameplayOperationRequest,
  type GameplayOperationResult,
} from './gameplay-operation-contract';

export const SERVER_GAME_CARRIER_CONTRACT_VERSION = 'server-game-carrier/v1' as const;

export type CarrierRuntimeSnapshot = RuntimeSnapshot;
type JsonRecord = Record<string, unknown>;

export interface CarrierGameCandidate {
  readonly gameId: string;
  readonly scope: RuntimeScope;
}

export interface CarrierGameDiscovery {
  readonly version: typeof SERVER_GAME_CARRIER_CONTRACT_VERSION;
  readonly directEngine: false;
  readonly selectedGame: string | null;
  readonly candidates: readonly CarrierGameCandidate[];
  readonly scope: RuntimeScope | null;
  readonly readiness: 'unselected' | 'ready' | 'unavailable';
  readonly identity: RuntimeCarrierIdentity | null;
  readonly capabilities: readonly string[];
  readonly recoveryActions: readonly string[];
}

export interface CarrierBindingError {
  readonly code: string;
  readonly hint: string;
  readonly retryable: boolean;
  readonly expected: JsonRecord;
  readonly observed: JsonRecord;
  readonly recoveryActions: readonly string[];
}

export type CarrierBindingResult =
  | { readonly ok: true; readonly selectedGame: string; readonly scope: RuntimeScope; readonly identity: RuntimeCarrierIdentity | null }
  | { readonly ok: false; readonly error: CarrierBindingError };

export interface CarrierDispatchRequest {
  readonly method: string;
  readonly params: unknown;
  readonly gameId?: string;
  readonly timeoutMs?: number;
}

export interface CarrierGameplayAdapterOptions {
  readonly projectId: string;
  readonly listGames: () => readonly string[] | Promise<readonly string[]>;
  readonly readRuntime: () => CarrierRuntimeSnapshot | null;
  readonly dispatch: (request: JsonRecord) => Promise<JsonRecord>;
}

export interface CarrierGameplayAdapter {
  readonly discover: () => Promise<CarrierGameDiscovery>;
  readonly select: (gameId: string) => Promise<CarrierBindingResult>;
  readonly dispatch: (request: CarrierDispatchRequest) => Promise<JsonRecord | CarrierBindingResult>;
  readonly operate: (request: GameplayOperationRequest) => Promise<GameplayOperationResult>;
}

const CAPABILITIES = Object.freeze(['game.select', 'gameplay', 'carrier.identity']);
const RECOVERY_ACTIONS = Object.freeze(['carrier.discover', 'game.select', 'carrier.focus', 'request.retry', 'carrier.stop']);
const EDITOR_TRANSPORT_PROTOCOL_VERSION = 'editor-transport/v1' as const;

function scopeFor(projectId: string, gameId: string): RuntimeScope {
  return { projectId, gameId };
}

function error(
  code: string,
  hint: string,
  expected: JsonRecord,
  observed: JsonRecord,
  retryable = true,
): CarrierBindingResult {
  return {
    ok: false,
    error: { code, hint, retryable, expected, observed, recoveryActions: RECOVERY_ACTIONS },
  };
}

export function createCarrierGameplayAdapter(options: CarrierGameplayAdapterOptions): CarrierGameplayAdapter {
  let selectedGame: string | null = null;
  const inFlightMutations = new Set<string>();

  const candidates = async (): Promise<CarrierGameCandidate[]> => {
    const gameIds = await options.listGames();
    return gameIds.map((gameId) => ({ gameId, scope: scopeFor(options.projectId, gameId) }));
  };

  const identityForSelection = (gameId: string | null): RuntimeCarrierIdentity | null => {
    if (gameId === null) return null;
    const identity = projectRuntimeCarrierIdentity(options.readRuntime());
    return identity?.scope.projectId === options.projectId && identity.scope.gameId === gameId ? identity : null;
  };

  const discover = async (): Promise<CarrierGameDiscovery> => {
    const available = await candidates();
    const identity = identityForSelection(selectedGame);
    return {
      version: SERVER_GAME_CARRIER_CONTRACT_VERSION,
      directEngine: false,
      selectedGame,
      candidates: available,
      scope: selectedGame === null ? null : scopeFor(options.projectId, selectedGame),
      readiness: selectedGame === null ? 'unselected' : identity === null ? 'unavailable' : 'ready',
      identity,
      capabilities: CAPABILITIES,
      recoveryActions: RECOVERY_ACTIONS,
    };
  };

  const select = async (gameId: string): Promise<CarrierBindingResult> => {
    const available = (await candidates()).filter((candidate) => candidate.gameId === gameId);
    if (available.length === 0) return error(
      'game-not-found',
      `Game "${gameId}" is not an available explicit selection.`,
      { gameId, selection: 'explicit' },
      { candidates: (await candidates()).map((candidate) => candidate.gameId) },
      false,
    );
    if (available.length !== 1) return error(
      'game-selection-ambiguous',
      `Game "${gameId}" resolves to multiple candidates; selection was not changed.`,
      { gameId, candidates: 1 },
      { gameId, candidates: available.length },
      false,
    );
    selectedGame = gameId;
    return { ok: true, selectedGame, scope: available[0]!.scope, identity: identityForSelection(selectedGame) };
  };

  const dispatch = async (request: CarrierDispatchRequest): Promise<JsonRecord | CarrierBindingResult> => {
    if (selectedGame === null) return error(
      'game-selection-required',
      'Select one game before dispatching a carrier request.',
      { selection: 'explicit', gameId: 'required' },
      { selectedGame: null },
    );
    if (request.gameId !== undefined && request.gameId !== selectedGame) return error(
      'game-selection-mismatch',
      `The request game "${request.gameId}" does not match the selected game "${selectedGame}".`,
      { gameId: selectedGame },
      { gameId: request.gameId },
      false,
    );
    const wire: JsonRecord = {
      jsonrpc: '2.0',
      version: EDITOR_TRANSPORT_PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      scope: `game:${selectedGame}`,
      method: request.method,
      params: request.params,
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    };
    return options.dispatch(wire);
  };

  const operate = async (request: GameplayOperationRequest): Promise<GameplayOperationResult> => {
    const parsed = parseGameplayOperationRequest(request);
    if (!parsed.ok) return { ...parsed, error: { ...parsed.error, category: 'contract' } } as GameplayOperationResult;
    const value = parsed.value;
    if (selectedGame === null) return gameplayFailure({ requestId: value.requestId, operation: value.operation, code: 'game-selection-required', category: 'identity', hint: 'Select one game before dispatching gameplay.', retryable: true, expected: { selectedGame: value.scope.gameId }, observed: { selectedGame: null } });
    if (value.scope.projectId !== options.projectId || value.scope.gameId !== selectedGame) return gameplayFailure({ requestId: value.requestId, operation: value.operation, code: 'game-selection-mismatch', category: 'identity', hint: 'The operation scope does not match the selected game.', retryable: false, expected: { projectId: options.projectId, gameId: selectedGame }, observed: { scope: value.scope } });
    const runtimeIdentity = identityForSelection(selectedGame);
    if (runtimeIdentity === null) return gameplayFailure({ requestId: value.requestId, operation: value.operation, code: 'carrier-unavailable', category: 'transport', hint: 'The selected public carrier is not ready.', retryable: true, expected: { readiness: 'ready', gameId: selectedGame }, observed: { readiness: 'unavailable' } });
    const identity = identityFromRuntime(runtimeIdentity);
    if (value.identity !== undefined && !sameGameplayIdentity(value.identity, identity)) return gameplayFailure({ requestId: value.requestId, operation: value.operation, code: 'stale-or-mismatched-identity', category: 'provenance', hint: 'Rediscover the current carrier before using this operation identity.', retryable: false, expected: { identity }, observed: { identity: value.identity } });
    const mutation = value.operation === 'play' || value.operation === 'gameplayStop' || value.operation === 'input';
    if (mutation && inFlightMutations.has(value.requestId)) return gameplayFailure({ requestId: value.requestId, operation: value.operation, code: 'duplicate-in-flight-mutation', category: 'lifecycle', hint: 'Inspect the correlated request before retrying a mutation.', retryable: false, expected: { requestId: 'not-in-flight' }, observed: { requestId: value.requestId } });
    if (mutation) inFlightMutations.add(value.requestId);
    try {
      const wireResult = await dispatch({ method: 'gameplay', gameId: selectedGame, params: value });
      if ('ok' in wireResult && wireResult.ok === false) {
        const bindingError = wireResult.error as {
          readonly code?: unknown;
          readonly hint?: unknown;
          readonly retryable?: unknown;
          readonly expected?: unknown;
          readonly observed?: unknown;
        };
        return gameplayFailure({
          requestId: value.requestId,
          operation: value.operation,
          code: typeof bindingError.code === 'string' ? bindingError.code : 'carrier-dispatch-failed',
          category: 'transport',
          hint: typeof bindingError.hint === 'string' ? bindingError.hint : 'The carrier rejected the gameplay operation.',
          retryable: bindingError.retryable === true,
          expected: bindingError.expected !== null && typeof bindingError.expected === 'object' ? bindingError.expected as Record<string, unknown> : {},
          observed: bindingError.observed !== null && typeof bindingError.observed === 'object' ? bindingError.observed as Record<string, unknown> : {},
        });
      }
      const raw = wireResult as JsonRecord;
      if (raw.ok === false) return gameplayFailure({ requestId: value.requestId, operation: value.operation, code: typeof raw.code === 'string' ? raw.code : 'gameplay-operation-failed', category: 'transport', hint: typeof raw.hint === 'string' ? raw.hint : 'The carrier rejected the gameplay operation.', retryable: raw.retryable === true });
      const responseIdentity = raw.identity;
      if (!sameGameplayIdentity(responseIdentity as GameplayIdentity, identity)) return gameplayFailure({ requestId: value.requestId, operation: value.operation, code: 'provenance-mismatch', category: 'provenance', hint: 'The gameplay result did not come from the selected carrier.', retryable: false, expected: { identity }, observed: { identity: responseIdentity ?? null } });
      const data = raw.data !== null && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data as Record<string, unknown> : raw;
      return { ok: true, version: 'GameplayOperationResult/v1', requestId: value.requestId, operation: value.operation, identity, data };
    } catch (cause) {
      const observed = cause instanceof Error ? cause.message : String(cause);
      return gameplayFailure({ requestId: value.requestId, operation: value.operation, code: 'carrier-dispatch-failed', category: 'transport', hint: 'The carrier transport failed before a gameplay result was received; inspect correlated status before retrying.', retryable: true, expected: { result: 'GameplayOperationResult/v1' }, observed: { cause: observed } });
    } finally {
      if (mutation) inFlightMutations.delete(value.requestId);
    }
  };

  return { discover, select, dispatch, operate };
}
