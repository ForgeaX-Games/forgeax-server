import { randomUUID } from 'node:crypto';
import COS from 'cos-nodejs-sdk-v5';
import type {
  ProviderPrepareUploadInput,
  UploadedObject,
  VideoAssetProvider,
  VideoAssetRequestContext,
} from '../contracts';
import {
  assertScopedVideoObjectKey,
  buildVideoObjectKey,
  type CosVideoStorageConfig,
} from '../config';
import { KinoApiError } from '../kino-api';
import { MAX_VIDEO_UPLOAD_BYTES } from '../upload-sessions';

const PREPARE_TTL_SECONDS = 10 * 60;
const PLAYBACK_TTL_SECONDS = 5 * 60;
const PREPARE_TTL_MS = PREPARE_TTL_SECONDS * 1000;

export interface CosObjectClient {
  signPut(key: string, mimeType: string, expiresIn: number): Promise<string>;
  signGet(key: string, expiresIn: number): Promise<string>;
  head(key: string): Promise<{ bytes: number; mimeType?: string }>;
  delete(key: string): Promise<void>;
}

interface CloudUploadState {
  ref: string;
  bytes: number;
  mimeType: 'video/mp4';
}

export interface CreateDefaultCosObjectClientOptions {
  cos?: COS;
  cosFactory?: (options: COS.COSOptions) => COS;
}

export interface CosVideoAssetProviderOptions {
  client?: CosObjectClient;
  randomUuid?: () => string;
  createClient?: (config: CosVideoStorageConfig) => CosObjectClient;
}

function normalizeContentType(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.split(';', 1)[0]?.trim().toLowerCase();
}

function assertScopedProviderRef(key: string, gameId: string, prefix?: string): void {
  try {
    assertScopedVideoObjectKey(key, gameId, prefix);
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

  if (
    typeof bytes !== 'number' ||
    !Number.isFinite(bytes) ||
    bytes <= 0 ||
    bytes > MAX_VIDEO_UPLOAD_BYTES
  ) {
    throw new KinoApiError('Invalid upload size', 400, 'invalid_upload_size');
  }
  if (mimeType !== 'video/mp4') {
    throw new KinoApiError('Invalid upload mime type', 400, 'invalid_media_type');
  }

  return { ref, bytes, mimeType };
}

async function bestEffortDelete(client: CosObjectClient, key: string): Promise<void> {
  try {
    await client.delete(key);
  } catch {
    // Best-effort cleanup after upload validation failures.
  }
}

function getSignedObjectUrl(
  cos: COS,
  params: COS.GetObjectUrlParams,
): Promise<COS.GetObjectUrlResult> {
  return new Promise((resolve, reject) => {
    cos.getObjectUrl(params, (error, data) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(data);
    });
  });
}

export function buildCosSdkClientOptions(config: CosVideoStorageConfig): COS.COSOptions {
  const options: COS.COSOptions = {
    SecretId: config.secretId,
    SecretKey: config.secretKey,
  };
  if (config.endpoint) {
    // Service endpoint host without bucket; SDK replaces {Bucket} per request.
    options.Domain = `{Bucket}.${config.endpoint}`;
  }
  return options;
}

export function createDefaultCosObjectClient(
  config: CosVideoStorageConfig,
  options: CreateDefaultCosObjectClientOptions = {},
): CosObjectClient {
  const cos =
    options.cos ??
    (options.cosFactory ?? ((cosOptions: COS.COSOptions) => new COS(cosOptions)))(
      buildCosSdkClientOptions(config),
    );

  return {
    async signPut(key, mimeType, expiresIn) {
      const data = await getSignedObjectUrl(cos, {
        Bucket: config.bucket,
        Region: config.region,
        Key: key,
        Method: 'PUT',
        Sign: true,
        Expires: expiresIn,
        Headers: {
          'Content-Type': mimeType,
        },
      });
      if (!data.Url) {
        throw new KinoApiError('Failed to prepare upload', 500, 'provider_prepare_failed');
      }
      return data.Url;
    },
    async signGet(key, expiresIn) {
      const data = await getSignedObjectUrl(cos, {
        Bucket: config.bucket,
        Region: config.region,
        Key: key,
        Method: 'GET',
        Sign: true,
        Expires: expiresIn,
      });
      if (!data.Url) {
        throw new KinoApiError('Resource content not found', 404, 'resource_content_not_found');
      }
      return data.Url;
    },
    async head(key) {
      const data = await cos.headObject({
        Bucket: config.bucket,
        Region: config.region,
        Key: key,
      });
      const rawBytes = data.headers?.['content-length'];
      const bytes =
        typeof rawBytes === 'number'
          ? rawBytes
          : typeof rawBytes === 'string'
            ? Number.parseInt(rawBytes, 10)
            : Number.NaN;
      if (!Number.isFinite(bytes)) {
        throw new KinoApiError('Upload not found', 404, 'upload_not_found');
      }
      const mimeType = data.headers?.['content-type'];
      return {
        bytes,
        mimeType: typeof mimeType === 'string' ? mimeType : undefined,
      };
    },
    async delete(key) {
      await cos.deleteObject({
        Bucket: config.bucket,
        Region: config.region,
        Key: key,
      });
    },
  };
}

export function createCosVideoAssetProvider(
  config: CosVideoStorageConfig,
  options: CosVideoAssetProviderOptions = {},
): VideoAssetProvider {
  const client = options.client ?? options.createClient?.(config) ?? createDefaultCosObjectClient(config);
  const randomUuid = options.randomUuid ?? randomUUID;

  return {
    kind: 'cos',

    async prepareUpload(input: ProviderPrepareUploadInput, context: VideoAssetRequestContext) {
      const key = buildVideoObjectKey(context.gameId, randomUuid(), config.prefix);
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
      if (object.mimeType !== 'video/mp4') {
        throw new KinoApiError('Invalid upload mime type', 400, 'invalid_media_type');
      }
      return { kind: 'cos', ref: object.ref };
    },

    async getPlayback(asset, context) {
      assertScopedProviderRef(asset.provider.ref, context.gameId, config.prefix);
      const url = await client.signGet(asset.provider.ref, PLAYBACK_TTL_SECONDS);
      return { kind: 'redirect', url };
    },

    async delete(asset, context) {
      assertScopedProviderRef(asset.provider.ref, context.gameId, config.prefix);
      await bestEffortDelete(client, asset.provider.ref);
    },
  };
}
