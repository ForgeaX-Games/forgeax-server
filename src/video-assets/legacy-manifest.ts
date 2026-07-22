import type { VideoAsset, VideoAssetManifest } from './contracts';
import {
  validateAndCloneVideoAssetManifest,
  validateLocalVideoAssetRef,
  VideoAssetManifestSchemaError,
} from './manifest-schema';

export interface VideoAssetManifestV1Asset {
  id: string;
  kind: 'video';
  filename: string;
  mimeType: string;
  bytes: number;
  createdAt: number;
  updatedAt?: number;
  meta?: Record<string, unknown>;
}

export interface VideoAssetManifestV1 {
  version: 1;
  assets: VideoAssetManifestV1Asset[];
}

export type VideoAssetManifestInput =
  | VideoAssetManifest
  | VideoAssetManifestV1
  | Record<string, unknown>;

export class VideoAssetMigrationError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, code: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'VideoAssetMigrationError';
    this.code = code;
    this.details = details;
  }
}

function assertSafePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new VideoAssetMigrationError(`Invalid ${field}`, 'invalid_manifest_schema', { field });
  }
  return value;
}

function assertSafeLocalRef(ref: string): void {
  try {
    validateLocalVideoAssetRef(ref);
  } catch {
    throw new VideoAssetMigrationError(`Unsafe local blob path: ${ref}`, 'invalid_manifest_path', {
      ref,
    });
  }
}

function sanitizeMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) {
    return undefined;
  }
  const next: Record<string, unknown> = { ...meta };
  delete next.mediaId;
  delete next.filename;
  return Object.keys(next).length > 0 ? next : undefined;
}

function assertV1Asset(asset: unknown, index: number): asserts asset is VideoAssetManifestV1Asset {
  if (!asset || typeof asset !== 'object' || Array.isArray(asset)) {
    throw new VideoAssetMigrationError(`Invalid v1 asset at index ${index}`, 'invalid_manifest_schema');
  }
  const candidate = asset as VideoAssetManifestV1Asset;
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    throw new VideoAssetMigrationError(`Invalid v1 asset id at index ${index}`, 'invalid_manifest_schema');
  }
  if (candidate.kind !== 'video') {
    throw new VideoAssetMigrationError(`Invalid v1 asset kind at index ${index}`, 'invalid_manifest_schema');
  }
  if (typeof candidate.filename !== 'string' || candidate.filename.length === 0) {
    throw new VideoAssetMigrationError(`Invalid v1 filename at index ${index}`, 'invalid_manifest_schema');
  }
  assertSafeLocalRef(candidate.filename);
  if (candidate.mimeType !== 'video/mp4') {
    throw new VideoAssetMigrationError(`Invalid v1 mime type at index ${index}`, 'invalid_manifest_schema');
  }
  assertSafePositiveInteger(candidate.bytes, `bytes at index ${index}`);
  assertSafePositiveInteger(candidate.createdAt, `createdAt at index ${index}`);
  if (candidate.updatedAt !== undefined) {
    assertSafePositiveInteger(candidate.updatedAt, `updatedAt at index ${index}`);
  }
}

function mapV2SchemaError(error: unknown): never {
  if (error instanceof VideoAssetManifestSchemaError) {
    const code =
      error.code === 'duplicate_asset_id' || error.code === 'duplicate_provider_ref'
        ? error.code
        : error.code === 'unsupported_manifest_version'
          ? error.code
          : 'invalid_manifest_schema';
    throw new VideoAssetMigrationError(error.message, code);
  }
  throw error;
}

function convertV1Asset(asset: VideoAssetManifestV1Asset): VideoAsset {
  const mediaId =
    typeof asset.meta?.mediaId === 'string' && asset.meta.mediaId.length > 0
      ? asset.meta.mediaId
      : undefined;
  const stableId = mediaId ?? asset.id;
  const updatedAt = asset.updatedAt ?? asset.createdAt;
  return {
    id: stableId,
    kind: 'video',
    name: asset.id,
    status: 'ready',
    mimeType: 'video/mp4',
    bytes: asset.bytes,
    createdAt: asset.createdAt,
    updatedAt,
    provider: {
      kind: 'local',
      ref: asset.filename,
    },
    meta: sanitizeMeta(asset.meta),
  };
}

export function convertVideoManifestV1(input: VideoAssetManifestInput): VideoAssetManifest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new VideoAssetMigrationError('Invalid manifest', 'invalid_manifest_schema');
  }

  const version = (input as { version?: unknown }).version;
  if (version === 2) {
    try {
      return validateAndCloneVideoAssetManifest(input);
    } catch (error) {
      mapV2SchemaError(error);
    }
  }
  if (version !== 1) {
    throw new VideoAssetMigrationError('Unsupported manifest version', 'unsupported_manifest_version');
  }

  const v1 = input as VideoAssetManifestV1;
  if (!Array.isArray(v1.assets)) {
    throw new VideoAssetMigrationError('Invalid v1 assets', 'invalid_manifest_schema');
  }

  const convertedAssets = v1.assets.map((asset, index) => {
    assertV1Asset(asset, index);
    return convertV1Asset(asset);
  });

  try {
    return validateAndCloneVideoAssetManifest({
      version: 2,
      assets: convertedAssets,
    });
  } catch (error) {
    mapV2SchemaError(error);
  }
}
