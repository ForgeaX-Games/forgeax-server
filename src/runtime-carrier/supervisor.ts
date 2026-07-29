import {
  errorForAction,
  runtimeFailure,
} from './errors';
import type { CarrierHealthObservation } from './health';
import type {
  CarrierHost,
  CarrierHostHandle,
  CarrierHostObservation,
  CarrierGameplayTransport,
  EnsureResult,
  RevealResult,
  RuntimeActionFailure,
  RuntimeActionSuccess,
  RuntimeFailure,
  RuntimeLifecycle,
  RuntimeScope,
  RuntimeSnapshot,
  StatusResult,
  StopResult,
} from './types';

export type {
  CarrierHost,
  CarrierHostHandle,
  CarrierHostObservation,
  CarrierHostStartInput,
  EnsureResult,
  RenderReadiness,
  RevealResult,
  RuntimeAction,
  RuntimeActionFailure,
  RuntimeActionResult,
  RuntimeActionSuccess,
  RuntimeErrorCode,
  RuntimeFailure,
  RuntimeFailureStage,
  RuntimeLiveness,
  RuntimeLifecycle,
  RuntimeScope,
  RuntimeSnapshot,
  StatusResult,
  StopResult,
} from './types';

const unsupportedHost: CarrierHost = {
  supportsReveal: false,
  async start(): Promise<CarrierHostHandle> {
    throw new Error('No reveal-capable carrier host is installed');
  },
};

interface SupervisorOptions {
  readonly host?: CarrierHost;
  readonly healthStaleMs?: number;
}

interface ActiveRuntime {
  readonly runtimeId: string;
  readonly requestedScope: RuntimeScope;
  readonly ownerToken: string;
  readonly abortController: AbortController;
  lifecycle: RuntimeLifecycle;
  liveness: RuntimeSnapshot['liveness'];
  renderReadiness: RuntimeSnapshot['renderReadiness'];
  confirmedScope: RuntimeScope | null;
  lastFailure: RuntimeFailure | null;
  pageNonce?: string;
  pageIdentity?: string;
  canvasIdentity?: string;
  rendererIdentity?: string;
  rendererGeneration?: number;
  heartbeat?: { sentinel: number; at: string };
  host?: CarrierHostHandle;
  stopRequested: boolean;
  startPromise?: Promise<EnsureResult>;
  stopPromise?: Promise<StopResult>;
}

export class RuntimeCarrierSupervisor {
  readonly #host: CarrierHost;
  readonly #healthStaleMs: number;
  readonly #terminals = new Map<string, RuntimeSnapshot>();
  #active: ActiveRuntime | null = null;
  #queue: Promise<void> = Promise.resolve();
  #shuttingDown = false;

  constructor(options: SupervisorOptions = {}) {
    this.#host = options.host ?? unsupportedHost;
    this.#healthStaleMs = options.healthStaleMs ?? 1_500;
  }

