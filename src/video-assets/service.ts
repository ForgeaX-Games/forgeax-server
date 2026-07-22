import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import type {
  PlaybackSource,
  PrepareUploadInput,
  UpstreamVideoResource,
  VideoAsset,
  VideoAssetRequestContext,
} from './contracts';
import type { ProjectRootResolver } from './game-path';
import { resolveGameDir } from './game-path';
import type {
  BatchCreateKinoResourcesInput,
  BatchCreateKinoResourcesResult,
  CreateKinoResourceInput,
  KinoResourceDTO,
  KinoResourcePage,
  KinoResourceSourceMeta,
  KinoResourceType,
  UpdateKinoResourceInput,
} from './kino-api';
import { KinoApiError } from './kino-api';
import { VideoAssetManifestRepository } from './manifest-repository';
import { VideoAssetProviderRegistry } from './provider-registry';
import {
  MAX_VIDEO_UPLOAD_BYTES,
  VIDEO_UPLOAD_MIME,
  type UploadSession,
  type ValidateUploadSessionInput,
} from './upload-sessions';
import { isValidVideoAssetResourceId } from './resource-id';

export interface UploadSessionRepository {
  write(session: UploadSession): Promise<void>;
  read(token: string, gameId: string): Promise<UploadSession | null>;
  validate(session: UploadSession, input: ValidateUploadSessionInput, now?: number): void;
  reserve(token: string, resourceId: string, gameId: string): Promise<UploadSession>;
  complete(token: string, resourceId: string, gameId: string): Promise<UploadSession>;
}

const UPLOAD_TOKEN_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const DEFAULT_RECONCILE_TTL_MS = 5_000;
const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;

export interface PrepareUploadResponse {
  upload: {
    method: 'PUT';
    url: string;
    headers: Record<string, string>;
    expires_at: string;
  };
  object_url: string;
  upload_token: string;
}

export interface ListResourcesQuery {
  game_id: string;
  media_type: 'video';
  page?: number;
  page_size?: number;
}

export interface VideoAssetServiceDeps {
  getProjectRoot: ProjectRootResolver;
  providers: VideoAssetProviderRegistry;
  manifest: VideoAssetManifestRepository;
  uploadSessions: UploadSessionRepository;
  now?: () => number;
  id?: () => string;
  reconcileTtlMs?: number;
}

interface AssetMeta {
  type?: KinoResourceType;
  remark?: string;
  source?: string;
  sourceMeta?: KinoResourceSourceMeta;
}

interface BatchPendingResource {
  resource: Omit<CreateKinoResourceInput, 'game_id'> & { media_type: 'video' };
  token: string;
  session: UploadSession;
  existing?: VideoAsset;
  replaceTarget?: VideoAsset;
  finalized?: VideoAsset;
}

function nowOf(deps: VideoAssetServiceDeps): () => number {
  return deps.now ?? (() => Date.now());
}

function idOf(deps: VideoAssetServiceDeps): () => string {
  return deps.id ?? (() => randomUUID());
}

function assertMp4FileName(fileName: string): void {
  if (typeof fileName !== 'string' || fileName.trim().length === 0 || !fileName.endsWith('.mp4')) {
    throw new KinoApiError('Invalid upload file name', 400, 'invalid_file_name');
  }
}

function assertUploadSize(bytes: number): void {
  if (
    !Number.isSafeInteger(bytes) ||
    bytes <= 0 ||
    bytes > MAX_VIDEO_UPLOAD_BYTES
  ) {
    throw new KinoApiError('Invalid upload size', 400, 'invalid_upload_size');
  }
}

function assertClientResourceId(resourceId: string): void {
  if (!isValidVideoAssetResourceId(resourceId)) {
    throw new KinoApiError('Invalid client resource id', 400, 'invalid_client_resource_id');
  }
}

function assertVideoMime(mimeType: string): asserts mimeType is typeof VIDEO_UPLOAD_MIME {
  if (mimeType !== VIDEO_UPLOAD_MIME) {
    throw new KinoApiError('Invalid upload mime type', 400, 'invalid_media_type');
  }
}

function parsePagination(page?: number, pageSize?: number): { page: number; pageSize: number } {
  const resolvedPage = page ?? DEFAULT_PAGE;
  const resolvedPageSize = pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(resolvedPage) || resolvedPage < 1) {
    throw new KinoApiError('Invalid page', 400, 'invalid_page');
  }
  if (!Number.isInteger(resolvedPageSize) || resolvedPageSize < 1 || resolvedPageSize > MAX_PAGE_SIZE) {
    throw new KinoApiError('Invalid page size', 400, 'invalid_page_size');
  }
  return { page: resolvedPage, pageSize: resolvedPageSize };
}

