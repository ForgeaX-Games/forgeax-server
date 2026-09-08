import { sameGameplayIdentity, type GameplayIdentity } from './gameplay-operation-contract';

export const GAMEPLAY_CAPTURE_CONTRACT_VERSION = 'GameplayEvidence/v1' as const;

export interface RawLogWindow {
  readonly version: typeof GAMEPLAY_CAPTURE_CONTRACT_VERSION;
  readonly windowId: string;
  readonly identity: GameplayIdentity;
  readonly entries: readonly unknown[];
  readonly startIndex: number;
  readonly endIndexExclusive: number;
  readonly totalEntries: number;
  readonly truncated: boolean;
  readonly continuationToken: string | null;
}

export interface FrameSample {
  readonly atMs: number;
  readonly durationMs: number;
}

export interface FrameStatistics {
  readonly version: typeof GAMEPLAY_CAPTURE_CONTRACT_VERSION;
  readonly windowId: string;
  readonly identity: GameplayIdentity;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly durationMs: number;
  readonly sampleCount: number;
  readonly averageFrameMs: number;
  readonly fps: number;
  readonly samples: readonly FrameSample[];
}

export interface CaptureDiagnosticFailure {
  readonly ok: false;
  readonly error: {
    readonly code: 'invalid-window' | 'invalid-frame-window' | 'identity-mismatch';
    readonly hint: string;
    readonly retryable: boolean;
    readonly expected: Record<string, unknown>;
    readonly observed: Record<string, unknown>;
    readonly recoveryActions: readonly string[];
  };
}

export type RawLogWindowResult = { readonly ok: true; readonly value: RawLogWindow } | CaptureDiagnosticFailure;
export type FrameStatisticsResult = { readonly ok: true; readonly value: FrameStatistics } | CaptureDiagnosticFailure;

const RECOVERY_ACTIONS = Object.freeze(['carrier.discover', 'carrier.focus', 'evidence.continue', 'evidence.restart', 'carrier.stop']);

function failure(
  code: CaptureDiagnosticFailure['error']['code'],
  hint: string,
  expected: Record<string, unknown>,
  observed: Record<string, unknown>,
): CaptureDiagnosticFailure {
  return { ok: false, error: { code, hint, retryable: code !== 'identity-mismatch', expected, observed, recoveryActions: RECOVERY_ACTIONS } };
}

export function createBoundedRawLogWindow(input: {
  readonly windowId: string;
  readonly identity: GameplayIdentity;
  readonly entries: readonly unknown[];
  readonly startIndex?: number;
  readonly limit?: number;
}): RawLogWindowResult {
  const startIndex = input.startIndex ?? 0;
  const limit = input.limit ?? 100;
  if (!input.windowId.trim() || !Number.isInteger(startIndex) || startIndex < 0 || !Number.isInteger(limit) || limit < 1 || startIndex > input.entries.length) return failure('invalid-window', 'A bounded log window requires a valid windowId, start index, and positive limit.', { windowId: 'non-empty', startIndex: '0..totalEntries', limit: 'positive integer' }, { windowId: input.windowId, startIndex, limit, totalEntries: input.entries.length });
  const endIndexExclusive = Math.min(input.entries.length, startIndex + limit);
  const truncated = endIndexExclusive < input.entries.length;
  return {
    ok: true,
    value: {
      version: GAMEPLAY_CAPTURE_CONTRACT_VERSION,
      windowId: input.windowId,
      identity: input.identity,
      entries: input.entries.slice(startIndex, endIndexExclusive),
      startIndex,
      endIndexExclusive,
      totalEntries: input.entries.length,
      truncated,
      continuationToken: truncated ? `${input.windowId}:${endIndexExclusive}` : null,
    },
  };
}

export function aggregatePositiveDurationFrames(input: {
  readonly windowId: string;
  readonly identity: GameplayIdentity;
  readonly samples: readonly FrameSample[];
}): FrameStatisticsResult {
  if (!input.windowId.trim() || input.samples.length < 2 || input.samples.some((sample) => !Number.isFinite(sample.atMs) || !Number.isFinite(sample.durationMs) || sample.durationMs <= 0)) return failure('invalid-frame-window', 'Frame statistics require at least two positive-duration samples.', { windowId: 'non-empty', samples: 'at least two', durationMs: 'positive finite number' }, { windowId: input.windowId, sampleCount: input.samples.length, samples: input.samples });
  const startedAtMs = Math.min(...input.samples.map((sample) => sample.atMs));
  const endedAtMs = Math.max(...input.samples.map((sample) => sample.atMs + sample.durationMs));
  const durationMs = endedAtMs - startedAtMs;
  if (!(durationMs > 0)) return failure('invalid-frame-window', 'Frame statistics require a positive-duration evidence window.', { durationMs: '> 0' }, { startedAtMs, endedAtMs, durationMs });
  const totalFrameMs = input.samples.reduce((total, sample) => total + sample.durationMs, 0);
  const averageFrameMs = totalFrameMs / input.samples.length;
  return {
    ok: true,
    value: {
      version: GAMEPLAY_CAPTURE_CONTRACT_VERSION,
      windowId: input.windowId,
      identity: input.identity,
      startedAtMs,
      endedAtMs,
      durationMs,
      sampleCount: input.samples.length,
      averageFrameMs,
      fps: 1000 / averageFrameMs,
      samples: [...input.samples],
    },
  };
}

export function assertSameCarrierDiagnostics(input: {
  readonly expected: GameplayIdentity;
  readonly query: GameplayIdentity;
  readonly capture: GameplayIdentity;
  readonly logs: GameplayIdentity;
  readonly frames: GameplayIdentity;
}): { readonly ok: true } | CaptureDiagnosticFailure {
  const identities = { query: input.query, capture: input.capture, logs: input.logs, frames: input.frames };
  for (const [source, identity] of Object.entries(identities)) {
    if (!sameGameplayIdentity(input.expected, identity)) return failure('identity-mismatch', 'Semantic, visual, log, and frame evidence must come from one carrier identity.', { identity: input.expected }, { source, identity });
  }
  return { ok: true };
}
