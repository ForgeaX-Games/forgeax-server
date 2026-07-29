import { randomUUID } from 'node:crypto';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type {
  ProviderPrepareUploadInput,
  UploadedObject,
  VideoAssetProvider,
  VideoAssetRequestContext,
} from '../contracts';
import {
  assertScopedMediaObjectKey,
  buildMediaObjectKey,
  type S3VideoStorageConfig,
} from '../config';
import { KinoApiError } from '../kino-api';
import {
  assertUploadMime,
  assertUploadSize,
  extensionForMime,
  type SupportedUploadMime,
} from '../media-policy';
import { createExpiringUrlCache } from './signed-url-cache';

const PREPARE_TTL_SECONDS = 10 * 60;
const PLAYBACK_TTL_SECONDS = 5 * 60;
const PLAYBACK_CACHE_TTL_SECONDS = PLAYBACK_TTL_SECONDS - 60;
const PLAYBACK_RESPONSE_CACHE_CONTROL = `private, max-age=${PLAYBACK_CACHE_TTL_SECONDS}`;
const PREPARE_TTL_MS = PREPARE_TTL_SECONDS * 1000;

export interface S3ObjectClient {
  signPut(key: string, mimeType: string, expiresIn: number): Promise<string>;
  signGet(key: string, expiresIn: number): Promise<string>;
  head(key: string): Promise<{ bytes: number; mimeType?: string }>;
  copy(sourceKey: string, targetKey: string): Promise<void>;
  delete(key: string): Promise<void>;
}

interface CloudUploadState {
  ref: string;
  bytes: number;
  mediaType: 'audio' | 'image' | 'video';
  mimeType: SupportedUploadMime;
}

export interface CreateDefaultS3ObjectClientOptions {
  client?: S3Client;
  getSignedUrl?: typeof getSignedUrl;
}

export interface S3VideoAssetProviderOptions {
  client?: S3ObjectClient;
  randomUuid?: () => string;
  now?: () => number;
  createClient?: (config: S3VideoStorageConfig) => S3ObjectClient;
}

function normalizeContentType(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.split(';', 1)[0]?.trim().toLowerCase();
}

function assertScopedProviderRef(key: string, gameId: string, prefix?: string): void {
  try {
    assertScopedMediaObjectKey(key, gameId, prefix);
  } catch {
    throw new KinoApiError('Invalid provider ref', 400, 'invalid_provider_ref');
  }
}

function parseUploadState(
  state: Record<string, unknown>,
  gameId: string,
  prefix?: string,
): CloudUploadState {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new KinoApiError('Invalid upload session', 400, 'invalid_upload_session');
  }

  const ref = state.ref;
  const bytes = state.bytes;
  const mimeType = state.mimeType;
  if (typeof ref !== 'string') {
    throw new KinoApiError('Invalid upload session', 400, 'invalid_upload_session');
  }
  assertScopedProviderRef(ref, gameId, prefix);

  const mediaType = state.mediaType ?? (mimeType === 'video/mp4' ? 'video' : undefined);
  if (mediaType !== 'audio' && mediaType !== 'image' && mediaType !== 'video') {
    throw new KinoApiError('Invalid upload session', 400, 'invalid_upload_session');
  }
  assertUploadMime(mediaType, mimeType);
  assertUploadSize(mediaType, bytes);

  return { ref, bytes, mediaType, mimeType };
}

async function bestEffortDelete(client: S3ObjectClient, key: string): Promise<void> {
  try {
    await client.delete(key);
  } catch {
    // Best-effort cleanup after upload validation failures.
  }
}

export function buildS3ClientConfig(config: S3VideoStorageConfig): S3ClientConfig {
  return {
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    ...(config.endpoint
      ? {
          endpoint: config.endpoint,
          forcePathStyle: true,
        }
      : {}),
  };
}

