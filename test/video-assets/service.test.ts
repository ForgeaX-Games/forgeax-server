import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type {
  PlaybackSource,
  ProviderMapping,
  UploadedObject,
  VideoAsset,
  VideoAssetProvider,
  VideoAssetRequestContext,
} from '../../src/video-assets/contracts';
import { KinoApiError } from '../../src/video-assets/kino-api';
import { VideoAssetManifestRepository } from '../../src/video-assets/manifest-repository';
import { VideoAssetProviderRegistry } from '../../src/video-assets/provider-registry';
import { VideoAssetService, type UploadSessionRepository } from '../../src/video-assets/service';
import {
  MAX_VIDEO_UPLOAD_BYTES,
  UploadSessionStore,
  VIDEO_UPLOAD_MIME,
} from '../../src/video-assets/upload-sessions';

const FIXTURE = new Uint8Array([0x10, 0x11, 0x12, 0x13]);

let projectRoot: string;
let gameId: string;
let gameDir: string;
let assetsDir: string;
let manifest: VideoAssetManifestRepository;
let sessionStore: UploadSessionStore;
let uploadSessions: UploadSessionRepository;
let fakeProvider: FakeProvider;
let registry: VideoAssetProviderRegistry;
let service: VideoAssetService;
let nowMs: number;
let ids: string[];
let request: VideoAssetRequestContext;

function bindUploadSessionStore(store: UploadSessionStore): UploadSessionRepository {
  return {
    write: (session) => store.write(session),
    read: (token, _gameId) => store.read(token),
    validate: (session, input, now) => store.validate(session, input, now),
    reserve: (token, resourceId, _gameId) => store.reserve(token, resourceId),
    complete: (token, resourceId, _gameId) => store.complete(token, resourceId),
  };
}

class FakeProvider implements VideoAssetProvider {
  readonly kind = 'local' as const;
  prepareCalls = 0;
  prepareShouldFail = false;
  inspectResult: UploadedObject | null = null;
  finalizeMapping: ProviderMapping = { kind: 'local', ref: 'blobs/fake.mp4' };
  finalizeMappings: ProviderMapping[] = [];
  finalizeShouldFail = false;
  finalizeFailAt?: number;
  finalizeCalls: string[] = [];
  updateCalls = 0;
  updateShouldFail = false;
  deleteCalls = 0;
  deleteShouldFail = false;
  deletedAssetIds: string[] = [];
  deletedProviderRefs: string[] = [];
  cleanupCalls: string[] = [];
  cleanupShouldFail = false;
  receiveCalls = 0;
  receiveShouldFail = false;
  receiveStarted?: () => void;
  receiveGate?: Promise<void>;
  inspectCalls = 0;
  inspectStarted?: () => void;
  getPlaybackCalls = 0;
  getPlaybackFailAt?: number;
  upstreamCalls: number[] = [];
  upstreamPages: Array<{
    items: Array<{
      upstreamResourceId: string;
      name: string;
      url: string;
      bytes?: number;
      createdAt: number;
      updatedAt: number;
    }>;
    total: number;
  }> = [];

  prepareUpload = async (
    input: { uploadToken: string; fileName: string; mimeType: 'video/mp4'; bytes: number },
    _context: VideoAssetRequestContext,
  ) => {
    this.prepareCalls += 1;
    if (this.prepareShouldFail) {
      throw new KinoApiError('prepare failed', 500, 'provider_prepare_failed');
    }
    return {
      instruction: {
        method: 'PUT' as const,
        url: `${request.origin}/api/v1/kino/uploads/${input.uploadToken}?game_id=${encodeURIComponent(request.gameId)}`,
        headers: { 'content-type': 'video/mp4' },
        expiresAt: new Date(nowMs + 10 * 60 * 1000).toISOString(),
      },
      state: {
        ref: `.uploads/${input.uploadToken}.part`,
        bytes: input.bytes,
        mimeType: 'video/mp4',
      },
    };
  };

  receiveUpload = async () => {
    this.receiveCalls += 1;
    this.receiveStarted?.();
    if (this.receiveShouldFail) {
      throw new KinoApiError('receive failed', 500, 'provider_receive_failed');
    }
    await this.receiveGate;
  };

  inspectUpload = async () => {
    this.inspectCalls += 1;
    this.inspectStarted?.();
    if (!this.inspectResult) {
      throw new KinoApiError('missing upload', 400, 'invalid_upload_session');
    }
    return this.inspectResult;
  };

  finalizeResource = async (
    _object: UploadedObject,
    input: { resourceId: string; name: string },
  ) => {
    this.finalizeCalls.push(input.resourceId);
    if (
      this.finalizeShouldFail ||
      this.finalizeCalls.length === this.finalizeFailAt
    ) {
      throw new KinoApiError('finalize failed', 500, 'provider_finalize_failed');
    }
    return this.finalizeMappings.shift() ?? {
      ...this.finalizeMapping,
      ref: `blobs/${input.resourceId}.mp4`,
    };
  };

  getPlayback: VideoAssetProvider['getPlayback'] = async (_asset): Promise<PlaybackSource> => {
    this.getPlaybackCalls += 1;
    if (this.getPlaybackCalls === this.getPlaybackFailAt) {
      throw new KinoApiError(
        'playback verification failed',
        502,
        'provider_playback_failed',
      );
    }
    return {
      kind: 'redirect' as const,
      url: 'https://playback.example.test/video.mp4',
    };
  };

  update = async () => {
    this.updateCalls += 1;
    if (this.updateShouldFail) {
      throw new KinoApiError('update failed', 500, 'provider_update_failed');
    }
  };

  delete = async (asset: VideoAsset) => {
    this.deleteCalls += 1;
    this.deletedAssetIds.push(asset.id);
    this.deletedProviderRefs.push(asset.provider.ref);
    if (this.deleteShouldFail) {
      throw new KinoApiError('delete failed', 500, 'provider_delete_failed');
    }
  };

  cleanupUpload = async (state: Record<string, unknown>) => {
    this.cleanupCalls.push(String(state.ref));
    if (this.cleanupShouldFail) {
      throw new KinoApiError('cleanup failed', 500, 'provider_cleanup_failed');
    }
  };

