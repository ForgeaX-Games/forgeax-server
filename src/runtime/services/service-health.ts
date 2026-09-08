export type ServiceStatus = 'starting' | 'ready' | 'stopped' | 'failed';

export interface ServiceHealthV1 {
  readonly protocol: 'ServiceHealthV1';
  readonly serviceId: string;
  readonly version: string;
  readonly status: ServiceStatus;
  readonly detail?: string;
}

export type ServiceHealthErrorCode =
  | 'SERVICE_VERSION_MISMATCH'
  | 'SERVICE_READY_TIMEOUT'
  | 'SERVICE_RESTART_EXHAUSTED'
  | 'SERVICE_SHUTDOWN_FAILED';

export class ServiceHealthError extends Error {
  readonly name = 'ServiceHealthError';

  constructor(
    readonly code: ServiceHealthErrorCode,
    readonly expected: string | null,
    readonly actual: string | number | null,
    readonly retryable: boolean,
    readonly recoveryActions: readonly string[],
    message: string,
  ) {
    super(message);
  }
}

export interface ServiceHealthMonitorOptions {
  readonly expectedVersion: string;
  readonly maxRestarts?: number;
  readonly pollIntervalMs?: number;
}

export class ServiceHealthMonitor {
  readonly #expectedVersion: string;
  readonly #maxRestarts: number;
  readonly #pollIntervalMs: number;
  #shutdownPromise: Promise<void> | null = null;

  constructor(options: ServiceHealthMonitorOptions) {
    this.#expectedVersion = options.expectedVersion;
    this.#maxRestarts = options.maxRestarts ?? 3;
    this.#pollIntervalMs = options.pollIntervalMs ?? 100;
  }

  async assertCompatible(report: ServiceHealthV1): Promise<void> {
    if (report.protocol !== 'ServiceHealthV1' || report.version !== this.#expectedVersion) {
      throw new ServiceHealthError(
        'SERVICE_VERSION_MISMATCH',
        this.#expectedVersion,
        report.version,
        false,
        ['install-compatible-service'],
        `Service ${report.serviceId} reports ${report.version}; expected ${this.#expectedVersion}`,
      );
    }
  }

  async waitUntilReady(read: () => Promise<ServiceHealthV1>, timeoutMs: number): Promise<ServiceHealthV1> {
    const deadline = Date.now() + timeoutMs;
    let latest: ServiceHealthV1 | null = null;
    while (Date.now() <= deadline) {
      latest = await read();
      await this.assertCompatible(latest);
      if (latest.status === 'ready') return latest;
      if (latest.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, this.#pollIntervalMs));
    }
    throw new ServiceHealthError(
      'SERVICE_READY_TIMEOUT',
      this.#expectedVersion,
      latest?.status ?? null,
      true,
      ['restart-service', 'inspect-service-logs'],
      `Service did not become ready within ${timeoutMs}ms`,
    );
  }

  async restartUntilReady(
    read: () => Promise<ServiceHealthV1>,
    restart: () => Promise<void>,
    timeoutMs: number,
  ): Promise<ServiceHealthV1> {
    for (let attempt = 0; attempt < this.#maxRestarts; attempt += 1) {
      const state = await read();
      await this.assertCompatible(state);
      if (state.status === 'ready') return state;
      await restart();
      try {
        return await this.waitUntilReady(read, timeoutMs);
      } catch (error) {
        if (!(error instanceof ServiceHealthError) || error.code === 'SERVICE_VERSION_MISMATCH') throw error;
      }
    }
    throw new ServiceHealthError(
      'SERVICE_RESTART_EXHAUSTED',
      this.#expectedVersion,
      this.#maxRestarts,
      false,
      ['inspect-service-logs', 'rollback-service-artifact'],
      `Service restart limit ${this.#maxRestarts} exhausted`,
    );
  }

  shutdown(stop: () => Promise<void>): Promise<void> {
    if (!this.#shutdownPromise) {
      this.#shutdownPromise = stop().catch((error) => {
        throw new ServiceHealthError(
          'SERVICE_SHUTDOWN_FAILED',
          this.#expectedVersion,
          null,
          true,
          ['retry-shutdown', 'terminate-service'],
          `Service shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    return this.#shutdownPromise;
  }
}