export function createDefaultS3ObjectClient(
  config: S3VideoStorageConfig,
  options: CreateDefaultS3ObjectClientOptions = {},
): S3ObjectClient {
  const client =
    options.client ??
    new S3Client(buildS3ClientConfig(config));
  const sign = options.getSignedUrl ?? getSignedUrl;

  return {
    async signPut(key, mimeType, expiresIn) {
      const command = new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        ContentType: mimeType,
      });
      return sign(client, command, {
        expiresIn,
        signableHeaders: new Set(['content-type']),
      });
    },
    async signGet(key, expiresIn) {
      const command = new GetObjectCommand({
        Bucket: config.bucket,
        Key: key,
        ResponseCacheControl: PLAYBACK_RESPONSE_CACHE_CONTROL,
      });
      return sign(client, command, { expiresIn });
    },
    async head(key) {
      const response = await client.send(
        new HeadObjectCommand({
          Bucket: config.bucket,
          Key: key,
        }),
      );
      if (response.ContentLength === undefined) {
        throw new KinoApiError('Upload not found', 404, 'upload_not_found');
      }
      return {
        bytes: response.ContentLength,
        mimeType: response.ContentType,
      };
    },
    async copy(sourceKey, targetKey) {
      await client.send(
        new CopyObjectCommand({
          Bucket: config.bucket,
          Key: targetKey,
          CopySource: `${config.bucket}/${encodeURIComponent(sourceKey)}`,
        }),
      );
    },
    async delete(key) {
      await client.send(
        new DeleteObjectCommand({
          Bucket: config.bucket,
          Key: key,
        }),
      );
    },
  };
}

export function createS3VideoAssetProvider(
  config: S3VideoStorageConfig,
  options: S3VideoAssetProviderOptions = {},
): VideoAssetProvider {
  const client = options.client ?? options.createClient?.(config) ?? createDefaultS3ObjectClient(config);
  const randomUuid = options.randomUuid ?? randomUUID;
  const playbackUrls = createExpiringUrlCache(
    PLAYBACK_CACHE_TTL_SECONDS * 1000,
    options.now,
  );

  return {
    kind: 's3',
    supportedMediaTypes: ['video', 'image', 'audio'],

    async prepareUpload(input: ProviderPrepareUploadInput, context: VideoAssetRequestContext) {
      const key = buildMediaObjectKey(
        context.gameId,
        randomUuid(),
        extensionForMime(input.mimeType),
        config.prefix,
      );
      const url = await client.signPut(key, input.mimeType, PREPARE_TTL_SECONDS);
      const expiresAt = new Date(Date.now() + PREPARE_TTL_MS).toISOString();

      return {
        instruction: {
          method: 'PUT' as const,
          url,
          headers: {
            'content-type': input.mimeType,
          },
          expiresAt,
        },
        state: {
          ref: key,
          bytes: input.bytes,
          ...(input.mimeType === 'video/mp4' ? {} : { mediaType: input.mediaType }),
          mimeType: input.mimeType,
        },
      };
    },

    async inspectUpload(state, context) {
      const upload = parseUploadState(state, context.gameId, config.prefix);
      let head: { bytes: number; mimeType?: string };
      try {
        head = await client.head(upload.ref);
      } catch {
        throw new KinoApiError('Upload not found', 404, 'upload_not_found');
      }

      if (head.bytes !== upload.bytes) {
        await bestEffortDelete(client, upload.ref);
        throw new KinoApiError('Invalid upload size', 400, 'invalid_upload_size');
      }

      if (normalizeContentType(head.mimeType) !== upload.mimeType) {
        await bestEffortDelete(client, upload.ref);
        throw new KinoApiError('Invalid upload mime type', 400, 'invalid_media_type');
      }

      return {
        ref: upload.ref,
        bytes: upload.bytes,
        mimeType: upload.mimeType,
      } satisfies UploadedObject;
    },

    async finalizeResource(object, _input, context) {
      assertScopedProviderRef(object.ref, context.gameId, config.prefix);
      return { kind: 's3', ref: object.ref };
    },

    async cloneAsset(asset, sourceContext, targetContext) {
      assertScopedProviderRef(asset.provider.ref, sourceContext.gameId, config.prefix);
      const targetRef = buildMediaObjectKey(
        targetContext.gameId,
        randomUuid(),
        extensionForMime(asset.mimeType),
        config.prefix,
      );
      await client.copy(asset.provider.ref, targetRef);
      return { kind: 's3', ref: targetRef };
    },

    async getPlayback(asset, context) {
      assertScopedProviderRef(asset.provider.ref, context.gameId, config.prefix);
      const url = await playbackUrls.get(
        asset.provider.ref,
        () => client.signGet(asset.provider.ref, PLAYBACK_TTL_SECONDS),
      );
      return { kind: 'redirect', url };
    },

    async delete(asset, context) {
      assertScopedProviderRef(asset.provider.ref, context.gameId, config.prefix);
      playbackUrls.delete(asset.provider.ref);
      await bestEffortDelete(client, asset.provider.ref);
    },
  };
}
