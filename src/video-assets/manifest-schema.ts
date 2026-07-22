import type {
  ProviderMapping,
  VideoAsset,
  VideoAssetManifest,
  VideoAssetProviderKind,
  VideoAssetStatus,
} from './contracts';
import { isValidVideoAssetResourceId } from './resource-id';

export type VideoAssetManifestSchemaErrorCode =
  | 'invalid_manifest'
  | 'unsupported_manifest_version'
  | 'invalid_asset'
  | 'invalid_provider'
  | 'invalid_provider_kind'
  | 'invalid_provider_ref'
  | 'duplicate_asset_id'
  | 'duplicate_provider_ref';

export class VideoAssetManifestSchemaError extends Error {
  readonly code: VideoAssetManifestSchemaErrorCode;

  constructor(message: string, code: VideoAssetManifestSchemaErrorCode) {
    super(message);
    this.name = 'VideoAssetManifestSchemaError';
    this.code = code;
  }
}

const LOCAL_BLOB_REF_RE = /^blobs\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.mp4$/;
const PROVIDER_KINDS: readonly VideoAssetProviderKind[] = ['local', 's3', 'cos', 'kino'];
const STATUSES: readonly VideoAssetStatus[] = ['uploading', 'ready', 'failed'];

function assertPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function validateLocalVideoAssetRef(ref: string): void {
  if (
    ref.includes('\0') ||
    ref.includes('..') ||
    ref.startsWith('/') ||
    ref.startsWith('\\') ||
    !LOCAL_BLOB_REF_RE.test(ref)
  ) {
    throw new VideoAssetManifestSchemaError(
      'Invalid local provider ref',
      'invalid_provider_ref',
    );
  }
}

function assertProviderMapping(provider: unknown): asserts provider is ProviderMapping {
  if (!assertPlainRecord(provider)) {
    throw new VideoAssetManifestSchemaError('Invalid provider mapping', 'invalid_provider');
  }
  const mapping = provider as unknown as ProviderMapping;
  if (!PROVIDER_KINDS.includes(mapping.kind)) {
    throw new VideoAssetManifestSchemaError('Invalid provider kind', 'invalid_provider_kind');
  }
  if (typeof mapping.ref !== 'string' || mapping.ref.length === 0) {
    throw new VideoAssetManifestSchemaError('Invalid provider ref', 'invalid_provider_ref');
  }
  if (
    mapping.upstreamResourceId !== undefined &&
    (typeof mapping.upstreamResourceId !== 'string' ||
      mapping.upstreamResourceId.length === 0)
  ) {
    throw new VideoAssetManifestSchemaError(
      'Invalid upstream resource id',
      'invalid_provider',
    );
  }
  if (mapping.kind === 'local') {
    validateLocalVideoAssetRef(mapping.ref);
  }
}

function assertVideoAsset(asset: unknown): asserts asset is VideoAsset {
  if (!assertPlainRecord(asset)) {
    throw new VideoAssetManifestSchemaError('Invalid asset', 'invalid_asset');
  }
  const candidate = asset as unknown as VideoAsset;
  if (
    !isValidVideoAssetResourceId(candidate.id) ||
    candidate.kind !== 'video' ||
    typeof candidate.name !== 'string' ||
    !STATUSES.includes(candidate.status) ||
    candidate.mimeType !== 'video/mp4' ||
    !Number.isSafeInteger(candidate.bytes) ||
    candidate.bytes <= 0 ||
    (candidate.durationMs !== undefined &&
      (!Number.isSafeInteger(candidate.durationMs) || candidate.durationMs < 0)) ||
    typeof candidate.createdAt !== 'number' ||
    !Number.isFinite(candidate.createdAt) ||
    typeof candidate.updatedAt !== 'number' ||
    !Number.isFinite(candidate.updatedAt) ||
    (candidate.error !== undefined && typeof candidate.error !== 'string') ||
    (candidate.meta !== undefined && !assertPlainRecord(candidate.meta))
  ) {
    throw new VideoAssetManifestSchemaError('Invalid asset', 'invalid_asset');
  }
  assertProviderMapping(candidate.provider);
}

export function validateVideoAssetManifest(
  manifest: unknown,
): asserts manifest is VideoAssetManifest {
  if (!assertPlainRecord(manifest)) {
    throw new VideoAssetManifestSchemaError('Invalid manifest', 'invalid_manifest');
  }
  if (manifest.version !== 2) {
    throw new VideoAssetManifestSchemaError(
      'Unsupported manifest version',
      'unsupported_manifest_version',
    );
  }
  if (!Array.isArray(manifest.assets)) {
    throw new VideoAssetManifestSchemaError('Invalid manifest assets', 'invalid_manifest');
  }

  const seenIds = new Set<string>();
  const seenLocalRefs = new Set<string>();
  for (const asset of manifest.assets) {
    assertVideoAsset(asset);
    if (seenIds.has(asset.id)) {
      throw new VideoAssetManifestSchemaError(
        `Duplicate asset id: ${asset.id}`,
        'duplicate_asset_id',
      );
    }
    seenIds.add(asset.id);
    if (asset.provider.kind === 'local') {
      if (seenLocalRefs.has(asset.provider.ref)) {
        throw new VideoAssetManifestSchemaError(
          `Duplicate local provider ref: ${asset.provider.ref}`,
          'duplicate_provider_ref',
        );
      }
      seenLocalRefs.add(asset.provider.ref);
    }
  }
}

export function validateAndCloneVideoAssetManifest(
  manifest: unknown,
): VideoAssetManifest {
  validateVideoAssetManifest(manifest);
  return structuredClone(manifest);
}
