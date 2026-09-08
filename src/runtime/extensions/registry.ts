import type { ServerRuntimeAdapter } from './server-adapter';

export class RuntimeExtensionRegistry {
  readonly #adapters = new Map<string, ServerRuntimeAdapter>();

  register(adapter: ServerRuntimeAdapter): void {
    if (this.#adapters.has(adapter.id)) throw new Error(`Runtime extension already registered: ${adapter.id}`);
    this.#adapters.set(adapter.id, adapter);
  }

  get(id: string): ServerRuntimeAdapter | undefined {
    return this.#adapters.get(id);
  }

  list(): readonly ServerRuntimeAdapter[] {
    return [...this.#adapters.values()];
  }
}

export const runtimeExtensionRegistry = new RuntimeExtensionRegistry();

export function registerRuntimeExtension(adapter: ServerRuntimeAdapter): void {
  runtimeExtensionRegistry.register(adapter);
}
