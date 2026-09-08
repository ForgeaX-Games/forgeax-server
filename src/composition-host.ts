import type {
  ServerCompositionContext,
  ServerModule,
  ServerPrepareContext,
  ServerProductComposition,
} from './composition';

type ServerModuleRegistryState =
  | 'collecting'
  | 'preparing'
  | 'prepared'
  | 'prepare-failed'
  | 'activating'
  | 'activated'
  | 'failed';

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
    if (this.#state === 'preparing') {
      throw new Error('Cannot activate server modules while preparation is in progress');
    }
    if (this.#state === 'prepare-failed') {
      throw new Error('Cannot activate server modules after preparation failed');
    }
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

  async prepare(context: ServerPrepareContext): Promise<ServerProductComposition> {
    if (this.#state === 'preparing') {
      throw new Error('Server module preparation is already in progress');
    }
    if (this.#state === 'prepared') {
      throw new Error('Server modules have already been prepared');
    }
    if (this.#state === 'prepare-failed') {
      throw new Error('Server module preparation previously failed');
    }
    if (this.#state !== 'collecting') {
      throw new Error('Cannot prepare server modules after activation has started');
    }
    const composition: {
      extensionHost?: ServerProductComposition['extensionHost'];
      gameHostBeforeVersion?: ServerProductComposition['gameHostBeforeVersion'];
      gameHostSeedProvider?: ServerProductComposition['gameHostSeedProvider'];
    } = {};
    this.#state = 'preparing';
    try {
      for (const module of this.#modules) {
        if (!module.prepare) continue;
        const prepared = await module.prepare(context);
        if (prepared.extensionHost !== undefined) {
          if (composition.extensionHost !== undefined) throw new Error('Multiple server modules provided extensionHost');
          composition.extensionHost = prepared.extensionHost;
        }
        if (prepared.gameHostBeforeVersion !== undefined) {
          if (composition.gameHostBeforeVersion !== undefined) throw new Error('Multiple server modules provided gameHostBeforeVersion');
          composition.gameHostBeforeVersion = prepared.gameHostBeforeVersion;
        }
        if (prepared.gameHostSeedProvider !== undefined) {
          if (composition.gameHostSeedProvider !== undefined) throw new Error('Multiple server modules provided gameHostSeedProvider');
          composition.gameHostSeedProvider = prepared.gameHostSeedProvider;
        }
      }
      this.#state = 'prepared';
      return composition;
    } catch (error) {
      this.#state = 'prepare-failed';
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

export async function prepareServerModules(
  context: ServerPrepareContext,
): Promise<ServerProductComposition> {
  return serverModules.prepare(context);
}