  ensure(scope: RuntimeScope): Promise<EnsureResult> {
    if (this.#shuttingDown) {
      return Promise.resolve(this.#failure('ensure', 'SUPERVISOR_SHUTDOWN', {
        retryable: true,
        hint: 'Create a new supervisor after service startup completes.',
        message: 'The runtime carrier supervisor is shutting down.',
      }));
    }
    const active = this.#active;
    if (active?.lifecycle === 'stopping') {
      return Promise.resolve(this.#failure('ensure', 'RUNTIME_STOPPING', {
        retryable: true,
        hint: 'Wait for the active runtime to reach stopped, then call ensure again.',
        message: 'The active runtime is stopping.',
        runtimeId: active.runtimeId,
        requestedScope: scope,
        occupyingScope: active.confirmedScope ?? active.requestedScope,
      }));
    }
    return this.#ensureSerialized(scope);
  }

  async status(runtimeId: string): Promise<StatusResult> {
    const active = this.#active;
    if (!active && !this.#terminals.has(runtimeId)) {
      return this.#failure('status', 'UNKNOWN_RUNTIME', {
        retryable: true,
        hint: 'Call ensure with the desired scope; this supervisor does not adopt old runtimes.',
        message: 'The runtimeId is not managed by this supervisor.',
        runtimeId,
      });
    }
    const current = this.#find(runtimeId);
    if (!current) return this.#failure('status', 'UNKNOWN_RUNTIME', {
      retryable: true,
      hint: 'Call ensure with the desired scope; this supervisor does not adopt old runtimes.',
      message: 'The runtimeId is not managed by this supervisor.',
      runtimeId,
    });
    if (isActiveRuntime(current)) await this.#refresh(current);
    return this.#success('status', this.#snapshot(current));
  }

  async ingestCarrierHealth(runtimeId: string, observation: CarrierHealthObservation): Promise<StatusResult> {
    return this.#enqueue(() => {
      const current = this.#find(runtimeId);
      if (!current) return this.#failure('status', 'UNKNOWN_RUNTIME', {
        retryable: true,
        hint: 'Call ensure with the desired scope; this supervisor does not adopt old runtimes.',
        message: 'The runtimeId is not managed by this supervisor.',
        runtimeId,
      });
      if (!isActiveRuntime(current) || current !== this.#active) {
        return this.#success('status', this.#snapshot(current));
      }
      if (observation.runtimeId !== null && observation.runtimeId !== runtimeId) {
        return this.#failure('status', 'UNKNOWN_RUNTIME', {
          retryable: false,
          hint: 'Report health against the runtimeId assigned to this page.',
          message: 'The health message belongs to a different runtime.',
          runtimeId,
        });
      }
      if (observation.challengeResponse !== null && observation.challengeResponse !== current.ownerToken) {
        return this.#failure('status', 'HANDSHAKE_OWNERSHIP_MISMATCH', {
          retryable: false,
          hint: 'Report health only from the page that completed this runtime start.',
          message: 'The health message failed the runtime ownership challenge.',
          runtimeId,
        });
      }
      this.#applyHealth(current, observation);
      return this.#success('status', this.#snapshot(current));
    });
  }

  reveal(runtimeId: string): Promise<RevealResult> {
    const active = this.#active;
    if (!active && !this.#terminals.has(runtimeId)) {
      return Promise.resolve(this.#failure('reveal', 'UNKNOWN_RUNTIME', {
        retryable: true,
        hint: 'Call ensure with the desired scope; this supervisor does not adopt old runtimes.',
        message: 'The runtimeId is not managed by this supervisor.',
        runtimeId,
      }));
    }
    if (active?.runtimeId === runtimeId && active.lifecycle === 'stopping') {
      return Promise.resolve(this.#failure('reveal', 'RUNTIME_STOPPING', {
        retryable: true,
        hint: 'Wait for stop to finish before ensuring a new runtime.',
        message: 'The active runtime is stopping.',
        runtimeId,
      }));
    }
    return this.#enqueue(async () => {
      const current = this.#find(runtimeId);
      if (!current) return this.#failure('reveal', 'UNKNOWN_RUNTIME', {
        retryable: true,
        hint: 'Call ensure with the desired scope; this supervisor does not adopt old runtimes.',
        message: 'The runtimeId is not managed by this supervisor.',
        runtimeId,
      });
      if (!isActiveRuntime(current) || current !== this.#active || current.lifecycle !== 'running' || !current.host) {
        return this.#failure('reveal', current.lifecycle === 'failed' ? 'RUNTIME_FAILED' : 'RUNTIME_NOT_ACTIVE', {
          retryable: true,
          hint: 'Call ensure after the current runtime has reached absent.',
          message: 'The runtime is not revealable in its current lifecycle.',
          runtimeId,
        });
      }
      if (!this.#host.supportsReveal) {
        return this.#failure('reveal', 'REVEAL_UNSUPPORTED', {
          retryable: false,
          hint: 'Install a reveal-capable headed host in M3.',
          message: 'The configured carrier host does not support reveal.',
          runtimeId,
        });
      }
      try {
        await current.host.reveal();
        return this.#success('reveal', this.#snapshot(current));
      } catch (error) {
        const failure = this.#recordFailure(current, errorForAction('reveal', {
          code: 'HOST_REVEAL_FAILED',
          retryable: true,
          hint: 'Inspect the host and retry reveal, or stop and ensure explicitly.',
          message: errorMessage(error),
          runtimeId,
        }));
        return { ok: false, action: 'reveal', error: failure };
      }
    });
  }

  stop(runtimeId: string): Promise<StopResult> {
    const current = this.#find(runtimeId);
    if (!current) {
      return Promise.resolve(this.#failure('stop', 'UNKNOWN_RUNTIME', {
        retryable: true,
        hint: 'Call ensure with the desired scope; this supervisor does not adopt old runtimes.',
        message: 'The runtimeId is not managed by this supervisor.',
        runtimeId,
      }));
    }
    if (!isActiveRuntime(current)) {
      if (current.lifecycle === 'stopped') return Promise.resolve(this.#success('stop', this.#snapshot(current)));
      return Promise.resolve(this.#failure('stop', 'RUNTIME_FAILED', {
        retryable: true,
        hint: 'Create a new supervisor or retry after resolving the failed managed runtime.',
        message: 'The runtime is in a failed terminal state.',
        runtimeId,
      }));
    }
    if (current.lifecycle === 'stopped') return Promise.resolve(this.#success('stop', this.#snapshot(current)));
    if (current.stopPromise) return current.stopPromise;
    current.stopRequested = true;
    current.lifecycle = 'stopping';
    current.abortController.abort();
    const stopPromise = this.#enqueue(() => this.#finishStop(current));
    current.stopPromise = stopPromise;
    return stopPromise;
  }

  snapshot(): RuntimeSnapshot | null {
    return this.#active ? this.#snapshot(this.#active) : null;
  }

  /**
   * Return the transport owned by a confirmed active carrier. This is a
   * capability lookup, not a lifecycle action: gameplay adapters perform the
   * readiness and identity checks before using it.
   */
  gameplay(runtimeId: string): CarrierGameplayTransport | undefined {
    const active = this.#active;
    if (!active || active.runtimeId !== runtimeId || active.lifecycle !== 'running') return undefined;
    return active.host?.gameplay;
  }

  async shutdown(): Promise<StopResult | null> {
    this.#shuttingDown = true;
    const active = this.#active;
    if (!active) return null;
    active.stopRequested = true;
    active.lifecycle = 'stopping';
    active.abortController.abort();
    return await this.#enqueue(() => this.#finishStop(active));
  }

  async #ensureSerialized(scope: RuntimeScope): Promise<EnsureResult> {
    const active = this.#active;
    if (active) {
      if (active.lifecycle === 'stopping') return this.#failure('ensure', 'RUNTIME_STOPPING', {
        retryable: true,
        hint: 'Wait for the active runtime to reach stopped, then call ensure again.',
        message: 'The active runtime is stopping.',
        runtimeId: active.runtimeId,
        requestedScope: scope,
        occupyingScope: active.confirmedScope,
      });
      if (active.lifecycle === 'starting' && active.startPromise) {
        if (!sameScope(scope, active.requestedScope)) return this.#failure('ensure', 'SCOPE_CONFLICT', {
          retryable: false,
          hint: 'Use status/reveal for the occupying runtime, or stop it before ensuring another scope.',
          message: 'A different scope already occupies the single runtime slot.',
          runtimeId: active.runtimeId,
          requestedScope: scope,
          occupyingScope: active.confirmedScope,
        });
        return active.startPromise;
      }
      if (!active.confirmedScope) return this.#failure('ensure', 'SCOPE_UNCONFIRMED', {
        retryable: true,
        hint: 'Wait for a valid page handshake, then retry ensure.',
        message: 'The active runtime has no confirmed page scope.',
        runtimeId: active.runtimeId,
        requestedScope: scope,
      });
      if (!sameScope(scope, active.confirmedScope)) return this.#failure('ensure', 'SCOPE_CONFLICT', {
        retryable: false,
        hint: 'Use status/reveal for the occupying runtime, or stop it before ensuring another scope.',
        message: 'A different scope already occupies the single runtime slot.',
        runtimeId: active.runtimeId,
        requestedScope: scope,
        occupyingScope: active.confirmedScope,
      });
      if (active.lifecycle === 'running') return this.#success('ensure', this.#snapshot(active));
    }

    if (!this.#host.supportsReveal) {
      return this.#failure('ensure', 'REVEAL_UNSUPPORTED', {
        retryable: false,
        hint: 'Install a reveal-capable headed host in M3.',
        message: 'The configured carrier host does not support reveal.',
      });
    }

    const created: ActiveRuntime = {
      runtimeId: crypto.randomUUID(),
      requestedScope: { ...scope },
      ownerToken: crypto.randomUUID(),
      abortController: new AbortController(),
      lifecycle: 'starting',
      liveness: 'alive',
      renderReadiness: 'pending',
      confirmedScope: null,
      lastFailure: null,
      stopRequested: false,
    };
    this.#active = created;
    created.startPromise = this.#start(created);
    // The identity is allocated before the headed host handshake completes.
    // Callers can immediately status/stop this starting runtime; the later
    // handshake either promotes it to running or records a terminal failure.
    return Promise.resolve(this.#success('ensure', this.#snapshot(created)));
  }

  async #start(active: ActiveRuntime): Promise<EnsureResult> {
    let handle: CarrierHostHandle | undefined;
    try {
      handle = await this.#host.start({
        runtimeId: active.runtimeId,
        scope: active.requestedScope,
        ownerToken: active.ownerToken,
        signal: active.abortController.signal,
      });
      active.host = handle;
      if (handle.runtimeId !== active.runtimeId) {
        return await this.#failedStart(active, 'HANDSHAKE_RUNTIME_MISMATCH', 'The managed page did not prove the allocated runtime identity.', 'The page handshake runtimeId does not match the supervisor allocation.');
      }
      if (handle.challengeResponse !== active.ownerToken) {
        return await this.#failedStart(active, 'HANDSHAKE_OWNERSHIP_MISMATCH', 'Stop the unmanaged page and ensure again so the supervisor can establish ownership.', 'The page handshake did not prove ownership of this start attempt.');
      }
      this.#applyObservation(active, handle);
      if (active.stopRequested) return this.#stopDuringStart(active);
      if (!active.confirmedScope) return await this.#failedStart(active, 'SCOPE_UNCONFIRMED', 'Wait for a valid page handshake, then retry ensure.');
      if (!sameScope(active.requestedScope, active.confirmedScope)) {
        return await this.#failedStart(active, 'SCOPE_MISMATCH', 'Use the page handshake scope as the next ensure input.');
      }
      active.lifecycle = 'running';
      active.renderReadiness = handle.renderReadiness ?? 'ready';
      return this.#success('ensure', this.#snapshot(active));
    } catch (error) {
      if (active.stopRequested) return this.#stopDuringStart(active, handle);
      const failure = this.#recordFailure(active, runtimeFailure({
        code: 'HOST_START_FAILED',
        stage: 'ensure',
        retryable: true,
        hint: 'Inspect the managed host and retry ensure.',
        message: errorMessage(error),
        runtimeId: active.runtimeId,
        requestedScope: active.requestedScope,
      }));
      active.lifecycle = 'failed';
      const snapshot = this.#snapshot(active);
      this.#terminals.set(active.runtimeId, snapshot);
      this.#active = null;
      return { ok: false, action: 'ensure', error: failure };
    }
  }

  async #finishStop(active: ActiveRuntime): Promise<StopResult> {
    if (active.lifecycle === 'stopped') return this.#success('stop', this.#snapshot(active));
    if (!active.host && active.startPromise) {
      await active.startPromise;
      if ((active as ActiveRuntime).lifecycle === 'stopped') return this.#success('stop', this.#snapshot(active));
    }
    try {
      if (active.host) await active.host.stop();
      active.lifecycle = 'stopped';
      active.liveness = 'terminated';
      active.renderReadiness = 'unavailable';
      const snapshot = this.#snapshot(active);
      this.#terminals.set(active.runtimeId, snapshot);
      if (this.#active === active) this.#active = null;
      return this.#success('stop', snapshot);
    } catch (error) {
      const failure = this.#recordFailure(active, runtimeFailure({
        code: 'HOST_STOP_FAILED',
        stage: 'stop',
        retryable: true,
        hint: 'Retry stop; the supervisor retains ownership until the host confirms exit.',
        message: errorMessage(error),
        runtimeId: active.runtimeId,
      }));
      active.lifecycle = 'failed';
      active.stopPromise = undefined;
      return { ok: false, action: 'stop', error: failure };
    }
  }

  async #stopDuringStart(active: ActiveRuntime, handle?: CarrierHostHandle): Promise<EnsureResult> {
    if (handle) {
      try {
        await handle.stop();
      } catch (error) {
        const failure = this.#recordFailure(active, runtimeFailure({
          code: 'HOST_STOP_FAILED',
          stage: 'stop',
          retryable: true,
          hint: 'Retry stop; the supervisor retains ownership until the host confirms exit.',
          message: errorMessage(error),
          runtimeId: active.runtimeId,
        }));
        active.lifecycle = 'failed';
        active.liveness = 'unreachable';
        active.renderReadiness = 'unavailable';
        return { ok: false, action: 'ensure', error: failure };
      }
    }
    active.lifecycle = 'stopped';
    active.liveness = 'terminated';
    active.renderReadiness = 'unavailable';
    const snapshot = this.#snapshot(active);
    this.#terminals.set(active.runtimeId, snapshot);
    if (this.#active === active) this.#active = null;
    return {
      ok: false,
      action: 'ensure',
      error: runtimeFailure({
        code: 'STOPPED_DURING_START',
        stage: 'ensure',
        retryable: true,
        hint: 'Wait for the slot to become absent, then call ensure again.',
        message: 'The runtime was stopped before startup completed.',
        runtimeId: active.runtimeId,
        requestedScope: active.requestedScope,
      }),
    };
  }

  async #failedStart(active: ActiveRuntime, code: RuntimeFailure['code'], hint: string, message?: string): Promise<EnsureResult> {
    if (active.host) {
      try {
        await active.host.stop();
      } catch (error) {
        const failure = this.#recordFailure(active, runtimeFailure({
          code: 'HOST_STOP_FAILED',
          stage: 'stop',
          retryable: true,
          hint: 'Retry stop; the supervisor retains ownership until the host confirms exit.',
          message: errorMessage(error),
          runtimeId: active.runtimeId,
        }));
        active.lifecycle = 'failed';
        active.liveness = 'unreachable';
        active.renderReadiness = 'unavailable';
        return { ok: false, action: 'ensure', error: failure };
      }
    }
    const failure = this.#recordFailure(active, runtimeFailure({
      code,
      stage: 'ensure',
      retryable: true,
      hint,
      message: message ?? (code === 'SCOPE_UNCONFIRMED' ? 'The page did not confirm a scope.' : 'The page confirmed a different scope.'),
      runtimeId: active.runtimeId,
      requestedScope: active.requestedScope,
      occupyingScope: active.confirmedScope,
    }));
    active.lifecycle = 'failed';
    const snapshot = this.#snapshot(active);
    this.#terminals.set(active.runtimeId, snapshot);
    this.#active = null;
    return { ok: false, action: 'ensure', error: failure };
  }

  async #refresh(active: ActiveRuntime): Promise<void> {
    if (!active.host?.observe) return;
    try {
      const observation = await active.host.observe();
      if (observation.runtimeId !== undefined && observation.runtimeId !== active.runtimeId) {
        await this.#retireForFailure(active, runtimeFailure({
          code: 'HANDSHAKE_RUNTIME_MISMATCH',
          stage: 'status',
          retryable: true,
          hint: 'Stop the old page and ensure again to establish a new runtime identity.',
          message: 'The managed page reported a different runtimeId.',
          runtimeId: active.runtimeId,
        }));
        return;
      }
      if (observation.challengeResponse !== undefined && observation.challengeResponse !== active.ownerToken) {
        await this.#retireForFailure(active, runtimeFailure({
          code: 'HANDSHAKE_OWNERSHIP_MISMATCH',
          stage: 'status',
          retryable: true,
          hint: 'Stop the old page and ensure again so the supervisor can re-establish ownership.',
          message: 'The managed page failed the ownership challenge.',
          runtimeId: active.runtimeId,
        }));
        return;
      }
      if (observation.pageNonce && active.pageNonce && observation.pageNonce !== active.pageNonce) {
        await this.#retireForFailure(active, runtimeFailure({
          code: 'PAGE_RELOADED',
          stage: 'status',
          retryable: true,
          hint: 'Stop the old runtime and ensure again to establish a new page identity.',
          message: 'The managed carrier page was reloaded.',
          runtimeId: active.runtimeId,
        }));
        return;
      }
      this.#applyObservation(active, observation);
      const heartbeatAt = active.heartbeat?.at;
      const heartbeatAge = heartbeatAt ? Date.now() - Date.parse(heartbeatAt) : Number.POSITIVE_INFINITY;
      if (heartbeatAge > this.#healthStaleMs) {
        active.liveness = 'unreachable';
        active.renderReadiness = 'unavailable';
        active.lastFailure = runtimeFailure({
          code: 'HEALTH_STALE',
          stage: 'heartbeat',
          retryable: true,
          hint: 'Check the managed page, then reveal or stop and ensure again.',
          message: `No new carrier heartbeat has arrived for ${heartbeatAge}ms.`,
          runtimeId: active.runtimeId,
        });
      }
    } catch (error) {
      this.#recordFailure(active, runtimeFailure({
        code: 'HOST_START_FAILED',
        stage: 'status',
        retryable: true,
        hint: 'Retry status or stop the runtime explicitly.',
        message: errorMessage(error),
        runtimeId: active.runtimeId,
      }));
      active.liveness = 'unreachable';
      active.renderReadiness = 'unavailable';
    }
  }

  async #retireForFailure(active: ActiveRuntime, failure: RuntimeFailure): Promise<void> {
    this.#recordFailure(active, failure);
    active.lifecycle = 'failed';
    active.liveness = 'terminated';
    active.renderReadiness = 'unavailable';
    try {
      if (active.host) await active.host.stop();
      const snapshot = this.#snapshot(active);
      this.#terminals.set(active.runtimeId, snapshot);
      if (this.#active === active) this.#active = null;
    } catch (error) {
      active.liveness = 'unreachable';
      this.#recordFailure(active, runtimeFailure({
        code: 'HOST_STOP_FAILED',
        stage: 'stop',
        retryable: true,
        hint: 'Retry stop; the supervisor retains ownership until the host confirms exit.',
        message: errorMessage(error),
        runtimeId: active.runtimeId,
      }));
    }
  }

  #applyObservation(active: ActiveRuntime, observation: CarrierHostObservation): void {
    if (active.confirmedScope && observation.confirmedScope && !sameScope(active.confirmedScope, observation.confirmedScope)) {
      active.lastFailure = runtimeFailure({
        code: 'SCOPE_DRIFT',
        stage: 'status',
        retryable: false,
        hint: 'Use the newly confirmed page scope for subsequent ensure calls.',
        message: 'The managed page confirmed a changed scope.',
        runtimeId: active.runtimeId,
        occupyingScope: observation.confirmedScope,
      });
    } else if (!observation.confirmedScope) {
      active.lastFailure = runtimeFailure({
        code: 'SCOPE_UNCONFIRMED',
        stage: 'status',
        retryable: true,
        hint: 'Wait for a valid page handshake, then retry status.',
        message: 'The managed page scope is unconfirmed.',
        runtimeId: active.runtimeId,
      });
    }
    active.confirmedScope = observation.confirmedScope;
    if (observation.liveness) active.liveness = observation.liveness;
    if (observation.renderReadiness) active.renderReadiness = observation.renderReadiness;
    if (observation.pageNonce) active.pageNonce = observation.pageNonce;
    if (observation.pageIdentity) active.pageIdentity = observation.pageIdentity;
    if (observation.canvasIdentity) active.canvasIdentity = observation.canvasIdentity;
    if (observation.rendererIdentity) active.rendererIdentity = observation.rendererIdentity;
    if (observation.rendererGeneration !== undefined) active.rendererGeneration = observation.rendererGeneration;
    if (observation.sentinel !== undefined) {
      const previousSentinel = active.heartbeat?.sentinel;
      if (previousSentinel === undefined || observation.sentinel > previousSentinel) {
        active.heartbeat = { sentinel: observation.sentinel, at: new Date().toISOString() };
      } else if (observation.sentinel < previousSentinel) {
        active.lastFailure = runtimeFailure({
          code: 'HEALTH_STALE',
          stage: 'heartbeat',
          retryable: true,
          hint: 'The carrier heartbeat reset; stop and ensure again to establish a new page identity.',
          message: 'The carrier heartbeat sentinel is not monotonic.',
          runtimeId: active.runtimeId,
        });
        active.liveness = 'unreachable';
        active.renderReadiness = 'unavailable';
      }
    }
    if (observation.lastFailure) active.lastFailure = observation.lastFailure;
  }

  #applyHealth(active: ActiveRuntime, observation: CarrierHealthObservation): void {
    this.#applyObservation(active, {
      runtimeId: observation.runtimeId,
      challengeResponse: observation.challengeResponse,
      confirmedScope: observation.confirmedScope,
      liveness: observation.liveness,
      renderReadiness: observation.renderReadiness,
      pageNonce: observation.pageNonce,
      pageIdentity: observation.pageIdentity,
      canvasIdentity: observation.canvasIdentity,
      rendererIdentity: observation.rendererIdentity,
      rendererGeneration: observation.rendererGeneration,
      sentinel: observation.sentinel,
      lastFailure: observation.failure ? undefined : null,
    });
    active.pageNonce = observation.pageNonce;
    active.pageIdentity = observation.pageIdentity;
    active.canvasIdentity = observation.canvasIdentity;
    active.rendererIdentity = observation.rendererIdentity;
    active.rendererGeneration = observation.rendererGeneration;
    if (observation.failure) {
      const failure = runtimeFailure({
        code: observation.failure.code,
        stage: observation.failure.stage,
        retryable: observation.failure.retryable,
        hint: observation.failure.hint,
        message: observation.failure.message ?? `Carrier reported ${observation.failure.code}.`,
        runtimeId: active.runtimeId,
        occupyingScope: observation.confirmedScope,
      });
      active.lastFailure = { ...failure, at: observation.failure.at };
    }
  }

  #find(runtimeId: string): ActiveRuntime | RuntimeSnapshot | undefined {
    return this.#active?.runtimeId === runtimeId ? this.#active : this.#terminals.get(runtimeId);
  }

  #snapshot(active: ActiveRuntime): RuntimeSnapshot;
  #snapshot(snapshot: RuntimeSnapshot): RuntimeSnapshot;
  #snapshot(value: ActiveRuntime | RuntimeSnapshot): RuntimeSnapshot {
    if ('ownerToken' in value) {
      return {
        runtimeId: value.runtimeId,
        lifecycle: value.lifecycle,
        liveness: value.liveness,
        renderReadiness: value.renderReadiness,
        confirmedScope: value.confirmedScope ? { ...value.confirmedScope } : null,
        lastFailure: value.lastFailure ? { ...value.lastFailure } : null,
        pageNonce: value.pageNonce,
        pageIdentity: value.pageIdentity,
        canvasIdentity: value.canvasIdentity,
        rendererIdentity: value.rendererIdentity ? value.rendererIdentity : undefined,
        rendererGeneration: value.rendererGeneration,
        heartbeat: value.heartbeat ? { ...value.heartbeat } : undefined,
      };
    }
    return { ...value, confirmedScope: value.confirmedScope ? { ...value.confirmedScope } : null, lastFailure: value.lastFailure ? { ...value.lastFailure } : null };
  }

  #success<Action extends 'ensure' | 'status' | 'reveal' | 'stop'>(action: Action, snapshot: RuntimeSnapshot): RuntimeActionSuccess<Action> {
    return { ok: true, action, ...snapshot };
  }

  #failure<Action extends 'ensure' | 'status' | 'reveal' | 'stop'>(action: Action, code: Parameters<typeof runtimeFailure>[0]['code'], input: Omit<Parameters<typeof runtimeFailure>[0], 'code' | 'stage'>): RuntimeActionFailure<Action> {
    return { ok: false, action, error: runtimeFailure({ ...input, code, stage: action }) };
  }

  #recordFailure(active: ActiveRuntime, failure: RuntimeFailure): RuntimeFailure {
    active.lastFailure = failure;
    return failure;
  }

  #enqueue<T>(action: () => Promise<T> | T): Promise<T> {
    const next = this.#queue.then(action, action);
    this.#queue = next.then(() => undefined, () => undefined);
    return next;
  }
}

export function createRuntimeCarrierSupervisor(options: SupervisorOptions = {}): RuntimeCarrierSupervisor {
  return new RuntimeCarrierSupervisor(options);
}

function sameScope(left: RuntimeScope, right: RuntimeScope): boolean {
  return left.projectId === right.projectId && left.gameId === right.gameId;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isActiveRuntime(value: ActiveRuntime | RuntimeSnapshot): value is ActiveRuntime {
  return 'ownerToken' in value;
}
