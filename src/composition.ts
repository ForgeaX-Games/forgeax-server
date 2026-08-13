import type { Hono } from 'hono';
import type { ExtensionCapabilityControl } from '@forgeax/types';
import type { VideoAssetProviderControl } from './video-assets/contracts';
import type { VideoAssetService } from './video-assets/service';
import type { WorkbenchHost } from '@forgeax/workbench-host/node';
export { registerServerModule } from './composition-host';

export type {
  DirectUploadInstruction,
  PlaybackSource,
  PrepareUploadInput,
  ProviderMapping,
  ProviderPrepareUploadInput,
  ProviderUploadDraft,
  UploadedObject,
  UpstreamResource,
  UpstreamResourcePage,
  VideoAsset,
  VideoAssetManifest,
  VideoAssetProvider,
  VideoAssetProviderControl,
  VideoAssetProviderKind,
  VideoAssetRequestContext,
  VideoAssetStatus,
} from './video-assets/contracts';
export type {
  KinoImageUploadSts,
  KinoImportProjectPage,
  KinoResourceType,
} from './video-assets/kino-api';
export type {
  ExtensionCapabilityControl,
  ExtensionCapabilityInvocationContext,
  ExtensionCapabilityInvocationOptions,
  ExtensionCapabilityProvider,
} from '@forgeax/types';

export interface GameScopeControl {
  /** Return a validated instance-scoped game id, or null when it is unsafe/missing. */
  resolveGameId(slug: string): string | null;
}

export interface ServerCompositionContext {
  app: Hono;
  services: {
    videoAssets: VideoAssetProviderControl;
    capabilities: ExtensionCapabilityControl;
    games: GameScopeControl;
  };
}

/**
 * Inputs available while the public server is still assembling its app.
 * Product packages register a `prepare` hook on their ServerModule and return
 * only the optional capabilities they own. The base server never imports a
 * product extension in order to construct this value.
 */
export interface ServerPrepareContext {
  readonly projectRoot: string;
  readonly mediaService: VideoAssetService;
  readonly modelRouter: Hono;
  readonly cloneTemplateAssets: (input: {
    sourceGameDir: string;
    sourceGameId: string;
    targetGameDir: string;
    targetGameId: string;
  }) => Promise<void>;
  /** Resolve the active instance's game directory at call time. */
  readonly gameDirForSlug: (slug: string) => string;
}

export interface ServerProductComposition {
  readonly workbenchHost?: WorkbenchHost;
  readonly gameHostBeforeVersion?: (args: {
    slug: string;
    gameDir: string;
    project: unknown;
  }) => void | Promise<void>;
  readonly gameHostSeedProvider?: (args: { slug: string }) => Promise<{
    project?: unknown;
    blueprint: unknown;
    assetsManifest: unknown;
  }>;
}

export interface ServerModule {
  /** Runs before `createForgeaxApp`; intended for optional product assembly. */
  prepare?(context: ServerPrepareContext): ServerProductComposition | Promise<ServerProductComposition>;
  activate(context: ServerCompositionContext): void | Promise<void>;
}
