import {
  GAMEPLAY_BRIDGE_VERSION,
  sameGameplayIdentity,
  type GameplayError,
  type GameplayHint,
  type GameplayOperation,
  type GameplayProvenance,
  type GameplayResponse,
} from './gameplay-operation-contract';
import type { EnsureResult, RuntimeSnapshot, RuntimeScope, StatusResult } from '../runtime-carrier/types';
import { validateGameplayCaptureArtifact } from './gameplay-capture';

export interface CarrierGameplayGateway {
  execute(request: {
    version: typeof GAMEPLAY_BRIDGE_VERSION;
    operation: GameplayOperation;
    identity: GameplayProvenance;
  }): Promise<unknown>;
}

export interface CarrierGameplayAdapterDeps {
  supervisor: { ensure(scope: RuntimeScope): Promise<EnsureResult>; status(runtimeId: string): Promise<StatusResult> };
  gateway: CarrierGameplayGateway;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface GameplayExecuteOptions {
  signal?: AbortSignal;
}

function identityOf(snapshot: RuntimeSnapshot): GameplayProvenance | null {
  const scope = snapshot.confirmedScope;
  if (!scope || typeof scope.gameId !== 'string' || !snapshot.pageIdentity || !snapshot.canvasIdentity || typeof snapshot.rendererGeneration !== 'number') return null;
  if (!Number.isInteger(snapshot.rendererGeneration) || snapshot.rendererGeneration < 0) return null;
  return {
    runtimeId: snapshot.runtimeId,
    scope: { projectId: scope.projectId, gameId: scope.gameId },
    pageIdentity: snapshot.pageIdentity,
    canvasIdentity: snapshot.canvasIdentity,
    rendererGeneration: snapshot.rendererGeneration,
  };
}

function appError(input: Pick<GameplayError, 'code' | 'phase' | 'retryable' | 'message' | 'hint'> & Partial<Pick<GameplayError, 'identity' | 'readiness' | 'details'>>): GameplayResponse {
  return { ok: false, error: { owner: 'application', ...input } };
}

function carrierError(snapshot: RuntimeSnapshot | undefined, phase: GameplayError['phase'], fallbackCode: string, fallbackMessage: string, fallbackRetryable: boolean): GameplayResponse {
  const failure = snapshot?.lastFailure;
  return {
    ok: false,
    error: {
      owner: 'carrier',
      code: failure?.code ?? fallbackCode,
      phase,
      retryable: failure?.retryable ?? fallbackRetryable,
      message: failure?.message ?? fallbackMessage,
      hint: { action: 'status' },
      ...(snapshot ? { details: { runtimeId: snapshot.runtimeId, lifecycle: snapshot.lifecycle, liveness: snapshot.liveness, readiness: snapshot.renderReadiness, carrierHint: failure?.hint } } : {}),
    },
  };
}

function isReady(snapshot: RuntimeSnapshot): boolean {
  return snapshot.lifecycle === 'running' && snapshot.liveness === 'alive' && snapshot.renderReadiness === 'ready';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function identityFrom(value: unknown): GameplayProvenance | null {
  if (!isRecord(value) || typeof value.runtimeId !== 'string' || !isRecord(value.scope) || typeof value.scope.projectId !== 'string' || typeof value.scope.gameId !== 'string' || typeof value.pageIdentity !== 'string' || typeof value.canvasIdentity !== 'string' || typeof value.rendererGeneration !== 'number' || !Number.isInteger(value.rendererGeneration) || value.rendererGeneration < 0) return null;
  return {
    runtimeId: value.runtimeId,
    scope: { projectId: value.scope.projectId, gameId: value.scope.gameId },
    pageIdentity: value.pageIdentity,
    canvasIdentity: value.canvasIdentity,
    rendererGeneration: value.rendererGeneration,
  };
}

function isGameplayPhase(value: unknown): value is GameplayError['phase'] {
  return value === 'dependency' || value === 'ensure' || value === 'ready' || value === 'dispatch' || value === 'capture' || value === 'reveal';
}

function isGameplayHint(value: unknown): value is GameplayHint {
  return isRecord(value) && typeof value.action === 'string';
}

function normalizeProducerFailure(value: Record<string, unknown>, identity: GameplayProvenance, operation: GameplayOperation): GameplayResponse {
  const raw = isRecord(value.error) ? value.error : {};
  const details = raw.details ?? raw.detail;
  return {
    ok: false,
    error: {
      owner: typeof raw.owner === 'string' && raw.owner.length > 0 ? raw.owner as GameplayError['owner'] : 'producer',
      code: typeof raw.code === 'string' && raw.code.length > 0 ? raw.code : 'operation-failed',
      phase: isGameplayPhase(raw.phase) ? raw.phase : operation.operation === 'capture' ? 'capture' : operation.operation === 'reveal' ? 'reveal' : 'dispatch',
      retryable: typeof raw.retryable === 'boolean' ? raw.retryable : true,
      message: typeof raw.message === 'string' && raw.message.length > 0 ? raw.message : 'The Editor gameplay producer rejected the operation.',
      hint: isGameplayHint(raw.hint) ? raw.hint : { action: 'status' },
      identity,
      readiness: 'ready',
      ...(details === undefined ? {} : { details }),
    },
  };
}

function normalizeTransportException(error: unknown, identity: GameplayProvenance): GameplayResponse {
  return {
    ok: false,
    error: {
      owner: 'transport',
      code: 'transport-exception',
      phase: 'dispatch',
      retryable: true,
      message: error instanceof Error ? error.message : 'The gameplay transport threw an unknown error.',
      hint: { action: 'status' },
      identity,
      readiness: 'ready',
      details: { name: error instanceof Error ? error.name : typeof error },
    },
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('The gameplay operation was aborted.', 'AbortError'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('The gameplay operation was aborted.', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export class CarrierGameplayAdapter {
  private readonly waitTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(private readonly deps: CarrierGameplayAdapterDeps) {
    this.waitTimeoutMs = deps.waitTimeoutMs ?? 15_000;
    this.pollIntervalMs = deps.pollIntervalMs ?? 25;
  }

  async execute(operation: GameplayOperation, options: GameplayExecuteOptions = {}): Promise<GameplayResponse> {
    const ensured = await this.deps.supervisor.ensure(operation.scope);
    if (!ensured.ok) return carrierError(undefined, 'ensure', ensured.error.code, ensured.error.message, ensured.error.retryable);

    const ready = await this.waitForReady(ensured, operation.scope, options.signal);
    if (!('snapshot' in ready)) return ready;
    const first = identityOf(ready.snapshot);
    if (!first) return appError({ code: 'surface-unavailable', phase: 'ready', retryable: false, message: 'The carrier did not publish a numeric renderer generation and complete identity.', hint: { action: 'status' }, readiness: 'unavailable' });

    const latest = await this.deps.supervisor.status(ready.snapshot.runtimeId);
    if (!latest.ok) return carrierError(ready.snapshot, 'ready', latest.error.code, latest.error.message, latest.error.retryable);
    if (latest.confirmedScope && (latest.confirmedScope.projectId !== operation.scope.projectId || latest.confirmedScope.gameId !== operation.scope.gameId)) {
      return carrierError(latest, 'ready', 'SCOPE_MISMATCH', 'The carrier scope changed before gameplay dispatch.', false);
    }
    const second = identityOf(latest);
    if (!second || !isReady(latest)) return carrierError(latest, 'ready', 'surface-unavailable', 'The carrier became unavailable before gameplay dispatch.', true);
    const match = sameGameplayIdentity(first, second);
    if (!match.matches) return appError({ code: 'identity-mismatch', phase: 'ready', retryable: false, message: 'Carrier identity changed before gameplay dispatch.', hint: { action: 'capture-again' }, identity: second, readiness: latest.renderReadiness, details: { mismatches: match.mismatches } });

    if (operation.operation === 'reveal') {
      const artifact = validateGameplayCaptureArtifact(operation.artifact, second);
      if (!artifact.ok) return artifact;
    }

    const request = { version: GAMEPLAY_BRIDGE_VERSION, operation, identity: second } as const;
    let result: unknown;
    try {
      result = await this.deps.gateway.execute(request);
    } catch (error) {
      return normalizeTransportException(error, second);
    }
    if (!isRecord(result)) return normalizeTransportException(new Error('The Editor gameplay producer returned a malformed response.'), second);
    if (result.ok === false) return normalizeProducerFailure(result, second, operation);
    if (result.ok !== true) return normalizeTransportException(new Error('The Editor gameplay producer returned a response without an ok discriminator.'), second);
    const observed = identityFrom(result.identity);
    if (!observed) return normalizeTransportException(new Error('The Editor gameplay producer returned no complete identity.'), second);
    const afterMatch = sameGameplayIdentity(second, observed);
    if (!afterMatch.matches) return appError({ code: 'identity-mismatch', phase: operation.operation === 'capture' ? 'capture' : operation.operation === 'reveal' ? 'reveal' : 'dispatch', retryable: false, message: 'The Editor producer changed carrier identity during gameplay dispatch.', hint: { action: 'capture-again' }, identity: observed, readiness: 'ready', details: { mismatches: afterMatch.mismatches } });
    if (operation.operation === 'capture') {
      const artifact = validateGameplayCaptureArtifact(result.data, observed);
      if (!artifact.ok) return artifact;
    }
    return {
      ok: true,
      operation: operation.operation,
      state: operation.operation === 'gameplayStop' ? 'stopped' : 'running',
      identity: observed,
      ...(result.data === undefined ? {} : { data: result.data }),
    };
  }

  private async waitForReady(ensured: Extract<EnsureResult, { ok: true }>, scope: RuntimeScope, signal?: AbortSignal): Promise<{ ok: true; snapshot: RuntimeSnapshot } | GameplayResponse> {
    const deadline = Date.now() + this.waitTimeoutMs;
    let current: RuntimeSnapshot = ensured;
    while (true) {
      if (signal?.aborted) return appError({ code: 'operation-aborted', phase: 'ready', retryable: true, message: 'Gameplay readiness wait was aborted.', hint: { action: 'status' }, readiness: 'pending', details: { runtimeId: current.runtimeId } });
      if (current.confirmedScope && (current.confirmedScope.projectId !== scope.projectId || current.confirmedScope.gameId !== scope.gameId)) return carrierError(current, 'ready', 'SCOPE_MISMATCH', 'The carrier confirmed a different gameplay scope.', false);
      if (current.lastFailure?.code === 'PAGE_RELOADED' || current.lastFailure?.code === 'HEALTH_STALE') return carrierError(current, 'ready', current.lastFailure.code, current.lastFailure.message, current.lastFailure.retryable);
      if (current.lifecycle === 'stopping' || current.lifecycle === 'stopped' || current.lifecycle === 'failed' || current.liveness !== 'alive' || current.renderReadiness === 'unavailable') return carrierError(current, 'ready', 'surface-unavailable', 'The carrier stopped or became unavailable while waiting for readiness.', true);
      if (isReady(current) && identityOf(current)) return { ok: true, snapshot: current };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return appError({ code: 'readiness-timeout', phase: 'ready', retryable: true, message: 'The carrier did not become ready before the bounded wait expired.', hint: { action: 'status' }, readiness: current.renderReadiness, details: { runtimeId: current.runtimeId, timeoutMs: this.waitTimeoutMs } });
      try {
        await sleep(Math.min(this.pollIntervalMs, remaining), signal);
      } catch {
        return appError({ code: 'operation-aborted', phase: 'ready', retryable: true, message: 'Gameplay readiness wait was aborted.', hint: { action: 'status' }, readiness: 'pending', details: { runtimeId: current.runtimeId } });
      }
      const next = await this.deps.supervisor.status(current.runtimeId);
      if (!next.ok) return carrierError(current, 'ready', next.error.code, next.error.message, next.error.retryable);
      current = next;
    }
  }
}
