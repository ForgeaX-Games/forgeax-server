import type { Hono } from 'hono';
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
  UpstreamVideoPage,
  UpstreamVideoResource,
  VideoAsset,
  VideoAssetManifest,
  VideoAssetProvider,
  VideoAssetProviderControl,
  VideoAssetProviderKind,
  VideoAssetRequestContext,
  VideoAssetStatus,
} from './video-assets/contracts';

export interface ServerCompositionContext {
  app: Hono;
  services: {
    videoAssets: VideoAssetProviderControl;
  };
}

export interface ServerModule {
  activate(context: ServerCompositionContext): void | Promise<void>;
}
