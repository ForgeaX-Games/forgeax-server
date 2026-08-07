import type { Hono } from 'hono';
import type { ExtensionCapabilityControl } from '@forgeax/types';
import type { VideoAssetProviderControl } from './video-assets/contracts';
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

export interface ServerModule {
  activate(context: ServerCompositionContext): void | Promise<void>;
}
