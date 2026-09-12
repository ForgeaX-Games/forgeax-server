/**
 * Server-owned client for the Play sidecar's single active-game runtime.
 *
 * The server resolves the exact game directory and assigns the generation;
 * browser input never becomes a filesystem selector and the UI never guesses
 * an asset URL. A failed candidate bind preserves the last committed binding:
 * the active-game authority is not advanced until the candidate is ready.
 */

import { createHash } from 'node:crypto';

// A first bind rebuilds the Play sidecar's scoped catalog before it can reply.
// Cold CI and large games can legitimately take several seconds; a short
// transport timeout turns that work into a false runtime-unavailable 503.
export const DEFAULT_RUNTIME_SCOPE_TIMEOUT_MS = 60_000;
const RUNTIME_SCOPE_TIMEOUT_ENV = 'FORGEAX_RUNTIME_SCOPE_TIMEOUT_MS';

export type RuntimeScopeStatus = 'unbound' | 'transitioning' | 'ready' | 'degraded' | 'unavailable';

export interface RuntimeCatalogRoot {
  readonly root: string;
  readonly catalogPrefix: string;
}

export interface RuntimeAssetBinding {
  readonly schemaVersion: 'runtime-asset-binding-v1';
  readonly gameId: string;
  readonly scopeId: string;
  readonly generation: number;
  readonly status: RuntimeScopeStatus;
  readonly catalogUrl: string;
  readonly importUrlBase: string;
  readonly packageUrlBase: string;
  readonly catalogRoots?: readonly RuntimeCatalogRoot[];
  readonly authority?: 'authoritative' | 'degraded';
  readonly diagnostics?: readonly unknown[];
}

export interface RuntimeScopeState {
  readonly status: RuntimeScopeStatus;
  readonly binding?: RuntimeAssetBinding;
  readonly error?: string;
}

export interface RuntimeScopeClientOptions {
  readonly enginePort?: number | string;
  readonly secret?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly retryDelayMs?: number;
}

export interface RuntimeScopeRecoveryOptions {
  /** Stop retrying when the active-game authority has moved to another game. */
  readonly shouldContinue?: () => boolean;
  /** Delay between complete bind attempts; the bind's own fast retries remain bounded. */
  readonly retryDelayMs?: number;
}

type RuntimeScopeListener = (state: RuntimeScopeState) => void;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTransportTimeout(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as { name?: unknown }).name === 'AbortError';
}

function isRetryableBindError(error: unknown): boolean {
  return !(typeof error === 'object'
    && error !== null
    && (error as { retryable?: unknown }).retryable === false);
}