  listUpstream = async (page: number, pageSize: number) => {
    this.upstreamCalls.push(page);
    const slice = this.upstreamPages[page - 1] ?? { items: [], total: 0 };
    return {
      items: slice.items,
      page,
      pageSize,
      total: slice.total,
    };
  };
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function makeGame(slug = 'demo'): void {
  gameId = slug;
  gameDir = resolve(projectRoot, '.forgeax/games', slug);
  assetsDir = resolve(gameDir, 'game-video', 'assets');
  mkdirSync(assetsDir, { recursive: true });
}

function streamFrom(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
}

async function expectKinoError(
  action: Promise<unknown>,
  status: number,
  errorCode?: string,
): Promise<void> {
  try {
    await action;
    throw new Error('expected KinoApiError');
  } catch (error) {
    expect(error).toBeInstanceOf(KinoApiError);
    expect((error as KinoApiError).status).toBe(status);
    if (errorCode) {
      expect((error as KinoApiError).errorCode).toBe(errorCode);
    }
  }
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'video-asset-service-'));
  makeGame();
  manifest = new VideoAssetManifestRepository();
  sessionStore = new UploadSessionStore(assetsDir);
  uploadSessions = bindUploadSessionStore(sessionStore);
  fakeProvider = new FakeProvider();
  registry = new VideoAssetProviderRegistry(fakeProvider);
  nowMs = Date.now();
  ids = ['id-1', 'id-2', 'id-3', 'id-4', 'id-5'];
  request = {
    gameId,
    identity: 'user-1',
    origin: 'http://127.0.0.1:18900',
  };
  fakeProvider.inspectResult = {
    ref: '.uploads/token.part',
    bytes: FIXTURE.byteLength,
    mimeType: 'video/mp4',
  };
  service = new VideoAssetService({
    getProjectRoot: () => projectRoot,
    providers: registry,
    manifest,
    uploadSessions,
    now: () => nowMs,
    id: () => ids.shift() ?? 'fallback-id',
    reconcileTtlMs: 5_000,
  });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('VideoAssetService validation', () => {
  test('rejects invalid prepare inputs', async () => {
    await expectKinoError(
      service.prepareUpload(
        { fileName: 'clip.webm', mimeType: 'video/mp4', bytes: 10 },
        request,
      ),
      400,
      'invalid_file_name',
    );
    await expectKinoError(
      service.prepareUpload(
        { fileName: 'clip.mp4', mimeType: 'video/webm' as 'video/mp4', bytes: 10 },
        request,
      ),
      400,
      'invalid_media_type',
    );
    await expectKinoError(
      service.prepareUpload({ fileName: 'clip.mp4', mimeType: 'video/mp4', bytes: 0 }, request),
      400,
      'invalid_upload_size',
    );
    await expectKinoError(
      service.prepareUpload(
        { fileName: 'clip.mp4', mimeType: 'video/mp4', bytes: 1.5 },
        request,
      ),
      400,
      'invalid_upload_size',
    );
    await expectKinoError(
      service.prepareUpload(
        { fileName: 'clip.mp4', mimeType: 'video/mp4', bytes: MAX_VIDEO_UPLOAD_BYTES + 1 },
        request,
      ),
      400,
      'invalid_upload_size',
    );
  });

  test('validates list pagination defaults and limits', async () => {
    await expect(
      service.listResources({ game_id: gameId, media_type: 'video' }, request),
    ).resolves.toEqual({
      items: [],
      total: 0,
      page: 1,
      page_size: 20,
    });

    await expectKinoError(
      service.listResources({ game_id: gameId, media_type: 'video', page: 0 }, request),
      400,
      'invalid_page',
    );
    await expectKinoError(
      service.listResources(
        { game_id: gameId, media_type: 'video', page_size: 101 },
        request,
      ),
      400,
      'invalid_page_size',
    );
  });
});

describe('VideoAssetService.playResource', () => {
  test('rejects a zero-byte Local playback source as provider corruption', async () => {
    await manifest.mutate(gameDir, (current) => {
      current.assets.push({
        id: 'zero-source',
        kind: 'video',
        name: 'zero-source.mp4',
        status: 'ready',
        mimeType: 'video/mp4',
        bytes: FIXTURE.byteLength,
        createdAt: nowMs,
        updatedAt: nowMs,
        provider: { kind: 'local', ref: 'blobs/zero-source.mp4' },
      });
    });
    fakeProvider.getPlayback = async () => ({
      kind: 'local',
      filePath: resolve(assetsDir, 'blobs/zero-source.mp4'),
      mimeType: 'video/mp4',
      bytes: 0,
    });

    await expectKinoError(
      service.playResource('zero-source', request),
      500,
      'invalid_video_asset_size',
    );
  });
});

