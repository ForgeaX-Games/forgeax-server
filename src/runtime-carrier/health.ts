import type {
  RenderReadiness,
  RuntimeLiveness,
  RuntimeScope,
  RuntimeFailureStage,
} from './types';

export type CarrierHealthMessageType =
  | 'VAG_CARRIER_HANDSHAKE'
  | 'VAG_CARRIER_HEARTBEAT'
  | 'VAG_CARRIER_FAILURE';

export interface CarrierHealthFailure {
  readonly code: string;
  readonly stage: Extract<RuntimeFailureStage, 'handshake' | 'heartbeat' | 'renderer' | 'device-lost' | 'uncaptured-error'>;
  readonly retryable: boolean;
  readonly hint: string;
  readonly at: string;
  readonly message?: string;
}

export interface CarrierHealthObservation {
  readonly runtimeId: string | null;
  readonly challengeResponse: string | null;
  readonly confirmedScope: RuntimeScope | null;
  readonly pageNonce: string;
  readonly pageIdentity: string;
  readonly canvasIdentity: string;
  readonly rendererIdentity: string;
  readonly rendererGeneration?: number;
  readonly sentinel: number;
  readonly liveness: RuntimeLiveness;
  readonly renderReadiness: RenderReadiness;
  readonly failure: CarrierHealthFailure | null;
}

const CARRIER_TYPES: ReadonlySet<string> = new Set([
  'VAG_CARRIER_HANDSHAKE',
  'VAG_CARRIER_HEARTBEAT',
  'VAG_CARRIER_FAILURE',
]);

const LIVENESS: ReadonlySet<string> = new Set(['alive', 'unreachable', 'terminated']);
const READINESS: ReadonlySet<string> = new Set(['pending', 'ready', 'unavailable']);
const FAILURE_STAGES: ReadonlySet<string> = new Set([
  'handshake',
  'heartbeat',
  'renderer',
  'device-lost',
  'uncaptured-error',
]);

export function parseCarrierHealthMessage(value: unknown): CarrierHealthObservation | null {
  if (!isRecord(value) || typeof value.type !== 'string' || !CARRIER_TYPES.has(value.type)) return null;
  if (!isRecord(value.payload) || value.payload.version !== 1) return null;

  const payload = value.payload;
  const runtimeId = payload.runtimeId === null ? null : nonEmptyString(payload.runtimeId);
  const challengeResponse = payload.challengeResponse === null || payload.challengeResponse === undefined
    ? null
    : nonEmptyString(payload.challengeResponse) ?? null;
  const pageNonce = nonEmptyString(payload.pageNonce);
  const pageIdentity = nonEmptyString(payload.pageIdentity);
  const canvasIdentity = nonEmptyString(payload.canvasIdentity);
  const rendererIdentity = nonEmptyString(payload.rendererIdentity);
  const rendererGeneration = payload.rendererGeneration === null ? undefined : payload.rendererGeneration;
  const sentinel = payload.sentinel;
  const liveness = payload.liveness;
  const renderReadiness = payload.renderReadiness;
  if (runtimeId === undefined || (payload.challengeResponse !== null && payload.challengeResponse !== undefined && !challengeResponse) || !pageNonce || !pageIdentity || !canvasIdentity || !rendererIdentity) return null;
  if (rendererGeneration !== undefined && (typeof rendererGeneration !== 'number' || !Number.isInteger(rendererGeneration) || rendererGeneration < 0)) return null;
  if (typeof sentinel !== 'number' || !Number.isInteger(sentinel) || sentinel < 0) return null;
  if (typeof liveness !== 'string' || !LIVENESS.has(liveness)) return null;
  if (typeof renderReadiness !== 'string' || !READINESS.has(renderReadiness)) return null;

  const failure = parseFailure(payload.failure);
  if (value.type.endsWith('FAILURE') && !failure) return null;
  if (payload.failure !== null && payload.failure !== undefined && !failure) return null;

  const confirmedScope = parseScope(payload.scope);
  if (confirmedScope === undefined) return null;

  return {
    runtimeId,
    challengeResponse,
    confirmedScope,
    pageNonce,
    pageIdentity,
    canvasIdentity,
    rendererIdentity,
    ...(rendererGeneration === undefined ? {} : { rendererGeneration }),
    sentinel,
    liveness: liveness as RuntimeLiveness,
    renderReadiness: renderReadiness as RenderReadiness,
    failure,
  };
}

export function isCarrierHealthMessage(value: unknown): value is { type: CarrierHealthMessageType; payload: unknown } {
  return parseCarrierHealthMessage(value) !== null;
}

export const parseRuntimeCarrierHealth = parseCarrierHealthMessage;

function parseScope(value: unknown): RuntimeScope | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const projectId = nonEmptyString(value.projectId);
  const gameId = value.gameId === null ? null : nonEmptyString(value.gameId);
  if (!projectId || gameId === undefined) return undefined;
  return { projectId, gameId };
}

function parseFailure(value: unknown): CarrierHealthFailure | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return null;
  const code = nonEmptyString(value.code);
  const stage = nonEmptyString(value.stage);
  const hint = nonEmptyString(value.hint);
  const at = nonEmptyString(value.at);
  if (!code || !stage || !hint || !at || !FAILURE_STAGES.has(stage) || typeof value.retryable !== 'boolean') return null;
  const message = value.message === undefined ? undefined : nonEmptyString(value.message);
  if (value.message !== undefined && !message) return null;
  return {
    code,
    stage: stage as CarrierHealthFailure['stage'],
    retryable: value.retryable,
    hint,
    at,
    message,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