function buildContentUrl(resourceId: string, context: VideoAssetRequestContext): string {
  return `${context.origin}/api/v1/kino/resources/${encodeURIComponent(resourceId)}/content?game_id=${encodeURIComponent(context.gameId)}`;
}

function buildObjectUrl(token: string, context: VideoAssetRequestContext): string {
  return `${context.origin}/api/v1/kino/uploads/${token}`;
}

function uploadFingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function stableJson(value: unknown): string {
  if (value === undefined) {
    return '"$undefined"';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? '"$undefined"';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function replacementFingerprint(asset: VideoAsset): string {
  return createHash('sha256')
    .update(
      stableJson({
        id: asset.id,
        kind: asset.kind,
        name: asset.name,
        status: asset.status,
        mimeType: asset.mimeType,
        bytes: asset.bytes,
        durationMs: asset.durationMs,
        createdAt: asset.createdAt,
        updatedAt: asset.updatedAt,
        provider: asset.provider,
        error: asset.error,
        meta: asset.meta,
      }),
      'utf8',
    )
    .digest('hex');
}

export function parseUploadTokenFromReference(
  reference: string,
  origin: string,
): string {
  let url: URL;
  try {
    url = new URL(reference);
  } catch {
    throw new KinoApiError('Invalid upload reference', 400, 'invalid_upload_reference');
  }
  if (url.origin !== origin) {
    throw new KinoApiError('Invalid upload reference', 400, 'invalid_upload_reference');
  }

  const match = url.pathname.match(/^\/api\/v1\/kino\/uploads\/([^/]+)$/);
  if (!match) {
    throw new KinoApiError('Invalid upload reference', 400, 'invalid_upload_reference');
  }

  const token = decodeURIComponent(match[1] ?? '');
  if (!UPLOAD_TOKEN_RE.test(token)) {
    throw new KinoApiError('Invalid upload reference', 400, 'invalid_upload_reference');
  }
  return token;
}

function readAssetMeta(asset: VideoAsset): AssetMeta {
  const meta = asset.meta ?? {};
  return {
    type: meta.type as KinoResourceType | undefined,
    remark: meta.remark as string | undefined,
    source: meta.source as string | undefined,
    sourceMeta: meta.sourceMeta as KinoResourceSourceMeta | undefined,
  };
}

function toDto(asset: VideoAsset, context: VideoAssetRequestContext): KinoResourceDTO {
  const meta = readAssetMeta(asset);
  return {
    resource_id: asset.id,
    game_id: context.gameId,
    media_type: 'video',
    name: asset.name,
    type: meta.type,
    url: buildContentUrl(asset.id, context),
    remark: meta.remark,
    source: meta.source,
    source_meta: meta.sourceMeta,
    created_at: asset.createdAt,
    updated_at: asset.updatedAt,
  };
}

function readyAssets(manifestAssets: VideoAsset[]): VideoAsset[] {
  return manifestAssets.filter((asset) => asset.status === 'ready');
}

export class VideoAssetService {
  readonly #deps: VideoAssetServiceDeps;
  readonly #reconcileAt = new Map<string, number>();
  readonly #tokenLocks = new Map<string, Promise<void>>();

  constructor(deps: VideoAssetServiceDeps) {
    this.#deps = deps;
  }

  #resolveGameDir(context: VideoAssetRequestContext): string {
    return resolveGameDir(context.gameId, this.#deps.getProjectRoot);
  }

  async prepareUpload(
    input: PrepareUploadInput,
    context: VideoAssetRequestContext,
  ): Promise<PrepareUploadResponse> {
    const gameDir = this.#resolveGameDir(context);
    assertMp4FileName(input.fileName);
    assertVideoMime(input.mimeType);
    assertUploadSize(input.bytes);
    if (input.replaceExisting && input.clientResourceId === undefined) {
      throw new KinoApiError(
        'replace_existing requires client_resource_id',
        400,
        'invalid_replace_existing',
      );
    }

    let reservedResourceId: string | undefined;
    let replaceExpectedFingerprint: string | undefined;
    if (input.clientResourceId !== undefined) {
      assertClientResourceId(input.clientResourceId);
      const existing = await this.#deps.manifest.get(gameDir, input.clientResourceId);
      if (existing && !input.replaceExisting) {
        throw new KinoApiError('Resource id already exists', 409, 'resource_id_conflict');
      }
      if (!existing && input.replaceExisting) {
        throw new KinoApiError(
          'Replacement target does not exist',
          400,
          'replace_target_not_found',
        );
      }
      reservedResourceId = input.clientResourceId;
      if (input.replaceExisting && existing) {
        replaceExpectedFingerprint = replacementFingerprint(existing);
      }
    }

    const provider = this.#deps.providers.current();
    const token = randomUUID();

    const draft = await provider.prepareUpload(
      {
        ...input,
        uploadToken: token,
      },
      context,
    );

    const now = nowOf(this.#deps)();
    const session: UploadSession = {
      token,
      gameId: context.gameId,
      identity: context.identity,
      fileName: input.fileName,
      mimeType: input.mimeType,
      bytes: input.bytes,
      createdAt: now,
      expiresAt: now + DEFAULT_SESSION_TTL_MS,
      providerKind: provider.kind,
      providerState: draft.state,
      ...(reservedResourceId ? { resourceId: reservedResourceId } : {}),
      ...(input.replaceExisting ? { replaceExisting: true } : {}),
      ...(replaceExpectedFingerprint
        ? { replaceExpectedFingerprint }
        : {}),
    };

    await this.#deps.uploadSessions.write(session);

    return {
      upload: {
        method: draft.instruction.method,
        url: draft.instruction.url,
        headers: draft.instruction.headers,
        expires_at: draft.instruction.expiresAt,
      },
      object_url: buildObjectUrl(token, context),
      upload_token: token,
    };
  }

  async receiveUpload(
    token: string,
    body: ReadableStream<Uint8Array>,
    context: VideoAssetRequestContext,
  ): Promise<void> {
    return this.#withTokenLock(token, async () => {
      this.#resolveGameDir(context);
      const session = await this.#requirePendingSession(token, context);
      if (session.completedResourceId) {
        throw new KinoApiError(
          'Upload session is already completed',
          409,
          'upload_session_completed',
        );
      }
      const provider = this.#deps.providers.current();
      if (provider.kind !== session.providerKind) {
        throw new KinoApiError('Upload session provider mismatch', 409, 'upload_session_provider_mismatch');
      }
      if (typeof provider.receiveUpload !== 'function') {
        throw new KinoApiError('Upload receiver unavailable', 501, 'upload_receiver_unavailable');
      }

      await provider.receiveUpload(session.providerState, body, context);
    });
  }

  async createResource(
    input: CreateKinoResourceInput,
    context: VideoAssetRequestContext,
  ): Promise<KinoResourceDTO> {
    const gameDir = this.#resolveGameDir(context);
    if (input.game_id !== context.gameId) {
      throw new KinoApiError('Upload session game mismatch', 400, 'upload_session_game_mismatch');
    }
    if (input.media_type !== 'video') {
      throw new KinoApiError('Invalid media type', 400, 'invalid_media_type');
    }

    const token = parseUploadTokenFromReference(input.url, context.origin);
    return this.#withTokenLock(token, async () => {
    let session = await this.#requirePendingSession(token, context, input.url);
    const recovered = await this.#recoverSessionAsset(gameDir, token, session, context);
    if (recovered) {
      return toDto(recovered, context);
    }

    session = await this.#reserveSession(session);
    const reservedId = session.resourceId!;
    const reservedExisting = await this.#deps.manifest.get(gameDir, reservedId);
    if (reservedExisting && !session.replaceExisting) {
      this.#assertUploadFingerprint(reservedExisting, session);
      await this.#deps.uploadSessions.complete(token, reservedId, context.gameId);
      await this.#cleanupUpload(this.#deps.providers.current(), session, context);
      return toDto(reservedExisting, context);
    }

    const provider = this.#deps.providers.current();
    if (provider.kind !== session.providerKind) {
      throw new KinoApiError('Upload session provider mismatch', 409, 'upload_session_provider_mismatch');
    }

    const uploaded = await provider.inspectUpload(session.providerState, context);
    const mapping = await provider.finalizeResource(
      uploaded,
      {
        resourceId: reservedId,
        name: input.name ?? session.fileName,
        durationMs: input.source_meta?.duration_ms,
      },
      context,
    );

    const now = nowOf(this.#deps)();
    const finalizedAsset: VideoAsset = {
      id: reservedId,
      kind: 'video',
      name: input.name ?? session.fileName,
      status: 'ready',
      mimeType: 'video/mp4',
      bytes: uploaded.bytes,
      durationMs: input.source_meta?.duration_ms,
      createdAt: now,
      updatedAt: now,
      provider: mapping,
      meta: {
        type: input.type ?? 'UPLOAD',
        remark: input.remark,
        source: input.source,
        sourceMeta: input.source_meta,
        uploadFingerprint: uploadFingerprint(token),
      },
    };

    try {
      await this.#verifyPrecommitPlayback(finalizedAsset, provider, context);
    } catch (error) {
      if (
        !reservedExisting ||
        !this.#sameProviderMapping(reservedExisting.provider, finalizedAsset.provider)
      ) {
        await this.#compensateFinalized(
          [{ asset: finalizedAsset }],
          provider,
          context,
          error,
        );
      }
      throw error;
    }

    let storedAsset = finalizedAsset;
    try {
      await this.#deps.manifest.mutate(gameDir, (manifest) => {
        const index = manifest.assets.findIndex((entry) => entry.id === reservedId);
        const existing = index >= 0 ? manifest.assets[index] : undefined;
        if (existing && this.#sameFinalizedAsset(existing, finalizedAsset)) {
          storedAsset = existing;
          return;
        }
        if (session.replaceExisting) {
          if (!existing) {
            throw new KinoApiError(
              'Replacement target does not exist',
              409,
              'replace_target_not_found',
            );
          }
          if (
            replacementFingerprint(existing) !==
            session.replaceExpectedFingerprint
          ) {
            throw new KinoApiError(
              'Replacement target changed after prepare',
              409,
              'replacement_conflict',
            );
          }
          storedAsset = this.#buildReplacementAsset(existing, finalizedAsset);
          manifest.assets[index] = storedAsset;
          return;
        }
        if (existing) {
          throw new KinoApiError(
            'Reserved resource id conflicts with the manifest',
            409,
            'resource_id_conflict',
          );
        }
        manifest.assets.push(finalizedAsset);
      });
    } catch (error) {
      if (
        session.replaceExisting &&
        reservedExisting &&
        !this.#sameProviderMapping(reservedExisting.provider, finalizedAsset.provider)
      ) {
        await this.#compensateFinalized(
          [{ asset: finalizedAsset }],
          provider,
          context,
          error,
        );
      }
      throw error;
    }
    await this.#deps.uploadSessions.complete(token, reservedId, context.gameId);
    await this.#cleanupUpload(provider, session, context);

    const stored = await this.#deps.manifest.get(gameDir, reservedId);
    return toDto(stored ?? storedAsset, context);
    });
  }

  async batchCreateResources(
    input: BatchCreateKinoResourcesInput,
    context: VideoAssetRequestContext,
  ): Promise<BatchCreateKinoResourcesResult> {
    const gameDir = this.#resolveGameDir(context);
    if (input.game_id !== context.gameId) {
      throw new KinoApiError('Upload session game mismatch', 400, 'upload_session_game_mismatch');
    }

    const seen = new Set<string>();
    const uniqueResources: Array<
      Omit<CreateKinoResourceInput, 'game_id'> & { media_type: 'video' }
    > = [];
    let skippedCount = 0;
    for (const resource of input.resources) {
      if (resource.media_type !== 'video') {
        throw new KinoApiError('Invalid media type', 400, 'invalid_media_type');
      }
      if (seen.has(resource.url)) {
        skippedCount += 1;
        continue;
      }
      seen.add(resource.url);
      uniqueResources.push({ ...resource, media_type: 'video' });
    }

    const tokens = uniqueResources.map((resource) =>
      parseUploadTokenFromReference(resource.url, context.origin),
    );
    return this.#withTokenLocks(tokens, async () => {
    const pending: BatchPendingResource[] = [];
    for (const resource of uniqueResources) {
      const token = parseUploadTokenFromReference(resource.url, context.origin);
      const session = await this.#requirePendingSession(token, context, resource.url);
      pending.push({ resource, token, session });
    }

    for (const item of pending) {
      const recovered = await this.#recoverSessionAsset(
        gameDir,
        item.token,
        item.session,
        context,
      );
      if (recovered) {
        item.existing = recovered;
      } else {
        item.session = await this.#reserveSession(item.session);
        const reserved = await this.#deps.manifest.get(gameDir, item.session.resourceId!);
        if (reserved) {
          if (item.session.replaceExisting) {
            item.replaceTarget = reserved;
            continue;
          }
          this.#assertUploadFingerprint(reserved, item.session);
          await this.#deps.uploadSessions.complete(item.token, reserved.id, context.gameId);
          await this.#cleanupUpload(
            this.#deps.providers.current(),
            item.session,
            context,
          );
          item.existing = reserved;
        }
      }
    }

    const provider = this.#deps.providers.current();
    const finalized: Array<{ token: string; asset: VideoAsset }> = [];
    try {
      for (const item of pending) {
        if (item.existing) {
          continue;
        }
        const uploaded = await provider.inspectUpload(
          item.session.providerState,
          context,
        );
        const asset = this.#buildReadyAsset(
          item.session.resourceId!,
          item.session,
          item.resource,
          await provider.finalizeResource(
            uploaded,
            {
              resourceId: item.session.resourceId!,
              name: item.resource.name ?? item.session.fileName,
              durationMs: item.resource.source_meta?.duration_ms,
            },
            context,
          ),
          uploaded.bytes,
        );
        finalized.push({ token: item.token, asset });
        item.finalized = asset;
        await this.#verifyPrecommitPlayback(asset, provider, context);
      }
    } catch (error) {
      await this.#compensateFinalized(
        this.#compensatableBatchAssets(finalized, pending),
        provider,
        context,
        error,
      );
      throw error;
    }

    if (finalized.length > 0) {
      try {
        await this.#deps.manifest.mutate(gameDir, (manifest) => {
          for (const { token, asset } of finalized) {
            const item = pending.find((entry) => entry.token === token)!;
            const index = manifest.assets.findIndex((entry) => entry.id === asset.id);
            const existing = index >= 0 ? manifest.assets[index] : undefined;
            if (existing && this.#sameFinalizedAsset(existing, asset)) {
              item.finalized = existing;
              continue;
            }
            if (item.session.replaceExisting) {
              if (!existing) {
                throw new KinoApiError(
                  'Replacement target does not exist',
                  409,
                  'replace_target_not_found',
                );
              }
              if (
                replacementFingerprint(existing) !==
                item.session.replaceExpectedFingerprint
              ) {
                throw new KinoApiError(
                  'Replacement target changed after prepare',
                  409,
                  'replacement_conflict',
                );
              }
              const replacement = this.#buildReplacementAsset(existing, asset);
              manifest.assets[index] = replacement;
              item.finalized = replacement;
              continue;
            }
            if (existing) {
              throw new KinoApiError(
                'Reserved resource id conflicts with the manifest',
                409,
                'resource_id_conflict',
              );
            }
            manifest.assets.push(asset);
          }
        });
      } catch (error) {
        await this.#compensateFinalized(
          this.#compensatableBatchAssets(finalized, pending),
          provider,
          context,
          error,
        );
        throw error;
      }
    }

    const items: KinoResourceDTO[] = [];
    for (const item of pending) {
      const asset = item.existing ?? item.finalized;
      if (!asset) {
        throw new KinoApiError(
          'Batch resource state is inconsistent',
          500,
          'upload_session_consistency_error',
        );
      }
      if (!item.existing) {
        await this.#deps.uploadSessions.complete(item.token, asset.id, context.gameId);
        await this.#cleanupUpload(provider, item.session, context);
      }
      items.push(toDto(asset, context));
    }

    return {
      created_count: items.length,
      skipped_count: skippedCount,
      items,
    };
    });
  }

  async listResources(
    query: ListResourcesQuery,
    context: VideoAssetRequestContext,
  ): Promise<KinoResourcePage> {
    const gameDir = this.#resolveGameDir(context);
    if (query.game_id !== context.gameId) {
      throw new KinoApiError('Upload session game mismatch', 400, 'upload_session_game_mismatch');
    }
    if (query.media_type !== 'video') {
      throw new KinoApiError('Invalid media type', 400, 'invalid_media_type');
    }

    const { page, pageSize } = parsePagination(query.page, query.page_size);
    await this.#reconcileUpstream(gameDir, context, pageSize);

    const manifest = await this.#deps.manifest.read(gameDir);
    const assets = readyAssets(manifest.assets).sort((left, right) => right.updatedAt - left.updatedAt);
    const total = assets.length;
    const start = (page - 1) * pageSize;
    const pageItems = assets.slice(start, start + pageSize).map((asset) => toDto(asset, context));

    return {
      items: pageItems,
      total,
      page,
      page_size: pageSize,
    };
  }

  async getResource(
    resourceId: string,
    context: VideoAssetRequestContext,
  ): Promise<KinoResourceDTO> {
    const gameDir = this.#resolveGameDir(context);
    await this.#reconcileUpstream(gameDir, context, DEFAULT_PAGE_SIZE);
    const asset = await this.#deps.manifest.get(gameDir, resourceId);
    if (!asset || asset.status !== 'ready') {
      throw new KinoApiError('Resource not found', 404, 'resource_not_found');
    }
    return toDto(asset, context);
  }

  async updateResource(
    resourceId: string,
    input: UpdateKinoResourceInput,
    context: VideoAssetRequestContext,
  ): Promise<KinoResourceDTO> {
    const gameDir = this.#resolveGameDir(context);
    if (input.game_id !== context.gameId) {
      throw new KinoApiError('Upload session game mismatch', 400, 'upload_session_game_mismatch');
    }
    if (input.resource_id !== resourceId) {
      throw new KinoApiError('Resource id mismatch', 400, 'resource_id_mismatch');
    }
    if (input.media_type !== 'video') {
      throw new KinoApiError('Invalid media type', 400, 'invalid_media_type');
    }

    const existing = await this.#deps.manifest.get(gameDir, resourceId);
    if (!existing || existing.status !== 'ready') {
      throw new KinoApiError('Resource not found', 404, 'resource_not_found');
    }

    const provider = this.#deps.providers.current();
    const candidate: VideoAsset = {
      ...existing,
      name: input.name ?? existing.name,
      updatedAt: nowOf(this.#deps)(),
      meta: {
        ...existing.meta,
        type: input.type ?? readAssetMeta(existing).type,
        remark: input.remark ?? readAssetMeta(existing).remark,
        source: input.source ?? readAssetMeta(existing).source,
        sourceMeta: input.source_meta ?? readAssetMeta(existing).sourceMeta,
      },
    };

    if (typeof provider.update === 'function') {
      await provider.update(candidate, context);
    }

    await this.#deps.manifest.mutate(gameDir, (manifest) => {
      const index = manifest.assets.findIndex((asset) => asset.id === resourceId);
      if (index === -1) {
        throw new KinoApiError('Resource not found', 404, 'resource_not_found');
      }
      manifest.assets[index] = candidate;
    });

    const updated = await this.#deps.manifest.get(gameDir, resourceId);
    return toDto(updated ?? candidate, context);
  }

  async deleteResource(resourceId: string, context: VideoAssetRequestContext): Promise<void> {
    const gameDir = this.#resolveGameDir(context);
    const asset = await this.#deps.manifest.get(gameDir, resourceId);
    if (!asset || asset.status !== 'ready') {
      throw new KinoApiError('Resource not found', 404, 'resource_not_found');
    }

    await this.#deps.providers.current().delete(asset, context);
    await this.#deps.manifest.mutate(gameDir, (manifest) => {
      manifest.assets = manifest.assets.filter((entry) => entry.id !== resourceId);
    });
  }

  async playResource(
    resourceId: string,
    context: VideoAssetRequestContext,
  ): Promise<PlaybackSource> {
    const gameDir = this.#resolveGameDir(context);
    const asset = await this.#deps.manifest.get(gameDir, resourceId);
    if (!asset || asset.status !== 'ready') {
      throw new KinoApiError('Resource not found', 404, 'resource_not_found');
    }
    const source = await this.#deps.providers.current().getPlayback(asset, context);
    if (
      source.kind === 'local' &&
      (!Number.isSafeInteger(source.bytes) || source.bytes <= 0)
    ) {
      throw new KinoApiError(
        'Invalid video asset size',
        500,
        'invalid_video_asset_size',
      );
    }
    return source;
  }

  async #withTokenLock<T>(token: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#tokenLocks.get(token) ?? Promise.resolve();
    let release!: () => void;
    const hold = new Promise<void>((resolveHold) => {
      release = resolveHold;
    });
    const current = previous.then(() => hold);
    this.#tokenLocks.set(token, current);

    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.#tokenLocks.get(token) === current) {
        this.#tokenLocks.delete(token);
      }
    }
  }

  async #withTokenLocks<T>(
    tokens: string[],
    task: () => Promise<T>,
  ): Promise<T> {
    const ordered = [...new Set(tokens)].sort();
    const acquire = (index: number): Promise<T> => {
      const token = ordered[index];
      if (!token) {
        return task();
      }
      return this.#withTokenLock(token, () => acquire(index + 1));
    };
    return acquire(0);
  }

  async #requirePendingSession(
    token: string,
    context: VideoAssetRequestContext,
    reference?: string,
  ): Promise<UploadSession> {
    const session = await this.#deps.uploadSessions.read(token, context.gameId);
    if (!session) {
      throw new KinoApiError(
        reference ? 'Invalid upload reference' : 'Upload session not found',
        reference ? 400 : 404,
        reference ? 'invalid_upload_reference' : 'upload_session_not_found',
      );
    }

    try {
      this.#deps.uploadSessions.validate(session, {
        gameId: context.gameId,
        identity: context.identity,
        providerKind: this.#deps.providers.current().kind,
        mimeType: VIDEO_UPLOAD_MIME,
        bytes: session.bytes,
      }, nowOf(this.#deps)());
    } catch (error) {
      if (reference && error instanceof KinoApiError) {
        throw new KinoApiError('Invalid upload reference', 400, 'invalid_upload_reference');
      }
      throw error;
    }

    return session;
  }

  async #reserveSession(session: UploadSession): Promise<UploadSession> {
    if (session.resourceId) {
      return session;
    }
    return this.#deps.uploadSessions.reserve(
      session.token,
      idOf(this.#deps)(),
      session.gameId,
    );
  }

  async #recoverSessionAsset(
    gameDir: string,
    token: string,
    session: UploadSession,
    context: VideoAssetRequestContext,
  ): Promise<VideoAsset | null> {
    if (session.completedResourceId) {
      const completed = await this.#deps.manifest.get(
        gameDir,
        session.completedResourceId,
      );
      if (!completed) {
        throw new KinoApiError(
          'Completed upload session has no manifest resource',
          500,
          'upload_session_consistency_error',
        );
      }
      this.#assertUploadFingerprint(completed, session);
      if (Object.keys(session.providerState).length > 0) {
        await this.#cleanupUpload(
          this.#deps.providers.current(),
          session,
          context,
        );
      }
      return completed;
    }

    if (!session.resourceId) {
      return null;
    }
    const reserved = await this.#deps.manifest.get(gameDir, session.resourceId);
    if (!reserved) {
      return null;
    }
    if (
      session.replaceExisting &&
      reserved.meta?.uploadFingerprint !== uploadFingerprint(session.token)
    ) {
      return null;
    }
    this.#assertUploadFingerprint(reserved, session);
    await this.#deps.uploadSessions.complete(token, reserved.id, context.gameId);
    await this.#cleanupUpload(
      this.#deps.providers.current(),
      session,
      context,
    );
    return reserved;
  }

  #assertUploadFingerprint(asset: VideoAsset, session: UploadSession): void {
    if (asset.meta?.uploadFingerprint !== uploadFingerprint(session.token)) {
      throw new KinoApiError(
        'Reserved resource id conflicts with the manifest',
        409,
        'resource_id_conflict',
      );
    }
  }

  async #cleanupUpload(
    provider: ReturnType<VideoAssetProviderRegistry['current']>,
    session: UploadSession,
    context: VideoAssetRequestContext,
  ): Promise<void> {
    if (typeof provider.cleanupUpload !== 'function') {
      return;
    }
    try {
      await provider.cleanupUpload(session.providerState, context);
    } catch (cause) {
      const error = new KinoApiError(
        'Resource is ready but upload cleanup failed',
        500,
        'upload_cleanup_failed',
      ) as KinoApiError & { cause?: unknown };
      error.cause = cause;
      throw error;
    }
  }

  #buildReadyAsset(
    resourceId: string,
    session: UploadSession,
    input: Omit<CreateKinoResourceInput, 'game_id'>,
    provider: VideoAsset['provider'],
    bytes: number,
  ): VideoAsset {
    const now = nowOf(this.#deps)();
    return {
      id: resourceId,
      kind: 'video',
      name: input.name ?? session.fileName,
      status: 'ready',
      mimeType: 'video/mp4',
      bytes,
      durationMs: input.source_meta?.duration_ms,
      createdAt: now,
      updatedAt: now,
      provider,
      meta: {
        type: input.type ?? 'UPLOAD',
        remark: input.remark,
        source: input.source,
        sourceMeta: input.source_meta,
        uploadFingerprint: uploadFingerprint(session.token),
      },
    };
  }

  #sameFinalizedAsset(left: VideoAsset, right: VideoAsset): boolean {
    return (
      left.id === right.id &&
      left.status === 'ready' &&
      left.bytes === right.bytes &&
      left.mimeType === right.mimeType &&
      left.provider.kind === right.provider.kind &&
      left.provider.ref === right.provider.ref &&
      left.provider.upstreamResourceId === right.provider.upstreamResourceId &&
      left.meta?.uploadFingerprint === right.meta?.uploadFingerprint
    );
  }

  #sameProviderMapping(
    left: VideoAsset['provider'],
    right: VideoAsset['provider'],
  ): boolean {
    return (
      left.kind === right.kind &&
      left.ref === right.ref &&
      left.upstreamResourceId === right.upstreamResourceId
    );
  }

  #compensatableBatchAssets(
    finalized: Array<{ token: string; asset: VideoAsset }>,
    pending: BatchPendingResource[],
  ): Array<{ asset: VideoAsset }> {
    return finalized
      .filter(({ token, asset }) => {
        const target = pending.find((item) => item.token === token)?.replaceTarget;
        return (
          !target ||
          !this.#sameProviderMapping(target.provider, asset.provider)
        );
      })
      .map(({ asset }) => ({ asset }));
  }

  async #verifyPrecommitPlayback(
    asset: VideoAsset,
    provider: ReturnType<VideoAssetProviderRegistry['current']>,
    context: VideoAssetRequestContext,
  ): Promise<void> {
    const playback = await provider.getPlayback(asset, context);
    if (playback.kind === 'local') {
      try {
        accessSync(playback.filePath, constants.R_OK);
        const stat = statSync(playback.filePath);
        if (
          !stat.isFile() ||
          stat.size !== asset.bytes ||
          playback.bytes !== asset.bytes ||
          playback.mimeType !== asset.mimeType
        ) {
          throw new Error('Local playback metadata mismatch');
        }
      } catch (cause) {
        const error = new KinoApiError(
          'Local playback verification failed',
          502,
          'provider_playback_failed',
        ) as KinoApiError & { cause?: unknown };
        error.cause = cause;
        throw error;
      }
      return;
    }

    let url: URL;
    try {
      url = new URL(playback.url);
    } catch {
      throw new KinoApiError(
        'Invalid playback URL',
        502,
        'provider_playback_failed',
      );
    }
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      throw new KinoApiError(
        'Invalid playback URL',
        502,
        'provider_playback_failed',
      );
    }
  }

  #buildReplacementAsset(existing: VideoAsset, finalized: VideoAsset): VideoAsset {
    const finalizedMeta = Object.fromEntries(
      Object.entries(finalized.meta ?? {}).filter(([, value]) => value !== undefined),
    );
    return {
      ...existing,
      name: finalized.name,
      status: 'ready',
      mimeType: finalized.mimeType,
      bytes: finalized.bytes,
      durationMs: finalized.durationMs,
      updatedAt: finalized.updatedAt,
      provider: finalized.provider,
      meta: {
        ...existing.meta,
        ...finalizedMeta,
      },
    };
  }

  async #compensateFinalized(
    finalized: Array<{ asset: VideoAsset }>,
    provider: ReturnType<VideoAssetProviderRegistry['current']>,
    context: VideoAssetRequestContext,
    primaryError: unknown,
  ): Promise<void> {
    const cleanupErrors: unknown[] = [];
    for (const { asset } of [...finalized].reverse()) {
      try {
        await provider.delete(asset, context);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      const error = new KinoApiError(
        'Batch finalize failed and compensation was incomplete',
        500,
        'batch_compensation_failed',
      ) as KinoApiError & { cause?: unknown };
      error.cause = new AggregateError(
        [primaryError, ...cleanupErrors],
        'Batch finalize and compensation failures',
      );
      throw error;
    }
  }

  async #reconcileUpstream(
    gameDir: string,
    context: VideoAssetRequestContext,
    pageSize: number,
  ): Promise<void> {
    const provider = this.#deps.providers.current();
    if (typeof provider.listUpstream !== 'function') {
      return;
    }

    const ttl = this.#deps.reconcileTtlMs ?? DEFAULT_RECONCILE_TTL_MS;
    const cacheKey = `${gameDir}:${provider.kind}`;
    const now = nowOf(this.#deps)();
    const last = this.#reconcileAt.get(cacheKey);
    if (last !== undefined && now - last < ttl) {
      return;
    }

    let currentPage = 1;
    let total = Number.POSITIVE_INFINITY;
    const upstreamById = new Map<string, UpstreamVideoResource>();

    while ((currentPage - 1) * pageSize < total) {
      const upstreamPage = await provider.listUpstream(currentPage, pageSize, context);
      total = upstreamPage.total;
      for (const item of upstreamPage.items) {
        upstreamById.set(item.upstreamResourceId, item);
      }
      if (upstreamPage.items.length === 0) {
        break;
      }
      currentPage += 1;
    }

    if (upstreamById.size === 0) {
      this.#reconcileAt.set(cacheKey, now);
      return;
    }

    await this.#deps.manifest.mutate(gameDir, (manifest) => {
      for (const upstream of upstreamById.values()) {
        const existing = manifest.assets.find(
          (asset) => asset.provider.upstreamResourceId === upstream.upstreamResourceId,
        );

        if (existing) {
          existing.name = upstream.name;
          existing.bytes = upstream.bytes ?? existing.bytes;
          existing.durationMs = upstream.durationMs ?? existing.durationMs;
          existing.updatedAt = upstream.updatedAt;
          existing.status = 'ready';
          continue;
        }

        manifest.assets.push({
          id: upstream.upstreamResourceId,
          kind: 'video',
          name: upstream.name,
          status: 'ready',
          mimeType: 'video/mp4',
          bytes: upstream.bytes ?? 0,
          durationMs: upstream.durationMs,
          createdAt: upstream.createdAt,
          updatedAt: upstream.updatedAt,
          provider: {
            kind: provider.kind,
            ref: upstream.url,
            upstreamResourceId: upstream.upstreamResourceId,
          },
          meta: {
            type: 'UPLOAD',
            sourceMeta: upstream.mimeType ? { mime_type: upstream.mimeType } : undefined,
          },
        });
      }
    });

    this.#reconcileAt.set(cacheKey, now);
  }
}
