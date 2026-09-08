import {
  createScopedExtensionCapabilities,
  type ExtensionCapabilityInvocationContext,
  type ScopedExtensionCapabilities,
} from '@forgeax/orchestrator';
import type { ExtensionCapabilityResolver } from '@forgeax/extension-host/contracts';

export interface ForgeaxExtensionCapabilityResolverOptions {
  readonly projectRoot: string;
  readonly createScopedCapabilities?: (
    context: ExtensionCapabilityInvocationContext,
  ) => ScopedExtensionCapabilities;
}

/**
 * Projects the process-wide ForgeaX capability registry into the game-scoped
 * extension-host contract. Provider lookup deliberately happens on every invoke so
 * private server modules may register providers after the extension host is
 * constructed but before the first tool call.
 */
export function createForgeaxExtensionCapabilityResolver(
  options: ForgeaxExtensionCapabilityResolverOptions,
): ExtensionCapabilityResolver {
  const createScoped = options.createScopedCapabilities
    ?? createScopedExtensionCapabilities;

  return {
    forGame(gameId) {
      const capabilities = createScoped({
        caller: { kind: 'extension' },
        toolId: 'extension-host',
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
