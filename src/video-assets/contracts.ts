export type VideoAssetProviderKind = 'local' | 's3' | 'cos' | 'kino';
export type VideoAssetStatus = 'uploading' | 'ready' | 'failed';

export interface ProviderMapping {
  kind: VideoAssetProviderKind;
  ref: string;
  upstreamResourceId?: string;
}

export interface VideoAsset {
  id: string;
  kind: 'video';
  name: string;
  status: VideoAssetStatus;
  mimeType: 'video/mp4';
  bytes: number;
  durationMs?: number;
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
  mimeType: 'video/mp4';
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
  mimeType: 'video/mp4';
}

export type PlaybackSource =
  | { kind: 'local'; filePath: string; mimeType: string; bytes: number }
  | { kind: 'redirect'; url: string };

export interface UpstreamVideoResource {
  upstreamResourceId: string;
  name: string;
  url: string;
  bytes?: number;
  durationMs?: number;
  mimeType?: string;
  createdAt: number;
  updatedAt: number;
}

export interface UpstreamVideoPage {
  items: UpstreamVideoResource[];
  page: number;
  pageSize: number;
  total: number;
}

export interface VideoAssetProvider {
  readonly kind: VideoAssetProviderKind;
  prepareUpload(
    input: ProviderPrepareUploadInput,
    context: VideoAssetRequestContext,
  ): Promise<ProviderUploadDraft>;
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
    page: number,
    pageSize: number,
    context: VideoAssetRequestContext,
  ): Promise<UpstreamVideoPage>;
}

export interface VideoAssetProviderControl {
  setProvider(provider: VideoAssetProvider): void;
}
