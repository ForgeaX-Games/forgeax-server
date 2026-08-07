import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type {
  MediaAsset,
  MediaBody,
  MediaCapability,
  MediaType,
  MediaWriteInput,
} from '@forgeax/workbench-host/contracts';
import type { VideoAssetService } from '../video-assets/service';
import type { VideoAssetRequestContext } from '../video-assets/contracts';
import type { KinoResourceDTO } from '../video-assets/kino-api';
import { KinoApiError } from '../video-assets/kino-api';

export type ForgeaxVideoAssetService = Pick<
  VideoAssetService,
  | 'listResources'
  | 'getResource'
  | 'playResource'
  | 'prepareUpload'
  | 'receiveUpload'
  | 'createResource'
  | 'deleteResource'
>;

export interface ForgeaxMediaCapabilityOptions {
  readonly runtimeId: string;
  readonly origin?: string;
  readonly identity?: (gameId: string) => string;
  readonly fetch?: typeof fetch;
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
    ?? (resource.media_type === 'video' ? 'video/mp4' : 'image/png');
}

function publicUrl(gameId: string, runtimeId: string, assetId: string): string {
  return `/__workbench__/v1/extension/${encodeURIComponent(runtimeId)}/media/assets/${encodeURIComponent(assetId)}?gameId=${encodeURIComponent(gameId)}`;
}

function toAsset(
  resource: KinoResourceDTO,
  runtimeId: string,
): MediaAsset {
  return {
    id: resource.resource_id,
    type: resource.media_type,
    contentType: contentType(resource),
    url: publicUrl(resource.game_id, runtimeId, resource.resource_id),
    metadata: {
      name: resource.name,
      type: resource.type,
      remark: resource.remark,
      source: resource.source,
      sourceMeta: resource.source_meta,
      createdAt: resource.created_at,
      updatedAt: resource.updated_at,
    },
  };
}

function mediaType(type: MediaType): 'image' | 'video' {
  if (type === 'image' || type === 'video') return type;
  throw new TypeError(`ForgeaX video assets do not support ${type}`);
}

function typeFor(input: MediaWriteInput): 'image' | 'video' {
  if (input.contentType.startsWith('image/')) return 'image';
  if (input.contentType === 'video/mp4') return 'video';
  throw new TypeError(`Unsupported ForgeaX media type: ${input.contentType}`);
}

function uploadFilename(input: MediaWriteInput): string {
  if (extname(input.filename)) return input.filename;
  const suffix = input.contentType === 'video/mp4'
    ? '.mp4'
    : input.contentType === 'image/jpeg'
      ? '.jpg'
      : input.contentType === 'image/webp'
        ? '.webp'
        : '.png';
  return `${input.filename}${suffix}`;
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
): MediaCapability {
  return {
    async list(gameId, query = {}): Promise<MediaAsset[]> {
      if (query.type === 'audio' || query.type === 'font') return [];
      const types: Array<'image' | 'video'> = query.type
        ? [mediaType(query.type)]
        : ['image', 'video'];
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
      const type = typeFor(input);
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
        mimeType: input.contentType as never,
        bytes: input.bytes.byteLength,
        ...(stableId ? { clientResourceId: stableId } : {}),
      }, context);
      const body = new Blob([new Uint8Array(input.bytes)]).stream();
      await service.receiveUpload(prepared.upload_token, body, context);
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
  };
}
