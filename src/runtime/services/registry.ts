import type { ServiceHealthMonitor } from './service-health';

export interface ServiceRegistration {
  readonly id: string;
  readonly health: ServiceHealthMonitor;
}

export class ServiceRegistry {
  readonly #services = new Map<string, ServiceRegistration>();

  register(service: ServiceRegistration): void {
    if (this.#services.has(service.id)) throw new Error(`Service already registered: ${service.id}`);
    this.#services.set(service.id, service);
  }

  get(id: string): ServiceRegistration | undefined {
    return this.#services.get(id);
  }

  list(): readonly ServiceRegistration[] {
    return [...this.#services.values()];
  }
}

export const serviceRegistry = new ServiceRegistry();
