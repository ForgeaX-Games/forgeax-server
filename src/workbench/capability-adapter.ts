import {
  createScopedExtensionCapabilities,
  type ExtensionCapabilityInvocationContext,
  type ScopedExtensionCapabilities,
} from '@forgeax/orchestrator';
import type { WorkbenchCapabilityResolver } from '@forgeax/workbench-host/contracts';

export interface ForgeaxWorkbenchCapabilityResolverOptions {
  readonly projectRoot: string;
  readonly createScopedCapabilities?: (
    context: ExtensionCapabilityInvocationContext,
  ) => ScopedExtensionCapabilities;
}

/**
 * Projects the process-wide ForgeaX capability registry into the game-scoped
 * Workbench contract. Provider lookup deliberately happens on every invoke so
 * private server modules may register providers after the Workbench host is
 * constructed but before the first tool call.
 */
export function createForgeaxWorkbenchCapabilityResolver(
  options: ForgeaxWorkbenchCapabilityResolverOptions,
): WorkbenchCapabilityResolver {
  const createScoped = options.createScopedCapabilities
    ?? createScopedExtensionCapabilities;

  return {
    forGame(gameId) {
      const capabilities = createScoped({
        caller: { kind: 'workbench' },
        toolId: 'workbench-host',
        env: {},
        cwd: options.projectRoot,
        projectRoot: options.projectRoot,
        game: gameId,
      });
      return {
        invoke: (id, version, input, invokeOptions) => (
          capabilities.invoke(id, version, input, invokeOptions)
        ),
      };
    },
  };
}