function envTimeoutMs(): number | undefined {
  const raw = process.env[RUNTIME_SCOPE_TIMEOUT_ENV];
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isBinding(value: unknown): value is RuntimeAssetBinding {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return candidate.schemaVersion === 'runtime-asset-binding-v1'
    && typeof candidate.gameId === 'string'
    && typeof candidate.scopeId === 'string'
    && typeof candidate.generation === 'number'
    && Number.isSafeInteger(candidate.generation)
    && candidate.generation > 0
    && typeof candidate.status === 'string'
    && typeof candidate.catalogUrl === 'string'
    && typeof candidate.importUrlBase === 'string'
    && typeof candidate.packageUrlBase === 'string'
    && (candidate.catalogRoots === undefined || isCatalogRoots(candidate.catalogRoots));
}

function isCatalogRoots(value: unknown): value is readonly RuntimeCatalogRoot[] {
  return Array.isArray(value) && value.every((root) => (
    root !== null
    && typeof root === 'object'
    && typeof (root as { root?: unknown }).root === 'string'
    && typeof (root as { catalogPrefix?: unknown }).catalogPrefix === 'string'
  ));
}

function isReadyStatus(status: RuntimeScopeStatus): boolean {
  return status === 'ready' || status === 'degraded';
}

function scopeIdFor(gameId: string, gameDir: string): string {
  // Stable within one Studio instance/game, opaque to the browser, and not a
  // filesystem path. The generation remains the freshness fence for A→B→A.
  const digest = createHash('sha256').update(`${gameId}\0${gameDir}`).digest('hex').slice(0, 32);
  return `studio-${digest}`;
}

export class RuntimeScopeClient {
  private readonly endpoint: string;
  private readonly secret: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly listeners = new Set<RuntimeScopeListener>();
  private serial: Promise<void> = Promise.resolve();
  private recoveryGeneration = 0;
  // Start above any generation a sidecar may have retained across a server
  // restart. A monotonic in-process increment then orders same-process binds.
  private generation = Date.now();
  private state: RuntimeScopeState = { status: 'unbound' };

  constructor(options: RuntimeScopeClientOptions = {}) {
    const port = options.enginePort ?? process.env.FORGEAX_ENGINE_PORT ?? '15173';
    this.endpoint = `http://127.0.0.1:${port}`;
    this.secret = options.secret ?? process.env.FORGEAX_RUNTIME_SCOPE_SECRET;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? envTimeoutMs() ?? DEFAULT_RUNTIME_SCOPE_TIMEOUT_MS;
    this.retries = options.retries ?? 8;
    this.retryDelayMs = options.retryDelayMs ?? 150;
  }

  snapshot(): RuntimeScopeState {
    return this.state;
  }

  subscribe(listener: RuntimeScopeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Bind exactly one server-resolved game directory. Calls are serialized and
   * each accepted request gets a strictly increasing generation. A cached
   * server-side ready state is only reusable after the sidecar confirms the
   * same binding; the Vite process can be restarted or reloaded independently
   * of this long-lived server process.
   */
  bind(gameId: string, gameDir: string): Promise<RuntimeScopeState> {
    // An explicit active-game bind supersedes any background startup recovery
    // synchronously, before either command reaches the serialized sidecar queue.
    this.recoveryGeneration += 1;
    return this.enqueueBind(gameId, gameDir);
  }

  private enqueueBind(gameId: string, gameDir: string): Promise<RuntimeScopeState> {
    return this.enqueueBindGeneration(gameId, gameDir);
  }

  private enqueueBindGeneration(
    gameId: string,
    gameDir: string,
    requestedGeneration?: number,
  ): Promise<RuntimeScopeState> {
    const scopeId = scopeIdFor(gameId, gameDir);
    const run = this.serial.then(async () => {
      const current = this.state.binding;
      if (
        current?.gameId === gameId
        && current.scopeId === scopeId
        && (isReadyStatus(current.status) || current.status === 'degraded')
      ) {
        const sidecar = await this.readSidecarBinding();
        if (sidecar !== undefined) {
          this.generation = Math.max(this.generation, sidecar.generation);
        }
        if (
          sidecar?.gameId === current.gameId
          && sidecar.scopeId === current.scopeId
          && sidecar.generation === current.generation
          && (isReadyStatus(sidecar.status) || sidecar.status === 'degraded')
        ) {
          // A degraded producer still owns this exact scope/generation. Reads
          // must not mint a new generation on every poll; source rebuilds can
          // recover its catalog without invalidating the viewport's binding.
          const confirmed: RuntimeScopeState = { status: sidecar.status, binding: sidecar };
          this.publish(confirmed);
          return confirmed;
        }
      }

      const generation = requestedGeneration ?? ++this.generation;
      this.generation = Math.max(this.generation, generation);
      const previousState = this.state;
      this.publish({ status: 'transitioning' });
      try {
        const binding = await this.requestBind({
          gameId,
          scopeId,
          generation,
          gameDir,
        });
        if (binding.gameId !== gameId || binding.scopeId !== scopeId || binding.generation !== generation) {
          throw new Error('sidecar returned a runtime binding for a different game generation');
        }
        const state: RuntimeScopeState = { status: binding.status, binding };
        this.publish(state);
        return state;
      } catch (error) {
        const previousBinding = previousState.binding;
        const state: RuntimeScopeState = previousBinding !== undefined && isReadyStatus(previousBinding.status)
          ? {
              status: 'degraded',
              binding: {
                ...previousBinding,
                status: 'degraded',
                authority: 'degraded',
              },
              error: errorMessage(error),
            }
          : { status: 'unavailable', error: errorMessage(error) };
        this.publish(state);
        return state;
      }
    });
    this.serial = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Recover the server-owned startup binding after a sidecar startup race.
   *
   * A normal `bind()` stays bounded because it is also used by the interactive
   * active-game PUT route. Startup reconciliation has a different lifecycle:
   * the Play sidecar is supervised independently and may become reachable only
   * after the server's fast transport retries finish. Retry complete binds until
   * the requested game is ready or the active-game authority supersedes it.
   */
  async bindWhenAvailable(
    gameId: string,
    gameDir: string,
    options: RuntimeScopeRecoveryOptions = {},
  ): Promise<RuntimeScopeState> {
    const shouldContinue = options.shouldContinue ?? (() => true);
    const retryDelayMs = options.retryDelayMs ?? 500;
    const recoveryGeneration = ++this.recoveryGeneration;
    // One startup recovery is one logical publication. Transport retries must
    // reuse its generation so a slow sidecar cannot materialize a fresh DDC
    // realm for every HTTP timeout.
    const bindingGeneration = ++this.generation;
    let state = this.snapshot();

    while (recoveryGeneration === this.recoveryGeneration && shouldContinue()) {
      state = await this.enqueueBindGeneration(gameId, gameDir, bindingGeneration);
      if (
        isReadyStatus(state.status)
        || recoveryGeneration !== this.recoveryGeneration
        || !shouldContinue()
      ) return state;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
    return state;
  }

  /**
   * Read the sidecar's authoritative state without changing it. A missing or
   * malformed response is deliberately treated as unbound so the caller can
   * repair the state with the credentialed bind route.
   */
  private async readSidecarBinding(): Promise<RuntimeAssetBinding | undefined> {
    try {
      const response = await this.fetchWithTimeout('/__pack/runtime-binding.json', {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
      if (!response.ok) return undefined;
      const body = await response.json().catch(() => null) as unknown;
      return isBinding(body) ? body : undefined;
    } catch {
      return undefined;
    }
  }

  private publish(state: RuntimeScopeState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }

  private async requestBind(command: {
    gameId: string;
    scopeId: string;
    generation: number;
    gameDir: string;
  }): Promise<RuntimeAssetBinding> {
    if (!this.secret) throw new Error('FORGEAX_RUNTIME_SCOPE_SECRET is not configured');
    let lastError: unknown = new Error('sidecar bind failed');
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        const response = await this.fetchWithTimeout('/__pack/control/bind', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-forgeax-runtime-secret': this.secret,
          },
          body: JSON.stringify(command),
        });
        const body = await response.json().catch(() => null) as unknown;
        if (!response.ok) {
          const detail = body && typeof body === 'object' && typeof (body as { detail?: unknown }).detail === 'string'
            ? (body as { detail: string }).detail
            : `HTTP ${response.status}`;
          throw Object.assign(
            new Error(`runtime scope bind failed: ${detail}`),
            { retryable: response.status >= 500 },
          );
        }
        if (!isBinding(body)) {
          throw Object.assign(
            new Error('sidecar returned an invalid runtime binding'),
            { retryable: false },
          );
        }
        if (!isReadyStatus(body.status)) {
          throw Object.assign(
            new Error(`sidecar binding is ${body.status}`),
            { retryable: false },
          );
        }
        return body;
      } catch (error) {
        lastError = error;
        // A timeout means the sidecar accepted the request but did not finish
        // within the cold-bind budget. Retrying the same long request eight
        // more times made the active-game route look dead for >80s. Keep the
        // fast retries for connection-refused/startup races, but hand a
        // bounded timeout back to the caller so the UI can retry the command.
        if (isTransportTimeout(error)) break;
        if (!isRetryableBindError(error)) break;
        if (attempt >= this.retries) break;
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      }
    }
    throw lastError;
  }

  private async fetchWithTimeout(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.endpoint}${path}`, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}