describe('VideoAssetService.prepareUpload', () => {
  test('persists a session after provider prepare succeeds', async () => {
    const response = await service.prepareUpload(
      { fileName: 'clip.mp4', mimeType: 'video/mp4', bytes: FIXTURE.byteLength },
      request,
    );

    expect(response.upload.method).toBe('PUT');
    expect(response.object_url).toContain('/api/v1/kino/uploads/');
    expect(response.upload_token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    const session = await sessionStore.read(response.upload_token);
    expect(session?.gameId).toBe(gameId);
    expect(session?.identity).toBe('user-1');
    expect(session?.providerKind).toBe('local');
  });

  test('does not persist a session when provider prepare fails', async () => {
    fakeProvider.prepareShouldFail = true;
    await expectKinoError(
      service.prepareUpload(
        { fileName: 'clip.mp4', mimeType: 'video/mp4', bytes: FIXTURE.byteLength },
        request,
      ),
      500,
      'provider_prepare_failed',
    );
    const uploadsDir = resolve(assetsDir, '.uploads');
    expect(existsSync(uploadsDir) ? readdirSync(uploadsDir) : []).toEqual([]);
  });

  test('reserves migration client_resource_id on prepareUpload', async () => {
    const response = await service.prepareUpload(
      {
        fileName: 'clip.mp4',
        mimeType: 'video/mp4',
        bytes: FIXTURE.byteLength,
        clientResourceId: 'm-narr-open',
      },
      request,
    );
    const session = await sessionStore.read(response.upload_token);
    expect(session?.resourceId).toBe('m-narr-open');
  });

  test('rejects conflicting client_resource_id when manifest already contains it', async () => {
    await manifest.mutate(gameDir, (current) => {
      current.assets.push({
        id: 'm-narr-open',
        kind: 'video',
        name: 'narr-open',
        status: 'ready',
        mimeType: 'video/mp4',
        bytes: FIXTURE.byteLength,
        createdAt: 1,
        updatedAt: 1,
        provider: { kind: 'local', ref: 'blobs/narr-open.mp4' },
      });
    });

    await expectKinoError(
      service.prepareUpload(
        {
          fileName: 'clip.mp4',
          mimeType: 'video/mp4',
          bytes: FIXTURE.byteLength,
          clientResourceId: 'm-narr-open',
        },
        request,
      ),
      409,
      'resource_id_conflict',
    );
  });

  test('allows replace_existing only for an existing client_resource_id', async () => {
    await manifest.mutate(gameDir, (current) => {
      current.assets.push({
        id: 'm-narr-open',
        kind: 'video',
        name: 'old',
        status: 'ready',
        mimeType: 'video/mp4',
        bytes: 99,
        createdAt: 1,
        updatedAt: 2,
        provider: { kind: 'local', ref: 'blobs/old.mp4' },
        meta: { scenarioId: 'nodia-main' },
      });
    });

    const prepared = await service.prepareUpload(
      {
        fileName: 'narr-open.mp4',
        mimeType: 'video/mp4',
        bytes: FIXTURE.byteLength,
        clientResourceId: 'm-narr-open',
        replaceExisting: true,
      },
      request,
    );
    const session = await sessionStore.read(prepared.upload_token);
    expect(session?.resourceId).toBe('m-narr-open');
    expect(session?.replaceExisting).toBe(true);

    await expectKinoError(
      service.prepareUpload(
        {
          fileName: 'new.mp4',
          mimeType: 'video/mp4',
          bytes: FIXTURE.byteLength,
          clientResourceId: 'missing-id',
          replaceExisting: true,
        },
        request,
      ),
      400,
      'replace_target_not_found',
    );
  });

  test('rejects replace_existing without client_resource_id', async () => {
    await expectKinoError(
      service.prepareUpload(
        {
          fileName: 'clip.mp4',
          mimeType: 'video/mp4',
          bytes: FIXTURE.byteLength,
          replaceExisting: true,
        },
        request,
      ),
      400,
      'invalid_replace_existing',
    );
  });
});

describe('VideoAssetService upload expiry', () => {
  test('uses the injected service clock when validating a session', async () => {
    const prepared = await service.prepareUpload(
      { fileName: 'clip.mp4', mimeType: 'video/mp4', bytes: FIXTURE.byteLength },
      request,
    );
    const session = await sessionStore.read(prepared.upload_token);
    nowMs = session!.expiresAt;

    await expectKinoError(
      service.receiveUpload(prepared.upload_token, streamFrom(FIXTURE), request),
      410,
      'kino_upload_expired',
    );
  });
});

describe('VideoAssetService upload token serialization', () => {
  test('does not inspect/create while receive for the same token is in progress', async () => {
    const prepared = await service.prepareUpload(
      { fileName: 'clip.mp4', mimeType: 'video/mp4', bytes: FIXTURE.byteLength },
      request,
    );
    const gate = deferred();
    const started = deferred();
    const inspectStarted = deferred();
    fakeProvider.receiveGate = gate.promise;
    fakeProvider.receiveStarted = started.resolve;
    fakeProvider.inspectStarted = inspectStarted.resolve;

    const receiving = service.receiveUpload(
      prepared.upload_token,
      streamFrom(FIXTURE),
      request,
    );
    await started.promise;
    const creating = service.createResource(
      {
        game_id: gameId,
        media_type: 'video',
        url: prepared.object_url,
        name: 'clip.mp4',
      },
      request,
    );
    const inspectState = await Promise.race([
      inspectStarted.promise.then(() => 'inspecting' as const),
      new Promise<'blocked'>((resolveBlocked) =>
        setTimeout(() => resolveBlocked('blocked'), 20),
      ),
    ]);
    gate.resolve();
    await receiving;
    await creating;
    expect(inspectState).toBe('blocked');
    expect(fakeProvider.inspectCalls).toBe(1);
  });

  test('releases the token lock after an operation fails', async () => {
    const prepared = await service.prepareUpload(
      { fileName: 'clip.mp4', mimeType: 'video/mp4', bytes: FIXTURE.byteLength },
      request,
    );
    fakeProvider.receiveShouldFail = true;
    await expectKinoError(
      service.receiveUpload(prepared.upload_token, streamFrom(FIXTURE), request),
      500,
      'provider_receive_failed',
    );

    fakeProvider.receiveShouldFail = false;
    await expect(
      service.receiveUpload(prepared.upload_token, streamFrom(FIXTURE), request),
    ).resolves.toBeUndefined();
    expect(fakeProvider.receiveCalls).toBe(2);
  });

  test('rejects receive after the upload session is completed', async () => {
    const prepared = await service.prepareUpload(
      { fileName: 'clip.mp4', mimeType: 'video/mp4', bytes: FIXTURE.byteLength },
      request,
    );
    await service.createResource(
      {
        game_id: gameId,
        media_type: 'video',
        url: prepared.object_url,
        name: 'clip.mp4',
      },
      request,
    );

    await expectKinoError(
      service.receiveUpload(prepared.upload_token, streamFrom(FIXTURE), request),
      409,
      'upload_session_completed',
    );
    expect(fakeProvider.receiveCalls).toBe(0);
  });
});

describe('VideoAssetService.createResource', () => {
  test('resolves object_url, finalizes upload, and writes a ready manifest entry', async () => {
    const prepared = await service.prepareUpload(
      { fileName: 'clip.mp4', mimeType: 'video/mp4', bytes: FIXTURE.byteLength },
      request,
    );
    const session = await sessionStore.read(prepared.upload_token);
    fakeProvider.inspectResult = {
      ref: `.uploads/${prepared.upload_token}.part`,
      bytes: FIXTURE.byteLength,
      mimeType: 'video/mp4',
    };

    const created = await service.createResource(
      {
        game_id: gameId,
        media_type: 'video',
        url: prepared.object_url,
        name: 'clip.mp4',
        type: 'UPLOAD',
        source_meta: { mime_type: 'video/mp4', duration_ms: 1200 },
      },
      request,
    );

    expect(created.resource_id).toBe('id-1');
    expect(created.media_type).toBe('video');
    expect(created.type).toBe('UPLOAD');
    expect(created.url).toBe(
      `${request.origin}/api/v1/kino/resources/${encodeURIComponent('id-1')}/content?game_id=${encodeURIComponent(gameId)}`,
    );
    expect(created.source_meta).toEqual({ mime_type: 'video/mp4', duration_ms: 1200 });

    const stored = await manifest.get(gameDir, 'id-1');
    expect(stored?.status).toBe('ready');
    expect(stored?.provider.ref).toBe('blobs/id-1.mp4');
    expect(stored?.meta?.uploadFingerprint).toBe(
      createHash('sha256').update(prepared.upload_token, 'utf8').digest('hex'),
    );
    expect((await sessionStore.read(prepared.upload_token))?.completedResourceId).toBe('id-1');
    expect(fakeProvider.cleanupCalls).toEqual([
      `.uploads/${prepared.upload_token}.part`,
    ]);
  });

  test('returns the same resource when retried by upload token', async () => {
    const prepared = await service.prepareUpload(
      { fileName: 'clip.mp4', mimeType: 'video/mp4', bytes: FIXTURE.byteLength },
      request,
    );
    fakeProvider.inspectResult = {
      ref: `.uploads/${prepared.upload_token}.part`,
      bytes: FIXTURE.byteLength,
      mimeType: 'video/mp4',
    };

    const first = await service.createResource(
      {
        game_id: gameId,
        media_type: 'video',
        url: prepared.object_url,
        name: 'clip.mp4',
      },
      request,
    );
    const second = await service.createResource(
      {
        game_id: gameId,
        media_type: 'video',
        url: prepared.object_url,
        name: 'clip.mp4',
      },
      request,
    );

    expect(second.resource_id).toBe(first.resource_id);
    expect((await manifest.read(gameDir)).assets).toHaveLength(1);
    expect(fakeProvider.cleanupCalls).toEqual([
      `.uploads/${prepared.upload_token}.part`,
    ]);
  });

  test('does not write ready assets when finalize fails', async () => {
    const prepared = await service.prepareUpload(
      { fileName: 'clip.mp4', mimeType: 'video/mp4', bytes: FIXTURE.byteLength },
      request,
    );
    fakeProvider.inspectResult = {
      ref: `.uploads/${prepared.upload_token}.part`,
      bytes: FIXTURE.byteLength,
      mimeType: 'video/mp4',
    };
    fakeProvider.finalizeShouldFail = true;

    await expectKinoError(
      service.createResource(
        {
          game_id: gameId,
          media_type: 'video',
          url: prepared.object_url,
          name: 'clip.mp4',
        },
        request,
      ),
      500,
      'provider_finalize_failed',
    );
    expect((await manifest.read(gameDir)).assets).toEqual([]);
  });

  test('recovers the reserved id after manifest write succeeds but completion persistence fails', async () => {
    const failingSessions = bindUploadSessionStore(new UploadSessionStore(assetsDir, {
      writePrivateText: (path, contents) => {
        if (contents.includes('"completedResourceId"')) {
          throw Object.assign(new Error('completion write failed'), { code: 'EIO' });
        }
        writeFileSync(path, contents, { encoding: 'utf-8', mode: 0o600 });
      },
    }));
    const firstService = new VideoAssetService({
      getProjectRoot: () => projectRoot,
      providers: registry,
      manifest,
      uploadSessions: failingSessions,
      now: () => nowMs,
      id: () => ids.shift() ?? 'fallback-id',
    });
    const prepared = await firstService.prepareUpload(
      { fileName: 'clip.mp4', mimeType: 'video/mp4', bytes: FIXTURE.byteLength },
      request,
    );

    await expectKinoError(
      firstService.createResource(
        {
          game_id: gameId,
          media_type: 'video',
          url: prepared.object_url,
          name: 'clip.mp4',
        },
        request,
      ),
      500,
      'upload_session_storage_error',
    );

    expect((await failingSessions.read(prepared.upload_token, gameId))?.resourceId).toBe('id-1');
    expect(await manifest.get(gameDir, 'id-1')).not.toBeNull();
    expect(fakeProvider.finalizeCalls).toEqual(['id-1']);

    const restartedService = new VideoAssetService({
      getProjectRoot: () => projectRoot,
      providers: registry,
      manifest: new VideoAssetManifestRepository(),
      uploadSessions: bindUploadSessionStore(new UploadSessionStore(assetsDir)),
      now: () => nowMs,
      id: () => 'must-not-be-used',
    });
    const retried = await restartedService.createResource(
      {
        game_id: gameId,
        media_type: 'video',
        url: prepared.object_url,
        name: 'clip.mp4',
      },
      request,
    );

    expect(retried.resource_id).toBe('id-1');
    expect(fakeProvider.finalizeCalls).toEqual(['id-1']);
    expect((await manifest.read(gameDir)).assets).toHaveLength(1);
    expect(
      (await new UploadSessionStore(assetsDir).read(prepared.upload_token))
        ?.completedResourceId,
    ).toBe('id-1');
  });

  test('reports a consistency error when completion points to a missing manifest asset', async () => {
    const prepared = await service.prepareUpload(
      { fileName: 'clip.mp4', mimeType: 'video/mp4', bytes: FIXTURE.byteLength },
      request,
    );
    await sessionStore.complete(prepared.upload_token, 'missing-resource');

    await expectKinoError(
      service.createResource(
        {
          game_id: gameId,
          media_type: 'video',
          url: prepared.object_url,
          name: 'clip.mp4',
        },
        request,
      ),
      500,
      'upload_session_consistency_error',
    );
    expect(fakeProvider.finalizeCalls).toEqual([]);
  });

  test('retries the same local finalization after manifest rename fails', async () => {
    const { createLocalVideoAssetProvider } = await import(
      '../../src/video-assets/providers/local'
    );
    const localProvider = createLocalVideoAssetProvider(() => projectRoot);
    registry.control.setProvider(localProvider);
    let failRename = true;
    const failingManifest = new VideoAssetManifestRepository({
      rename: (source, destination) => {
        if (failRename) {
          failRename = false;
          throw Object.assign(new Error('manifest rename failed'), { code: 'EIO' });
        }
        renameSync(source, destination);
      },
    });
    const firstService = new VideoAssetService({
      getProjectRoot: () => projectRoot,
      providers: registry,
      manifest: failingManifest,
      uploadSessions,
      now: () => nowMs,
      id: () => ids.shift() ?? 'fallback-id',
    });
    const prepared = await firstService.prepareUpload(
      { fileName: 'clip.mp4', mimeType: 'video/mp4', bytes: FIXTURE.byteLength },
      request,
    );
    await firstService.receiveUpload(prepared.upload_token, streamFrom(FIXTURE), request);

    await expectKinoError(
      firstService.createResource(
        {
          game_id: gameId,
          media_type: 'video',
          url: prepared.object_url,
          name: 'clip.mp4',
        },
        request,
      ),
      500,
      'manifest_storage_error',
    );

    const sessionAfterFailure = await sessionStore.read(prepared.upload_token);
    expect(sessionAfterFailure?.resourceId).toBe('id-1');
    expect(
      existsSync(resolve(assetsDir, '.uploads', `${prepared.upload_token}.part`)),
    ).toBe(true);
    expect(existsSync(resolve(assetsDir, 'blobs', 'id-1.mp4'))).toBe(true);
    await expect(
      localProvider.inspectUpload(sessionAfterFailure!.providerState, request),
    ).resolves.toMatchObject({ bytes: FIXTURE.byteLength });

    const restartedService = new VideoAssetService({
      getProjectRoot: () => projectRoot,
      providers: registry,
      manifest: new VideoAssetManifestRepository(),
      uploadSessions: bindUploadSessionStore(new UploadSessionStore(assetsDir)),
      now: () => nowMs,
      id: () => 'must-not-be-used',
    });
    const retried = await restartedService.createResource(
      {
        game_id: gameId,
        media_type: 'video',
        url: prepared.object_url,
        name: 'clip.mp4',
      },
      request,
    );

    expect(retried.resource_id).toBe('id-1');
    expect((await manifest.read(gameDir)).assets).toHaveLength(1);
    expect(
      existsSync(resolve(assetsDir, '.uploads', `${prepared.upload_token}.part`)),
    ).toBe(false);
    expect(
      readdirSync(resolve(assetsDir, 'blobs')).filter((name) => name === 'id-1.mp4'),
    ).toHaveLength(1);
  });

  test('rejects a reserved id collision with a missing fingerprint', async () => {
    const prepared = await service.prepareUpload(
      { fileName: 'clip.mp4', mimeType: 'video/mp4', bytes: FIXTURE.byteLength },
      request,
    );
    await sessionStore.reserve(prepared.upload_token, 'collision-id');
    await manifest.mutate(gameDir, (current) => {
      current.assets.push({
        id: 'collision-id',
        kind: 'video',
        name: 'unrelated',
        status: 'ready',
        mimeType: 'video/mp4',
        bytes: FIXTURE.byteLength,
        createdAt: 1,
        updatedAt: 1,
        provider: { kind: 'local', ref: 'blobs/collision-id.mp4' },
      });
    });

    await expectKinoError(
      service.createResource(
        {
          game_id: gameId,
          media_type: 'video',
          url: prepared.object_url,
          name: 'clip.mp4',
        },
        request,
      ),
      409,
      'resource_id_conflict',
    );

    expect((await sessionStore.read(prepared.upload_token))?.completedResourceId).toBeUndefined();
    expect(fakeProvider.finalizeCalls).toEqual([]);
  });

  test('rejects a reserved id collision with a wrong fingerprint', async () => {
    const prepared = await service.prepareUpload(
      { fileName: 'clip.mp4', mimeType: 'video/mp4', bytes: FIXTURE.byteLength },
      request,
    );
    await sessionStore.reserve(prepared.upload_token, 'collision-id');
    await manifest.mutate(gameDir, (current) => {
      current.assets.push({
        id: 'collision-id',
        kind: 'video',
        name: 'unrelated',
        status: 'ready',
        mimeType: 'video/mp4',
        bytes: FIXTURE.byteLength,
        createdAt: 1,
        updatedAt: 1,
        provider: { kind: 'local', ref: 'blobs/collision-id.mp4' },
        meta: { uploadFingerprint: '0'.repeat(64) },
      });
    });

    await expectKinoError(
      service.createResource(
        {
          game_id: gameId,
          media_type: 'video',
          url: prepared.object_url,
          name: 'clip.mp4',
        },
        request,
      ),
      409,
      'resource_id_conflict',
    );

    expect((await sessionStore.read(prepared.upload_token))?.completedResourceId).toBeUndefined();
    expect(fakeProvider.finalizeCalls).toEqual([]);
  });

  test('keeps ready state but reports upload cleanup failure diagnostically', async () => {
    const prepared = await service.prepareUpload(
      { fileName: 'clip.mp4', mimeType: 'video/mp4', bytes: FIXTURE.byteLength },
      request,
    );
    fakeProvider.cleanupShouldFail = true;

    await expectKinoError(
      service.createResource(
        {
          game_id: gameId,
          media_type: 'video',
          url: prepared.object_url,
          name: 'clip.mp4',
        },
        request,
      ),
      500,
      'upload_cleanup_failed',
    );

    expect(await manifest.get(gameDir, 'id-1')).not.toBeNull();
    expect((await sessionStore.read(prepared.upload_token))?.completedResourceId).toBe(
      'id-1',
    );
  });

  test('replaces provider mapping while preserving logical id, createdAt, and existing meta', async () => {
    await manifest.mutate(gameDir, (current) => {
      current.assets.push({
        id: 'm-narr-open',
        kind: 'video',
        name: 'old-name',
        status: 'ready',
        mimeType: 'video/mp4',
        bytes: 99,
        createdAt: 123,
        updatedAt: 124,
        provider: { kind: 'local', ref: 'blobs/narr-open.mp4' },
        meta: { scenarioId: 'nodia-main', source: 'local-import' },
      });
    });
    const prepared = await service.prepareUpload(
      {
        fileName: 'narr-open.mp4',
        mimeType: 'video/mp4',
        bytes: FIXTURE.byteLength,
        clientResourceId: 'm-narr-open',
        replaceExisting: true,
      },
      request,
    );

    const dto = await service.createResource(
      {
        game_id: gameId,
        media_type: 'video',
        url: prepared.object_url,
        name: 'new-name',
        source_meta: { duration_ms: 777 },
      },
      request,
    );

    expect(dto.resource_id).toBe('m-narr-open');
    const stored = await manifest.get(gameDir, 'm-narr-open');
    expect(stored).toMatchObject({
      id: 'm-narr-open',
      name: 'new-name',
      status: 'ready',
      bytes: FIXTURE.byteLength,
      durationMs: 777,
      createdAt: 123,
      provider: { kind: 'local', ref: 'blobs/m-narr-open.mp4' },
      meta: { scenarioId: 'nodia-main', source: 'local-import' },
    });
    expect(stored?.updatedAt).toBe(nowMs);
    expect(stored?.meta?.uploadFingerprint).toBe(
      createHash('sha256').update(prepared.upload_token, 'utf8').digest('hex'),
    );
    expect(fakeProvider.deleteCalls).toBe(0);
    const completed = await sessionStore.read(prepared.upload_token);
    expect(completed?.completedResourceId).toBe('m-narr-open');
    expect(completed?.providerState).toEqual({});
    expect(completed?.replaceExisting).toBeUndefined();
  });

  test('compensates only the newly finalized mapping when replacement manifest write fails', async () => {
    await manifest.mutate(gameDir, (current) => {
      current.assets.push({
        id: 'm-narr-open',
        kind: 'video',
        name: 'old',
        status: 'ready',
        mimeType: 'video/mp4',
        bytes: 99,
        createdAt: 1,
        updatedAt: 2,
        provider: { kind: 'local', ref: 'blobs/old-source.mp4' },
      });
    });
    const failingManifest = new VideoAssetManifestRepository({
      rename: () => {
        throw Object.assign(new Error('rename failed'), { code: 'EIO' });
      },
    });
    service = new VideoAssetService({
      getProjectRoot: () => projectRoot,
      providers: registry,
      manifest: failingManifest,
      uploadSessions,
      now: () => nowMs,
    });
    const prepared = await service.prepareUpload(
      {
        fileName: 'narr-open.mp4',
        mimeType: 'video/mp4',
        bytes: FIXTURE.byteLength,
        clientResourceId: 'm-narr-open',
        replaceExisting: true,
      },
      request,
    );

    await expectKinoError(
      service.createResource(
        {
          game_id: gameId,
          media_type: 'video',
          url: prepared.object_url,
          name: 'new',
        },
        request,
      ),
      500,
      'manifest_storage_error',
    );

    expect(fakeProvider.deletedAssetIds).toEqual(['m-narr-open']);
    expect((await manifest.get(gameDir, 'm-narr-open'))?.provider.ref).toBe(
      'blobs/old-source.mp4',
    );
  });

  test('retries replacement after completion persistence fails without finalizing twice', async () => {
    await manifest.mutate(gameDir, (current) => {
      current.assets.push({
        id: 'm-narr-open',
        kind: 'video',
        name: 'old',
        status: 'ready',
        mimeType: 'video/mp4',
        bytes: 99,
        createdAt: 1,
        updatedAt: 2,
        provider: { kind: 'local', ref: 'blobs/old.mp4' },
      });
    });
    let failCompletion = true;
    const retryStore = new UploadSessionStore(assetsDir, {
      writePrivateText: (path, contents) => {
        if (failCompletion && contents.includes('"completedResourceId"')) {
          throw Object.assign(new Error('completion write failed'), { code: 'EIO' });
        }
        writeFileSync(path, contents, { encoding: 'utf-8', mode: 0o600 });
      },
    });
    service = new VideoAssetService({
      getProjectRoot: () => projectRoot,
      providers: registry,
      manifest,
      uploadSessions: bindUploadSessionStore(retryStore),
      now: () => nowMs,
    });
    const prepared = await service.prepareUpload(
      {
        fileName: 'narr-open.mp4',
        mimeType: 'video/mp4',
        bytes: FIXTURE.byteLength,
        clientResourceId: 'm-narr-open',
        replaceExisting: true,
      },
      request,
    );
    const create = () =>
      service.createResource(
        {
          game_id: gameId,
          media_type: 'video',
          url: prepared.object_url,
          name: 'new',
        },
        request,
      );

    await expectKinoError(create(), 500, 'upload_session_storage_error');
    failCompletion = false;
    await expect(create()).resolves.toMatchObject({ resource_id: 'm-narr-open' });
    expect(fakeProvider.finalizeCalls).toEqual(['m-narr-open']);
    expect(fakeProvider.deleteCalls).toBe(0);
  });

  test('uses replacement CAS so two sessions with the same expectation cannot overwrite', async () => {
    await manifest.mutate(gameDir, (current) => {
      current.assets.push({
        id: 'm-narr-open',
        kind: 'video',
        name: 'old',
        status: 'ready',
        mimeType: 'video/mp4',
        bytes: 99,
        createdAt: 1,
        updatedAt: 2,
        provider: { kind: 'local', ref: 'blobs/old.mp4' },
        meta: { scenarioId: 'nodia-main' },
      });
    });
    const prepareReplacement = () =>
      service.prepareUpload(
        {
          fileName: 'narr-open.mp4',
          mimeType: 'video/mp4',
          bytes: FIXTURE.byteLength,
          clientResourceId: 'm-narr-open',
          replaceExisting: true,
        },
        request,
      );
    const first = await prepareReplacement();
    const second = await prepareReplacement();
    const firstSession = await sessionStore.read(first.upload_token);
    const secondSession = await sessionStore.read(second.upload_token);
    expect(firstSession?.replaceExpectedFingerprint).toBeString();
    expect(secondSession?.replaceExpectedFingerprint).toBe(
      firstSession?.replaceExpectedFingerprint,
    );
    fakeProvider.finalizeMappings = [
      { kind: 's3', ref: 'objects/new-a.mp4' },
      { kind: 's3', ref: 'objects/new-b.mp4' },
    ];
    const create = (objectUrl: string, name: string) =>
      service.createResource(
        {
          game_id: gameId,
          media_type: 'video',
          url: objectUrl,
          name,
        },
        request,
      );

    await expect(create(first.object_url, 'first')).resolves.toMatchObject({
      resource_id: 'm-narr-open',
    });
    await expect(create(first.object_url, 'first retry')).resolves.toMatchObject({
      resource_id: 'm-narr-open',
    });
    await expectKinoError(
      create(second.object_url, 'second'),
      409,
      'replacement_conflict',
    );

    const stored = await manifest.get(gameDir, 'm-narr-open');
    expect(stored?.name).toBe('first');
    expect(stored?.provider).toEqual({ kind: 's3', ref: 'objects/new-a.mp4' });
    expect(fakeProvider.finalizeCalls).toEqual(['m-narr-open', 'm-narr-open']);
    expect(fakeProvider.deletedProviderRefs).toEqual(['objects/new-b.mp4']);
  });

  test('does not replace a single resource when precommit playback verification fails', async () => {
    await manifest.mutate(gameDir, (current) => {
      current.assets.push({
        id: 'm-narr-open',
        kind: 'video',
        name: 'old',
        status: 'ready',
        mimeType: 'video/mp4',
        bytes: 99,
        createdAt: 1,
        updatedAt: 2,
        provider: { kind: 'local', ref: 'blobs/old.mp4' },
      });
    });
    fakeProvider.finalizeMappings = [{ kind: 's3', ref: 'objects/new.mp4' }];
    fakeProvider.getPlaybackFailAt = 1;
    const prepared = await service.prepareUpload(
      {
        fileName: 'narr-open.mp4',
        mimeType: 'video/mp4',
        bytes: FIXTURE.byteLength,
        clientResourceId: 'm-narr-open',
        replaceExisting: true,
      },
      request,
    );

    await expectKinoError(
      service.createResource(
        {
          game_id: gameId,
          media_type: 'video',
          url: prepared.object_url,
          name: 'new',
        },
        request,
      ),
      502,
      'provider_playback_failed',
    );

    expect((await manifest.get(gameDir, 'm-narr-open'))?.provider.ref).toBe(
      'blobs/old.mp4',
    );
    expect(fakeProvider.deletedProviderRefs).toEqual(['objects/new.mp4']);
    expect((await sessionStore.read(prepared.upload_token))?.completedResourceId).toBeUndefined();
  });
});

describe('VideoAssetService.updateResource', () => {
  test('rejects media type changes and path/body id mismatches', async () => {
    await manifest.mutate(gameDir, (m) => {
      m.assets.push({
        id: 'asset-1',
        kind: 'video',
        name: 'old',
        status: 'ready',
        mimeType: 'video/mp4',
        bytes: 4,
        createdAt: 1,
        updatedAt: 1,
        provider: { kind: 'local', ref: 'blobs/asset-1.mp4' },
      });
    });

    await expectKinoError(
      service.updateResource(
        'asset-1',
        {
          resource_id: 'asset-1',
          game_id: gameId,
          media_type: 'image',
          url: `${request.origin}/api/v1/kino/resources/asset-1/content?game_id=${gameId}`,
          name: 'new',
        },
        request,
      ),
      400,
      'invalid_media_type',
    );

    await expectKinoError(
      service.updateResource(
        'asset-1',
        {
          resource_id: 'other',
          game_id: gameId,
          media_type: 'video',
          url: `${request.origin}/api/v1/kino/resources/asset-1/content?game_id=${gameId}`,
          name: 'new',
        },
        request,
      ),
      400,
      'resource_id_mismatch',
    );
  });

  test('does not mutate manifest when provider update fails', async () => {
    await manifest.mutate(gameDir, (m) => {
      m.assets.push({
        id: 'asset-2',
        kind: 'video',
        name: 'old-name',
        status: 'ready',
        mimeType: 'video/mp4',
        bytes: 4,
        createdAt: 1,
        updatedAt: 1,
        provider: { kind: 'local', ref: 'blobs/asset-2.mp4' },
      });
    });
    fakeProvider.updateShouldFail = true;

    await expectKinoError(
      service.updateResource(
        'asset-2',
        {
          resource_id: 'asset-2',
          game_id: gameId,
          media_type: 'video',
          url: `${request.origin}/api/v1/kino/resources/asset-2/content?game_id=${gameId}`,
          name: 'new-name',
        },
        request,
      ),
      500,
      'provider_update_failed',
    );

    expect((await manifest.get(gameDir, 'asset-2'))?.name).toBe('old-name');
  });
});

describe('VideoAssetService.deleteResource', () => {
  test('deletes manifest after provider success and returns 404 on retry', async () => {
    await manifest.mutate(gameDir, (m) => {
      m.assets.push({
        id: 'asset-del',
        kind: 'video',
        name: 'clip',
        status: 'ready',
        mimeType: 'video/mp4',
        bytes: 4,
        createdAt: 1,
        updatedAt: 1,
        provider: { kind: 'local', ref: 'blobs/asset-del.mp4' },
      });
    });

    await service.deleteResource('asset-del', request);
    expect(await manifest.get(gameDir, 'asset-del')).toBeNull();
    expect(fakeProvider.deleteCalls).toBe(1);

    await expectKinoError(service.deleteResource('asset-del', request), 404, 'resource_not_found');
  });
});

describe('VideoAssetService.batchCreateResources', () => {
  test('deduplicates URLs, skips repeats, and rejects invalid uploads before mutation', async () => {
    const firstPrepared = await service.prepareUpload(
      { fileName: 'a.mp4', mimeType: 'video/mp4', bytes: FIXTURE.byteLength },
      request,
    );
    const secondPrepared = await service.prepareUpload(
      { fileName: 'b.mp4', mimeType: 'video/mp4', bytes: FIXTURE.byteLength },
      request,
    );

    fakeProvider.inspectResult = {
      ref: `.uploads/${firstPrepared.upload_token}.part`,
      bytes: FIXTURE.byteLength,
      mimeType: 'video/mp4',
    };

    await expectKinoError(
      service.batchCreateResources(
        {
          game_id: gameId,
          resources: [
            { media_type: 'video', url: firstPrepared.object_url, name: 'a.mp4' },
            { media_type: 'video', url: 'http://evil.example/not-an-upload', name: 'bad.mp4' },
          ],
        },
        request,
      ),
      400,
      'invalid_upload_reference',
    );
    expect((await manifest.read(gameDir)).assets).toEqual([]);

    fakeProvider.inspectResult = {
      ref: `.uploads/${firstPrepared.upload_token}.part`,
      bytes: FIXTURE.byteLength,
      mimeType: 'video/mp4',
    };
    const batch = await service.batchCreateResources(
      {
        game_id: gameId,
        resources: [
          { media_type: 'video', url: firstPrepared.object_url, name: 'a.mp4' },
          { media_type: 'video', url: firstPrepared.object_url, name: 'a.mp4' },
          {
            media_type: 'video',
            url: secondPrepared.object_url,
            name: 'b.mp4',
          },
        ],
      },
      request,
    );

    expect(batch.created_count).toBe(2);
    expect(batch.skipped_count).toBe(1);
    expect(batch.items).toHaveLength(2);
    expect((await manifest.read(gameDir)).assets).toHaveLength(2);
  });

  test('compensates prior finalized objects and leaves manifest unchanged when a later finalize fails', async () => {
    const prepared = await Promise.all(
      ['a.mp4', 'b.mp4', 'c.mp4'].map((fileName) =>
        service.prepareUpload(
          { fileName, mimeType: 'video/mp4', bytes: FIXTURE.byteLength },
          request,
        ),
      ),
    );
    fakeProvider.finalizeFailAt = 2;

    await expectKinoError(
      service.batchCreateResources(
        {
          game_id: gameId,
          resources: prepared.map((entry, index) => ({
            media_type: 'video' as const,
            url: entry.object_url,
            name: `${index}.mp4`,
          })),
        },
        request,
      ),
      500,
      'provider_finalize_failed',
    );

    expect(fakeProvider.finalizeCalls).toEqual(['id-1', 'id-2']);
    expect(fakeProvider.deletedAssetIds).toEqual(['id-1']);
    expect((await manifest.read(gameDir)).assets).toEqual([]);
  });

  test('recovers a fully written batch after completion persistence fails without re-finalizing', async () => {
    const failingSessions = bindUploadSessionStore(new UploadSessionStore(assetsDir, {
      writePrivateText: (path, contents) => {
        if (contents.includes('"completedResourceId"')) {
          throw Object.assign(new Error('completion write failed'), { code: 'EIO' });
        }
        writeFileSync(path, contents, { encoding: 'utf-8', mode: 0o600 });
      },
    }));
    const firstService = new VideoAssetService({
      getProjectRoot: () => projectRoot,
      providers: registry,
      manifest,
      uploadSessions: failingSessions,
      now: () => nowMs,
      id: () => ids.shift() ?? 'fallback-id',
    });
    const prepared = await Promise.all(
      ['a.mp4', 'b.mp4'].map((fileName) =>
        firstService.prepareUpload(
          { fileName, mimeType: 'video/mp4', bytes: FIXTURE.byteLength },
          request,
        ),
      ),
    );
    const input = {
      game_id: gameId,
      resources: prepared.map((entry, index) => ({
        media_type: 'video' as const,
        url: entry.object_url,
        name: `${index}.mp4`,
      })),
    };

    await expectKinoError(
      firstService.batchCreateResources(input, request),
      500,
      'upload_session_storage_error',
    );
    expect((await manifest.read(gameDir)).assets).toHaveLength(2);
    expect(fakeProvider.finalizeCalls).toEqual(['id-1', 'id-2']);

    const restartedService = new VideoAssetService({
      getProjectRoot: () => projectRoot,
      providers: registry,
      manifest: new VideoAssetManifestRepository(),
      uploadSessions: bindUploadSessionStore(new UploadSessionStore(assetsDir)),
      now: () => nowMs,
      id: () => 'must-not-be-used',
    });
    const retried = await restartedService.batchCreateResources(input, request);

    expect(retried.created_count).toBe(2);
    expect(retried.items.map((item) => item.resource_id)).toEqual(['id-1', 'id-2']);
    expect(fakeProvider.finalizeCalls).toEqual(['id-1', 'id-2']);
    expect((await manifest.read(gameDir)).assets).toHaveLength(2);
  });

  test('retries a compensated batch with retained Local temp uploads', async () => {
    const { createLocalVideoAssetProvider } = await import(
      '../../src/video-assets/providers/local'
    );
    const local = createLocalVideoAssetProvider(() => projectRoot);
    let finalizeCalls = 0;
    let failSecond = true;
    const flakyLocal: VideoAssetProvider = {
      ...local,
      finalizeResource: async (object, input, context) => {
        finalizeCalls += 1;
        if (failSecond && finalizeCalls === 2) {
          throw new KinoApiError('finalize failed', 500, 'provider_finalize_failed');
        }
        return local.finalizeResource(object, input, context);
      },
    };
    registry.control.setProvider(flakyLocal);
    const prepared = await Promise.all(
      ['a.mp4', 'b.mp4'].map((fileName) =>
        service.prepareUpload(
          { fileName, mimeType: 'video/mp4', bytes: FIXTURE.byteLength },
          request,
        ),
      ),
    );
    for (const upload of prepared) {
      await service.receiveUpload(upload.upload_token, streamFrom(FIXTURE), request);
    }
    const input = {
      game_id: gameId,
      resources: prepared.map((upload, index) => ({
        media_type: 'video' as const,
        url: upload.object_url,
        name: `${index}.mp4`,
      })),
    };

    await expectKinoError(
      service.batchCreateResources(input, request),
      500,
      'provider_finalize_failed',
    );
    expect((await manifest.read(gameDir)).assets).toEqual([]);
    expect(existsSync(resolve(assetsDir, 'blobs', 'id-1.mp4'))).toBe(false);
    for (const upload of prepared) {
      expect(
        existsSync(resolve(assetsDir, '.uploads', `${upload.upload_token}.part`)),
      ).toBe(true);
    }

    failSecond = false;
    const retried = await service.batchCreateResources(input, request);

    expect(retried.items.map((item) => item.resource_id)).toEqual(['id-1', 'id-2']);
    expect((await manifest.read(gameDir)).assets).toHaveLength(2);
    for (const upload of prepared) {
      expect(
        existsSync(resolve(assetsDir, '.uploads', `${upload.upload_token}.part`)),
      ).toBe(false);
    }
  });

  test('compensates every new mapping and keeps old mappings when second playback verification fails', async () => {
    await manifest.mutate(gameDir, (current) => {
      current.assets.push(
        {
          id: 'm-a',
          kind: 'video',
          name: 'old-a',
          status: 'ready',
          mimeType: 'video/mp4',
          bytes: 9,
          createdAt: 1,
          updatedAt: 2,
          provider: { kind: 'local', ref: 'blobs/old-a.mp4' },
        },
        {
          id: 'm-b',
          kind: 'video',
          name: 'old-b',
          status: 'ready',
          mimeType: 'video/mp4',
          bytes: 9,
          createdAt: 1,
          updatedAt: 2,
          provider: { kind: 'local', ref: 'blobs/old-b.mp4' },
        },
      );
    });
    const prepared = await Promise.all(
      ['m-a', 'm-b'].map((clientResourceId) =>
        service.prepareUpload(
          {
            fileName: `${clientResourceId}.mp4`,
            mimeType: 'video/mp4',
            bytes: FIXTURE.byteLength,
            clientResourceId,
            replaceExisting: true,
          },
          request,
        ),
      ),
    );
    fakeProvider.finalizeMappings = [
      { kind: 's3', ref: 'objects/new-a.mp4' },
      { kind: 's3', ref: 'objects/new-b.mp4' },
    ];
    fakeProvider.getPlaybackFailAt = 2;

    await expectKinoError(
      service.batchCreateResources(
        {
          game_id: gameId,
          resources: prepared.map((entry, index) => ({
            media_type: 'video' as const,
            url: entry.object_url,
            name: `new-${index}`,
          })),
        },
        request,
      ),
      502,
      'provider_playback_failed',
    );

    const stored = await manifest.read(gameDir);
    expect(stored.assets.map((asset) => asset.provider.ref)).toEqual([
      'blobs/old-a.mp4',
      'blobs/old-b.mp4',
    ]);
    expect(fakeProvider.deletedProviderRefs).toEqual([
      'objects/new-b.mp4',
      'objects/new-a.mp4',
    ]);
    for (const entry of prepared) {
      expect((await sessionStore.read(entry.upload_token))?.completedResourceId).toBeUndefined();
    }
  });

  test('commits a verified replacement batch with one manifest mutation and stable ids', async () => {
    await manifest.mutate(gameDir, (current) => {
      current.assets.push(
        {
          id: 'm-a',
          kind: 'video',
          name: 'old-a',
          status: 'ready',
          mimeType: 'video/mp4',
          bytes: 9,
          createdAt: 1,
          updatedAt: 2,
          provider: { kind: 'local', ref: 'blobs/old-a.mp4' },
        },
        {
          id: 'm-b',
          kind: 'video',
          name: 'old-b',
          status: 'ready',
          mimeType: 'video/mp4',
          bytes: 9,
          createdAt: 1,
          updatedAt: 2,
          provider: { kind: 'local', ref: 'blobs/old-b.mp4' },
        },
      );
    });
    let manifestRenameCount = 0;
    const countingManifest = new VideoAssetManifestRepository({
      rename: (source, destination) => {
        manifestRenameCount += 1;
        renameSync(source, destination);
      },
    });
    service = new VideoAssetService({
      getProjectRoot: () => projectRoot,
      providers: registry,
      manifest: countingManifest,
      uploadSessions,
      now: () => nowMs,
    });
    const prepared = await Promise.all(
      ['m-a', 'm-b'].map((clientResourceId) =>
        service.prepareUpload(
          {
            fileName: `${clientResourceId}.mp4`,
            mimeType: 'video/mp4',
            bytes: FIXTURE.byteLength,
            clientResourceId,
            replaceExisting: true,
          },
          request,
        ),
      ),
    );
    fakeProvider.finalizeMappings = [
      { kind: 's3', ref: 'objects/new-a.mp4' },
      { kind: 's3', ref: 'objects/new-b.mp4' },
    ];

    const result = await service.batchCreateResources(
      {
        game_id: gameId,
        resources: prepared.map((entry, index) => ({
          media_type: 'video' as const,
          url: entry.object_url,
          name: `new-${index}`,
        })),
      },
      request,
    );

    expect(result.items.map((item) => item.resource_id)).toEqual(['m-a', 'm-b']);
    expect(manifestRenameCount).toBe(1);
    expect(fakeProvider.getPlaybackCalls).toBe(2);
    expect((await countingManifest.read(gameDir)).assets.map((asset) => asset.id)).toEqual([
      'm-a',
      'm-b',
    ]);
  });
});

describe('VideoAssetService reconciliation', () => {
  test('uses the reconciliation cache within TTL and refreshes after expiry', async () => {
    fakeProvider.upstreamPages = [
      {
        total: 1,
        items: [
          {
            upstreamResourceId: 'upstream-cache',
            name: 'before',
            url: 'blobs/upstream-cache.mp4',
            bytes: 10,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
    ];
    const query = {
      game_id: gameId,
      media_type: 'video' as const,
      page: 1,
      page_size: 20,
    };

    await service.listResources(query, request);
    fakeProvider.upstreamPages[0]!.items[0]!.name = 'after';
    await service.listResources(query, request);
    expect(fakeProvider.upstreamCalls).toEqual([1]);
    expect((await manifest.get(gameDir, 'upstream-cache'))?.name).toBe('before');

    nowMs += 5_001;
    await service.listResources(query, request);
    expect(fakeProvider.upstreamCalls).toEqual([1, 1]);
    expect((await manifest.get(gameDir, 'upstream-cache'))?.name).toBe('after');
  });

  test('treats an injected clock value of zero as an initial cache miss', async () => {
    nowMs = 0;
    fakeProvider.upstreamPages = [
      {
        total: 1,
        items: [
          {
            upstreamResourceId: 'upstream-zero',
            name: 'zero',
            url: 'blobs/upstream-zero.mp4',
            bytes: 10,
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      },
    ];

    await service.listResources(
      { game_id: gameId, media_type: 'video', page: 1, page_size: 20 },
      request,
    );

    expect(fakeProvider.upstreamCalls).toEqual([1]);
  });

  test('fetches every upstream page before slicing the local first page', async () => {
    fakeProvider.upstreamPages = [
      {
        total: 2,
        items: [
          {
            upstreamResourceId: 'upstream-a',
            name: 'a',
            url: 'blobs/upstream-a.mp4',
            bytes: 10,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
      {
        total: 2,
        items: [
          {
            upstreamResourceId: 'upstream-b',
            name: 'b',
            url: 'blobs/upstream-b.mp4',
            bytes: 20,
            createdAt: 2,
            updatedAt: 2,
          },
        ],
      },
    ];

    const page = await service.listResources(
      { game_id: gameId, media_type: 'video', page: 1, page_size: 1 },
      request,
    );

    expect(fakeProvider.upstreamCalls).toEqual([1, 2]);
    expect((await manifest.read(gameDir)).assets).toHaveLength(2);
    expect(page.items.map((item) => item.resource_id)).toEqual(['upstream-b']);
    expect(page.total).toBe(2);
  });

  test('starts reconciliation at upstream page 1 even when local page 2 is requested', async () => {
    fakeProvider.upstreamPages = [
      {
        total: 2,
        items: [
          {
            upstreamResourceId: 'upstream-a',
            name: 'a',
            url: 'blobs/upstream-a.mp4',
            bytes: 10,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
      {
        total: 2,
        items: [
          {
            upstreamResourceId: 'upstream-b',
            name: 'b',
            url: 'blobs/upstream-b.mp4',
            bytes: 20,
            createdAt: 2,
            updatedAt: 2,
          },
        ],
      },
    ];

    const page = await service.listResources(
      { game_id: gameId, media_type: 'video', page: 2, page_size: 1 },
      request,
    );

    expect(fakeProvider.upstreamCalls).toEqual([1, 2]);
    expect((await manifest.read(gameDir)).assets).toHaveLength(2);
    expect(page.items.map((item) => item.resource_id)).toEqual(['upstream-a']);
  });

  test('preserves existing logical ids by upstreamResourceId and uses upstream id for new items', async () => {
    await manifest.mutate(gameDir, (m) => {
      m.assets.push({
        id: 'logical-a',
        kind: 'video',
        name: 'existing',
        status: 'ready',
        mimeType: 'video/mp4',
        bytes: 10,
        createdAt: 1,
        updatedAt: 1,
        provider: {
          kind: 'local',
          ref: 'blobs/logical-a.mp4',
          upstreamResourceId: 'upstream-a',
        },
      });
    });

    fakeProvider.upstreamPages = [
      {
        total: 2,
        items: [
          {
            upstreamResourceId: 'upstream-a',
            name: 'existing-renamed',
            url: 'blobs/upstream-a.mp4',
            bytes: 10,
            createdAt: 2,
            updatedAt: 3,
          },
          {
            upstreamResourceId: 'upstream-b',
            name: 'brand-new',
            url: 'blobs/upstream-b.mp4',
            bytes: 20,
            createdAt: 4,
            updatedAt: 5,
          },
        ],
      },
    ];

    const page = await service.listResources(
      { game_id: gameId, media_type: 'video', page: 1, page_size: 20 },
      request,
    );

    expect(page.items.map((item) => item.resource_id).sort()).toEqual(['logical-a', 'upstream-b']);
    expect(page.items.find((item) => item.resource_id === 'logical-a')?.name).toBe(
      'existing-renamed',
    );

    const manifestAfter = await manifest.read(gameDir);
    expect(manifestAfter.assets.find((asset) => asset.id === 'logical-a')?.provider.upstreamResourceId).toBe(
      'upstream-a',
    );
    expect(manifestAfter.assets.find((asset) => asset.id === 'upstream-b')).toBeDefined();
  });

  test('does not delete manifest entries that exist only locally', async () => {
    await manifest.mutate(gameDir, (m) => {
      m.assets.push({
        id: 'local-only',
        kind: 'video',
        name: 'local',
        status: 'ready',
        mimeType: 'video/mp4',
        bytes: 4,
        createdAt: 1,
        updatedAt: 1,
        provider: { kind: 'local', ref: 'blobs/local-only.mp4' },
      });
    });
    fakeProvider.upstreamPages = [{ total: 0, items: [] }];

    await service.listResources({ game_id: gameId, media_type: 'video' }, request);
    expect(await manifest.get(gameDir, 'local-only')).not.toBeNull();
  });
});

describe('VideoAssetService.receiveUpload with local provider integration', () => {
  test('accepts streamed bytes through the active local provider', async () => {
    const { createLocalVideoAssetProvider } = await import('../../src/video-assets/providers/local');
    registry.control.setProvider(createLocalVideoAssetProvider(() => projectRoot));

    const prepared = await service.prepareUpload(
      { fileName: 'clip.mp4', mimeType: 'video/mp4', bytes: FIXTURE.byteLength },
      request,
    );
    await service.receiveUpload(prepared.upload_token, streamFrom(FIXTURE), request);

    const partPath = resolve(assetsDir, '.uploads', `${prepared.upload_token}.part`);
    expect(readFileSync(partPath)).toEqual(Buffer.from(FIXTURE));
  });
});
