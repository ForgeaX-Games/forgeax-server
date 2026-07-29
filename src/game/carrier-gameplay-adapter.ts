import { checkGameplayDependencyGate, type W1L1HEvidence } from './gameplay-dependency-gate';
import type { GameplayOperation, GameplayResponse, GameplayProvenance } from './gameplay-operation-contract';
import type { EnsureResult, RuntimeSnapshot, RuntimeScope, StatusResult } from '../runtime-carrier/types';
import { createGameplayCapture, type GameplayCaptureArtifact } from './gameplay-capture';

export interface CarrierGameplayGateway {
  execute(operation: GameplayOperation, identity: GameplayProvenance): Promise<unknown>;
}

export type GameplayCaptureGateway = CarrierGameplayGateway & { capture?: (identity: GameplayProvenance) => Promise<{ dataUrl: string; bytes: number }>; focus?: (identity: GameplayProvenance) => Promise<void> };

export interface CarrierGameplayAdapterDeps {
  dependencyEvidence: () => Partial<W1L1HEvidence> | undefined;
  supervisor: { ensure(scope: RuntimeScope): Promise<EnsureResult>; status(runtimeId: string): Promise<StatusResult> };
  gateway: GameplayCaptureGateway;
}

function identityOf(snapshot: RuntimeSnapshot): GameplayProvenance | null {
  const scope = snapshot.confirmedScope;
  if (!scope || !snapshot.pageIdentity || !snapshot.canvasIdentity || !snapshot.rendererIdentity) return null;
  // Heartbeat sentinel is a liveness counter, not a renderer generation. Use
  // the producer's stable generation suffix when available; the sentinel
  // fallback keeps synthetic/legacy host doubles compatible with the contract.
  const generation = /(?:^|-)generation-(\d+)$/.exec(snapshot.rendererIdentity)?.[1];
  return { runtimeId: snapshot.runtimeId, scope: scope as { projectId: string; gameId: string }, pageIdentity: snapshot.pageIdentity, canvasIdentity: snapshot.canvasIdentity, rendererGeneration: generation === undefined ? Number(snapshot.heartbeat?.sentinel ?? 0) : Number(generation) };
}

function failure(code: 'readiness-pending' | 'health-stale' | 'surface-unavailable' | 'identity-mismatch', message: string, readiness: 'pending' | 'stale' | 'unavailable' | undefined, identity?: GameplayProvenance): GameplayResponse {
  return { ok: false, error: { code, phase: 'ready', retryable: code !== 'identity-mismatch', message, hint: { action: code === 'identity-mismatch' ? 'capture-again' : 'status' }, ...(identity ? { identity } : {}), ...(readiness ? { readiness } : {}) } };
}

function isHealthStale(snapshot: RuntimeSnapshot): boolean {
  return snapshot.liveness === 'unreachable' && snapshot.lastFailure?.code === 'HEALTH_STALE';
}

export class CarrierGameplayAdapter {
  constructor(private readonly deps: CarrierGameplayAdapterDeps) {}

  async execute(operation: GameplayOperation): Promise<GameplayResponse> {
    const gate = checkGameplayDependencyGate(this.deps.dependencyEvidence());
    if (!gate.ok) return gate;
    const ensured = await this.deps.supervisor.ensure(operation.scope);
    if (!ensured.ok) return { ok: false, error: { code: 'surface-unavailable', phase: 'ensure', retryable: ensured.error.retryable, message: ensured.error.message, hint: { action: 'status' }, readiness: 'unavailable' } };
    const first = identityOf(ensured);
    if (isHealthStale(ensured)) return failure('health-stale', 'The managed carrier heartbeat is stale.', 'stale', first ?? undefined);
    if (!first || ensured.lifecycle !== 'running' || ensured.liveness !== 'alive') return failure('surface-unavailable', 'The managed carrier surface is unavailable.', 'unavailable', first ?? undefined);
    if (ensured.renderReadiness !== 'ready') return failure(ensured.renderReadiness === 'pending' ? 'readiness-pending' : 'surface-unavailable', 'The managed carrier is not ready for gameplay.', ensured.renderReadiness, first);
    const latest = await this.deps.supervisor.status(ensured.runtimeId);
    if (!latest.ok) return failure('surface-unavailable', 'The managed carrier status is unavailable.', 'unavailable', first);
    const second = identityOf(latest);
    if (isHealthStale(latest)) return failure('health-stale', 'The managed carrier heartbeat is stale.', 'stale', second ?? first);
    if (!second || JSON.stringify(first) !== JSON.stringify(second) || latest.renderReadiness !== 'ready' || latest.liveness !== 'alive') return failure('identity-mismatch', 'Carrier identity changed before gameplay dispatch.', 'unavailable', second ?? first);
    if (operation.operation === 'capture' && this.deps.gateway.capture) {
      const capture = createGameplayCapture({ produce: () => this.deps.gateway.capture!(second), focus: () => this.deps.gateway.focus?.(second) ?? Promise.resolve() });
      const artifact = await capture.produce(second);
      return { ok: true, operation: operation.operation, state: 'running', identity: second, data: artifact };
    }
    if (operation.operation === 'reveal' && 'artifact' in operation) {
      const capture = createGameplayCapture({ produce: async () => ({ dataUrl: '', bytes: 0 }), focus: () => this.deps.gateway.focus?.(second) ?? Promise.resolve() });
      const result = await capture.reveal(operation.artifact as GameplayCaptureArtifact, second);
      if (!result.ok) return result as GameplayResponse;
      return { ok: true, operation: 'reveal', state: 'running', identity: second };
    }
    const result = await this.deps.gateway.execute(operation, second);
    if (result && typeof result === 'object' && 'ok' in result && (result as { ok?: unknown }).ok === false) {
      const failed = result as { error?: { code?: unknown; hint?: unknown } };
      const code = typeof failed.error?.code === 'string' ? failed.error.code : 'operation-failed';
      const hint = typeof failed.error?.hint === 'string' ? failed.error.hint : 'Inspect carrier status and retry the operation.';
      return {
        ok: false,
        error: {
          code: 'operation-failed',
          phase: 'dispatch',
          retryable: code !== 'operation-unsupported',
          message: `Gameplay operation failed (${code}).`,
          hint: { action: 'status' },
          identity: second,
          readiness: 'ready',
          detail: { code, hint },
        },
      };
    }
    const value = result && typeof result === 'object' && 'ok' in result && (result as { ok?: unknown }).ok === true && 'value' in result
      ? (result as { value: unknown }).value
      : result;
    if (operation.operation === 'capture' && result && typeof result === 'object' && 'dataUrl' in result) {
      return { ok: true, operation: operation.operation, state: 'running', identity: second, data: { ...(result as object), provenance: second } };
    }
    return { ok: true, operation: operation.operation, state: operation.operation === 'gameplayStop' ? 'stopped' : 'running', identity: second, ...(value === undefined ? {} : { data: value }) };
  }
}
