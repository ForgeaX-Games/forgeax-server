import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type {
  MediaAsset,
  MediaBody,
  MediaUpdateInput,
  MediaType,
  MediaWriteInput,
  ResumableMediaCapability,
} from '@forgeax/workbench-host/contracts';
import type { VideoAssetService } from '../video-assets/service';
import type { VideoAssetRequestContext } from '../video-assets/contracts';
import type { KinoResourceDTO } from '../video-assets/kino-api';
import { KinoApiError } from '../video-assets/kino-api';
import { resolveGameDir } from '../video-assets/game-path';
import {
  assertUploadFileName,
  assertUploadMime,
  assertUploadSize,
  extensionForMime,
  mediaTypeForMime,
} from '../video-assets/media-policy';
import { ForgeaxMediaUploadStore } from './media-upload-store';

export type ForgeaxVideoAssetService = Pick<
  VideoAssetService,
  | 'listResources'
  | 'getResource'
  | 'playResource'
  | 'prepareUpload'
  | 'receiveUpload'
  | 'createResource'
  | 'updateResource'
  | 'deleteResource'
> & Partial<Pick<
  VideoAssetService,
  'getProviderCapabilities' | 'getProviderUploadTransport'
>>;

export interface ForgeaxMediaCapabilityOptions {
  readonly runtimeId: string;
  readonly projectRoot: string;
  readonly origin?: string;
  readonly identity?: (gameId: string) => string;
  readonly fetch?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
}

function requestContext(
  gameId: string,
  options: ForgeaxMediaCapabilityOptions,
): VideoAssetRequestContext {
  return {
    gameId,
    identity: options.identity?.(gameId) ?? `workbench-host:${gameId}`,
    origin: options.origin ?? 'http://127.0.0.1',
  };
}

function contentType(resource: KinoResourceDTO): string {
  return resource.source_meta?.mime_type
    ?? {
      video: 'video/mp4',
      image: 'image/png',
      audio: 'audio/mpeg',
      font: 'font/woff2',
    }[resource.media_type];
}

function publicUrl(gameId: string, runtimeId: string, assetId: string): string {
  return `/__workbench__/v1/extension/${encodeURIComponent(runtimeId)}/media/resources/${encodeURIComponent(assetId)}/content?gameId=${encodeURIComponent(gameId)}`;
}

function toAsset(
  resource: KinoResourceDTO,
  runtimeId: string,
): MediaAsset {
  const extra = Object.fromEntries(
    Object.entries(resource.source_meta?.extra ?? {})
      .filter(([key]) => key !== 'workbench_fingerprint'),
  );
  const { mime_type: _mimeType, extra: _extra, ...sourceMeta } = resource.source_meta ?? {};
  const metadata = {
    ...extra,
    ...sourceMeta,
    ...(resource.type === undefined ? {} : { type: resource.type }),
    ...(resource.remark === undefined ? {} : { remark: resource.remark }),
    ...(resource.source === undefined ? {} : { source: resource.source }),
    created_at: resource.created_at,
    updated_at: resource.updated_at,
  };
  const sizeBytes = extra?.bytes;
  return {
    id: resource.resource_id,
    ...(resource.name === undefined ? {} : { filename: resource.name }),
    type: resource.media_type,
    contentType: contentType(resource),
    url: publicUrl(resource.game_id, runtimeId, resource.resource_id),
    ...(typeof sizeBytes === 'number' && Number.isSafeInteger(sizeBytes) && sizeBytes >= 0
      ? { sizeBytes }
      : {}),
    metadata,
  };
}

function mediaType(type: MediaType): MediaType {
  return type;
}

function providerMediaTypes(service: ForgeaxVideoAssetService): MediaType[] {
  const configured = service.getProviderCapabilities?.().media_types ?? ['image', 'video'];
  return [...new Set(configured.map(mediaType))];
}

function typeFor(contentType: string): MediaType {
  const type = mediaTypeForMime(contentType);
  if (type !== null) return type;
  throw new TypeError(`Unsupported ForgeaX media type: ${contentType}`);
}

function uploadFilename(input: MediaWriteInput): string {
  if (extname(input.filename)) return input.filename;
  const type = typeFor(input.contentType);
  assertUploadMime(type, input.contentType);
  return `${input.filename}.${extensionForMime(input.contentType)}`;
}

function fingerprint(input: MediaWriteInput): string {
  return createHash('sha256')
    .update(input.filename)
    .update('\0')
    .update(input.contentType)
    .update('\0')
    .update(input.bytes)
    .update('\0')
    .update(JSON.stringify(input.metadata ?? null))
    .digest('hex');
}

