/**
 * Server-owned client for the Play sidecar's single active-game runtime.
 *
 * The server resolves the exact game directory and assigns the generation;
 * browser input never becomes a filesystem selector and the UI never guesses
 * an asset URL. A failed bind deliberately clears the previous binding from
 * the published state so callers cannot keep rendering the old game.
 */

import { createHash } from 'node:crypto';

export type RuntimeScopeStatus = 'unbound' | 'transitioning' | 'ready' | 'degraded' | 'unavailable';

export interface RuntimeAssetBinding {
  readonly schemaVersion: 'runtime-asset-binding-v1';
  readonly gameId: string;
  readonly scopeId: string;
  readonly generation: number;
  readonly status: RuntimeScopeStatus;
  readonly catalogUrl: string;
  readonly importUrlBase: string;
  readonly packageUrlBase: string;
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

type RuntimeScopeListener = (state: RuntimeScopeState) => void;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    && typeof candidate.packageUrlBase === 'string';
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
  // Start above any generation a sidecar may have retained across a server
  // restart. A monotonic in-process increment then orders same-process binds.
  private generation = Date.now();
  private state: RuntimeScopeState = { status: 'unbound' };

  constructor(options: RuntimeScopeClientOptions = {}) {
    const port = options.enginePort ?? process.env.FORGEAX_ENGINE_PORT ?? '15173';
    this.endpoint = `http://127.0.0.1:${port}`;
    this.secret = options.secret ?? process.env.FORGEAX_RUNTIME_SCOPE_SECRET;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 1500;
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
   * each accepted request gets a strictly increasing generation.
   */
  bind(gameId: string, gameDir: string): Promise<RuntimeScopeState> {
    const current = this.state.binding;
    if (current?.gameId === gameId && isReadyStatus(current.status)) {
      return Promise.resolve(this.state);
    }
    const generation = ++this.generation;
    const scopeId = scopeIdFor(gameId, gameDir);
    const run = this.serial.then(async () => {
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
        const state: RuntimeScopeState = { status: 'unavailable', error: errorMessage(error) };
        this.publish(state);
        return state;
      }
    });
    this.serial = run.then(() => undefined, () => undefined);
    return run;
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
          throw new Error(`runtime scope bind failed: ${detail}`);
        }
        if (!isBinding(body)) throw new Error('sidecar returned an invalid runtime binding');
        if (!isReadyStatus(body.status)) throw new Error(`sidecar binding is ${body.status}`);
        return body;
      } catch (error) {
        lastError = error;
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
