import type { ServerCompositionContext, ServerModule } from './composition';

type ServerModuleRegistryState = 'collecting' | 'activating' | 'activated' | 'failed';

export class ServerModuleRegistry {
  readonly #modules: ServerModule[] = [];
  #state: ServerModuleRegistryState = 'collecting';

  register(module: ServerModule): void {
    if (this.#state !== 'collecting') {
      throw new Error('Cannot register server module after activation has started');
    }
    this.#modules.push(module);
  }

  async activate(context: ServerCompositionContext): Promise<void> {
    if (this.#state === 'activating') {
      throw new Error('Server module activation is already in progress');
    }
    if (this.#state === 'activated') {
      throw new Error('Server modules have already been activated');
    }
    if (this.#state === 'failed') {
      throw new Error('Server module activation previously failed');
    }

    this.#state = 'activating';
    try {
      for (const module of this.#modules) {
        await module.activate(context);
      }
      this.#state = 'activated';
    } catch (error) {
      this.#state = 'failed';
      throw error;
    }
  }
}

const serverModules = new ServerModuleRegistry();

export function registerServerModule(module: ServerModule): void {
  serverModules.register(module);
}

export async function activateServerModules(context: ServerCompositionContext): Promise<void> {
  await serverModules.activate(context);
}