function resourceId(key: string): string {
  return `workbench-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
}

/** Project the existing ForgeaX video-asset provider stack as Host media. */
export function createForgeaxMediaCapability(
  service: ForgeaxVideoAssetService,
  options: ForgeaxMediaCapabilityOptions,
): ResumableMediaCapability {
  const uploads = new ForgeaxMediaUploadStore((gameId) => join(
    resolveGameDir(gameId, () => options.projectRoot),
    'assets',
    '.workbench-uploads',
  ));
  const capability: ResumableMediaCapability = {
    async list(gameId, query = {}): Promise<MediaAsset[]> {
      const supportedTypes = providerMediaTypes(service);
      if (query.type !== undefined && !supportedTypes.includes(query.type)) return [];
      const types = query.type ? [mediaType(query.type)] : supportedTypes;
      const pages = await Promise.all(types.map((type) => service.listResources({
        game_id: gameId,
        media_type: type,
        page: 1,
        page_size: 100,
      }, requestContext(gameId, options))));
      let assets = pages.flatMap((page) => page.items).map((item) => toAsset(item, options.runtimeId));
      if (query.cursor) {
        const index = assets.findIndex((asset) => asset.id === query.cursor);
        if (index < 0) throw new TypeError('Media cursor is invalid');
        assets = assets.slice(index + 1);
      }
      if (query.limit !== undefined) assets = assets.slice(0, query.limit);
      return assets;
    },

    async read(gameId, assetId): Promise<MediaBody | null> {
      const context = requestContext(gameId, options);
      try {
        const source = await service.playResource(assetId, context);
        if (source.kind === 'local') {
          return {
            contentType: source.mimeType,
            bytes: new Uint8Array(await readFile(source.filePath)),
          };
        }
        const response = await (options.fetch ?? fetch)(source.url);
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`Media provider returned ${response.status}`);
        return {
          contentType: response.headers.get('content-type') ?? 'application/octet-stream',
          bytes: new Uint8Array(await response.arrayBuffer()),
        };
      } catch (error) {
        if (error instanceof KinoApiError && error.status === 404) return null;
        throw error;
      }
    },

    async put(gameId, input): Promise<MediaAsset> {
      const context = requestContext(gameId, options);
      const type = typeFor(input.contentType);
      assertUploadMime(type, input.contentType);
      const digest = fingerprint(input);
      const stableId = input.idempotencyKey ? resourceId(input.idempotencyKey) : undefined;
      if (stableId) {
        try {
          const existing = await service.getResource(stableId, context);
          if (existing.source_meta?.extra?.workbench_fingerprint !== digest) {
            throw new Error('Media idempotency key was reused with different input');
          }
          return toAsset(existing, options.runtimeId);
        } catch (error) {
          if (!(error instanceof KinoApiError) || error.status !== 404) throw error;
        }
      }

      const prepared = await service.prepareUpload({
        fileName: uploadFilename(input),
        mediaType: type,
        mimeType: input.contentType,
        bytes: input.bytes.byteLength,
        ...(stableId ? { clientResourceId: stableId } : {}),
      }, context);
      if ((service.getProviderUploadTransport?.() ?? 'receiver') === 'receiver') {
        const body = new Blob([new Uint8Array(input.bytes)]).stream();
        await service.receiveUpload(prepared.upload_token, body, context);
      } else {
        const response = await (options.fetch ?? fetch)(prepared.upload.url, {
          method: prepared.upload.method,
          headers: prepared.upload.headers,
          body: new Blob([new Uint8Array(input.bytes)]),
        });
        if (!response.ok) {
          throw new Error(`Media provider upload returned HTTP ${response.status}`);
        }
      }
      const created = await service.createResource({
        game_id: gameId,
        media_type: type,
        url: prepared.object_url,
        name: input.filename,
        type: 'UPLOAD',
        source: 'workbench-host',
        source_meta: {
          mime_type: input.contentType,
          extra: {
            ...(input.metadata ?? {}),
            workbench_fingerprint: digest,
          },
        },
      }, context);
      return toAsset(created, options.runtimeId);
    },

    async delete(gameId, assetId): Promise<void> {
      try {
        await service.deleteResource(assetId, requestContext(gameId, options));
      } catch (error) {
        if (!(error instanceof KinoApiError) || error.status !== 404) throw error;
      }
    },

    async update(
      gameId: string,
      assetId: string,
      input: MediaUpdateInput,
    ): Promise<MediaAsset | null> {
      const context = requestContext(gameId, options);
      try {
        const existing = await service.getResource(assetId, context);
        const fingerprint = existing.source_meta?.extra?.workbench_fingerprint;
        const nextExtra = input.metadata === undefined
          ? existing.source_meta?.extra
          : {
              ...input.metadata,
              ...(typeof fingerprint === 'string' ? { workbench_fingerprint: fingerprint } : {}),
            };
        const updated = await service.updateResource(assetId, {
          resource_id: assetId,
          game_id: gameId,
          media_type: existing.media_type,
          url: existing.url,
          name: input.filename ?? existing.name,
          type: existing.type,
          remark: existing.remark,
          source: existing.source,
          source_meta: {
            ...existing.source_meta,
            ...(nextExtra === undefined ? {} : { extra: nextExtra }),
          },
        }, context);
        return toAsset(updated, options.runtimeId);
      } catch (error) {
        if (error instanceof KinoApiError && error.status === 404) return null;
        throw error;
      }
    },

    async createUpload(gameId, input) {
      const type = typeFor(input.contentType);
      assertUploadMime(type, input.contentType);
      assertUploadFileName(input.filename, input.contentType);
      assertUploadSize(type, input.sizeBytes);
      return uploads.create(gameId, input);
    },

    async getUpload(gameId, uploadId) {
      return uploads.get(gameId, uploadId);
    },

    async writeUploadChunk(gameId, uploadId, input) {
      return uploads.writeChunk(gameId, uploadId, input);
    },

    async completeUpload(gameId, uploadId) {
      return uploads.complete(gameId, uploadId, async (completed) => {
        if (completed.assetId !== undefined) {
          try {
            const existing = await service.getResource(
              completed.assetId,
              requestContext(gameId, options),
            );
            return {
              asset: toAsset(existing, options.runtimeId),
              assetId: completed.assetId,
            };
          } catch (error) {
            if (!(error instanceof KinoApiError) || error.status !== 404) throw error;
          }
        }
        const asset = await capability.put(gameId, {
          filename: completed.upload.filename,
          contentType: completed.upload.contentType,
          bytes: await completed.readBytes(),
          ...(completed.upload.metadata === undefined ? {} : { metadata: completed.upload.metadata }),
          idempotencyKey: `upload:${uploadId}`,
        });
        return { asset, assetId: asset.id };
      });
    },
  };
  return capability;
}
