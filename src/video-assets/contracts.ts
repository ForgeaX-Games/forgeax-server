import type {
  CreateKinoResourceInput,
  KinoImageUploadSts,
  KinoImportProjectPage,
  KinoMediaType,
  KinoResourceDTO,
} from './kino-api';
import type { SupportedUploadMime } from './media-policy';

export type VideoAssetProviderKind = 'local' | 's3' | 'cos' | 'kino';
export type VideoAssetStatus = 'uploading' | 'ready' | 'failed';

export interface VideoAssetProviderCapabilities {
  provider: VideoAssetProviderKind;
  media_types: readonly KinoMediaType[];
  upload_mimes: readonly SupportedUploadMime[];
}

export interface ProviderMapping {
  kind: VideoAssetProviderKind;
  ref: string;
  upstreamResourceId?: string;
}

export interface VideoAsset {
  id: string;
  kind: KinoMediaType;
  name: string;
  status: VideoAssetStatus;
  mimeType: SupportedUploadMime;
  /** Zero is allowed only for remote resources whose upstream API omits object size. */
  bytes: number;
  durationMs?: number;
  productionType?:
    | 'character_ref'
    | 'scene_ref'
    | 'shot_image'
    | 'grid_storyboard'
    | 'video_clip';
  sourceModule?: string;
  createdAt: number;
  updatedAt: number;
  provider: ProviderMapping;
  error?: string;
  meta?: Record<string, unknown>;
}

export interface VideoAssetManifest {
  version: 2;
  assets: VideoAsset[];
}

export interface VideoAssetRequestContext {
  gameId: string;
  identity: string;
  authorization?: string;
  cookie?: string;
  origin: string;
}

export interface PrepareUploadInput {
  fileName: string;
  mediaType?: KinoMediaType;
  mimeType: SupportedUploadMime;
  bytes: number;
  /** Migration-only stable logical id. Normal upload clients omit this field. */
  clientResourceId?: string;
  /** Migration-only opt-in to replace an existing logical resource. */
  replaceExisting?: boolean;
}

export interface ProviderPrepareUploadInput extends PrepareUploadInput {
  uploadToken: string;
}

export interface DirectUploadInstruction {
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
}

export interface ProviderUploadDraft {
  instruction: DirectUploadInstruction;
  state: Record<string, unknown>;
}

export interface UploadedObject {
  ref: string;
  sourceUrl?: string;
  bytes: number;
  mimeType: SupportedUploadMime;
}

export type PlaybackSource =
  | {
      kind: 'local';
      filePath: string;
      mimeType: string;
      bytes: number;
      etag: string;
      lastModified: string;
    }
  | { kind: 'redirect'; url: string };

export interface UpstreamResource {
  upstreamResourceId: string;
  name: string;
  url: string;
  bytes?: number;
  durationMs?: number;
  mimeType?: SupportedUploadMime;
  createdAt: number;
  updatedAt: number;
}

export interface UpstreamResourcePage {
  items: UpstreamResource[];
  page: number;
  pageSize: number;
  total: number;
}

export interface VideoAssetProvider {
  readonly kind: VideoAssetProviderKind;
  /** Providers that omit this capability remain video-only. */
  readonly supportedMediaTypes?: readonly KinoMediaType[];
  /** Providers that omit this capability accept every public upload MIME. */
  readonly supportedUploadMimes?: readonly SupportedUploadMime[];
  prepareUpload(
    input: ProviderPrepareUploadInput,
    context: VideoAssetRequestContext,
  ): Promise<ProviderUploadDraft>;
  /** Optional documented Kino STS response for direct browser uploads. */
  prepareBrowserUpload?(
    input: PrepareUploadInput,
    context: VideoAssetRequestContext,
  ): Promise<KinoImageUploadSts>;
  /** Optional direct resource registration for an object uploaded to Kino COS. */
  createBrowserResource?(
    input: CreateKinoResourceInput,
    context: VideoAssetRequestContext,
  ): Promise<KinoResourceDTO>;
  /** Optional Kino project catalog used by the browser's external-import flow. */
  listImportProjects?(
    excludeGameId: string | undefined,
    context: VideoAssetRequestContext,
  ): Promise<KinoImportProjectPage>;
  receiveUpload?(
    state: Record<string, unknown>,
    body: ReadableStream<Uint8Array>,
    context: VideoAssetRequestContext,
  ): Promise<void>;
  cleanupUpload?(
    state: Record<string, unknown>,
    context: VideoAssetRequestContext,
  ): Promise<void>;
  inspectUpload(
    state: Record<string, unknown>,
    context: VideoAssetRequestContext,
  ): Promise<UploadedObject>;
  finalizeResource(
    object: UploadedObject,
    input: { resourceId: string; name: string; durationMs?: number },
    context: VideoAssetRequestContext,
  ): Promise<ProviderMapping>;
  cloneAsset?(
    asset: VideoAsset,
    sourceContext: VideoAssetRequestContext,
    targetContext: VideoAssetRequestContext,
  ): Promise<ProviderMapping>;
  getPlayback(
    asset: VideoAsset,
    context: VideoAssetRequestContext,
  ): Promise<PlaybackSource>;
  update?(
    asset: VideoAsset,
    context: VideoAssetRequestContext,
  ): Promise<void>;
  delete(
    asset: VideoAsset,
    context: VideoAssetRequestContext,
  ): Promise<void>;
  listUpstream?(
    mediaType: KinoMediaType,
    page: number,
    pageSize: number,
    context: VideoAssetRequestContext,
  ): Promise<UpstreamResourcePage>;
}

export interface VideoAssetProviderControl {
  setProvider(provider: VideoAssetProvider): void;
  sourceProvider(kind: VideoAssetProviderKind): VideoAssetProvider | undefined;
}
