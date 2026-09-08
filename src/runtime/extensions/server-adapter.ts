import type { ServiceHealthV1 } from '../services/service-health';

export interface ServiceLock {
  readonly serviceId: string;
  readonly version: string;
  readonly artifact: string;
}

export interface ServerRuntimeAdapter {
  readonly id: string;
  lock(): ServiceLock;
  health(): Promise<ServiceHealthV1>;
  shutdown(): Promise<void>;
}

export interface ServerRuntimeAdapterOptions {
  readonly id?: string;
  readonly serviceLock: ServiceLock;
  readonly health: ServiceHealthV1;
  readonly onShutdown?: () => Promise<void>;
}

export function createServerRuntimeAdapter(options: ServerRuntimeAdapterOptions): ServerRuntimeAdapter {
  let stopped = false;
  return {
    id: options.id ?? options.serviceLock.serviceId,
    lock: () => options.serviceLock,
    health: async () => ({ ...options.health, status: stopped ? 'stopped' : options.health.status }),
    shutdown: async () => {
      if (stopped) return;
      stopped = true;
      await options.onShutdown?.();
    },
  };
}
