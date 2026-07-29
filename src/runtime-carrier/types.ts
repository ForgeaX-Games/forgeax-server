export type RuntimeLifecycle = 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';
export type RuntimeLiveness = 'alive' | 'unreachable' | 'terminated';
export type RenderReadiness = 'pending' | 'ready' | 'unavailable';
export type RuntimeAction = 'ensure' | 'status' | 'reveal' | 'stop';
export type RuntimeFailureStage =
  | 'ensure'
  | 'status'
  | 'reveal'
  | 'stop'
  | 'shutdown'
  | 'handshake'
  | 'heartbeat'
  | 'renderer'
  | 'device-lost'
  | 'uncaptured-error';

export type RuntimeErrorCode =
  | 'SCOPE_CONFLICT'
  | 'SCOPE_UNCONFIRMED'
  | 'SCOPE_MISMATCH'
  | 'SCOPE_DRIFT'
  | 'REVEAL_UNSUPPORTED'
  | 'RUNTIME_STARTING'
  | 'RUNTIME_STOPPING'
  | 'RUNTIME_FAILED'
  | 'RUNTIME_NOT_ACTIVE'
  | 'STOPPED_DURING_START'
  | 'UNKNOWN_RUNTIME'
  | 'HOST_START_FAILED'
  | 'HANDSHAKE_RUNTIME_MISMATCH'
  | 'HANDSHAKE_OWNERSHIP_MISMATCH'
  | 'PAGE_RELOADED'
  | 'HEALTH_STALE'
  | 'HOST_REVEAL_FAILED'
  | 'HOST_STOP_FAILED'
  | 'SUPERVISOR_SHUTDOWN'
  | 'device-lost'
  | 'uncaptured-error'
  | 'limit-exceeded'
  | (string & {});

export interface RuntimeScope {
  readonly projectId: string;
  readonly gameId: string | null;
}

export interface RuntimeFailure {
  readonly code: RuntimeErrorCode;
  readonly stage: RuntimeFailureStage;
  readonly retryable: boolean;
  readonly hint: string;
  readonly at: string;
  readonly message: string;
  readonly runtimeId?: string;
  readonly requestedScope?: RuntimeScope;
  readonly occupyingScope?: RuntimeScope | null;
}

export interface RuntimeSnapshot {
  readonly runtimeId: string;
  readonly lifecycle: RuntimeLifecycle;
  readonly liveness: RuntimeLiveness;
  readonly renderReadiness: RenderReadiness;
  readonly confirmedScope: RuntimeScope | null;
  readonly lastFailure: RuntimeFailure | null;
  readonly pageNonce?: string;
  readonly pageIdentity?: string;
  readonly canvasIdentity?: string;
  readonly rendererIdentity?: string;
  readonly heartbeat?: {
    readonly sentinel: number;
    readonly at: string;
  };
}

export interface RuntimeActionSuccess<Action extends RuntimeAction = RuntimeAction> extends RuntimeSnapshot {
  readonly ok: true;
  readonly action: Action;
}

export interface RuntimeActionFailure<Action extends RuntimeAction = RuntimeAction> {
  readonly ok: false;
  readonly action: Action;
  readonly error: RuntimeFailure;
}

export type RuntimeActionResult<Action extends RuntimeAction = RuntimeAction> = RuntimeActionSuccess<Action> | RuntimeActionFailure<Action>;
export type EnsureResult = RuntimeActionResult<'ensure'>;
export type StatusResult = RuntimeActionResult<'status'>;
export type RevealResult = RuntimeActionResult<'reveal'>;
export type StopResult = RuntimeActionResult<'stop'>;

export interface CarrierHostStartInput {
  readonly runtimeId: string;
  readonly scope: RuntimeScope;
  readonly ownerToken: string;
  readonly signal: AbortSignal;
}

export interface CarrierHostObservation {
  readonly runtimeId?: string | null;
  readonly challengeResponse?: string | null;
  readonly confirmedScope: RuntimeScope | null;
  readonly liveness?: RuntimeLiveness;
  readonly renderReadiness?: RenderReadiness;
  readonly pageNonce?: string;
  readonly pageIdentity?: string;
  readonly canvasIdentity?: string;
  readonly rendererIdentity?: string;
  readonly sentinel?: number;
  readonly at?: string;
  readonly lastFailure?: RuntimeFailure | null;
}

export interface CarrierHostHandle extends CarrierHostObservation {
  readonly reveal: () => Promise<void>;
  readonly stop: () => Promise<void>;
  /**
   * Typed transport into the already-managed page. The supervisor still owns
   * lifecycle and identity; gameplay calls are delegated to the page's
   * existing Editor Gateway and never become a second runtime owner.
   */
  readonly gameplay?: CarrierGameplayTransport;
  readonly observe?: () => Promise<CarrierHostObservation>;
}

export interface CarrierGameplayTransport {
  execute(operation: unknown): Promise<unknown>;
  capture(): Promise<{ dataUrl: string; bytes: number }>;
  focus(): Promise<void>;
}

export interface CarrierHost {
  readonly supportsReveal: boolean;
  readonly start: (input: CarrierHostStartInput) => Promise<CarrierHostHandle>;
}
