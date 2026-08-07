import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createForgeaxMediaCapability, type ForgeaxVideoAssetService } from '../../src/workbench/media-adapter';
import { KinoApiError } from '../../src/video-assets/kino-api';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('createForgeaxMediaCapability', () => {
  test('projects every media type registered by the active private provider', async () => {
    const requestedTypes: string[] = [];
    const service = {
      getProviderCapabilities: () => ({
        provider: 'kino' as const,
        media_types: ['image', 'video', 'audio'] as const,
        upload_mimes: ['image/png', 'video/mp4', 'audio/mpeg'] as const,
      }),
      listResources: async (query: { media_type: 'image' | 'video' | 'audio' | 'font' }) => {
        requestedTypes.push(query.media_type);
        return {
          items: [{
            resource_id: `${query.media_type}-1`,
            game_id: 'game-1',
            media_type: query.media_type,
            url: `https://media.example/${query.media_type}-1`,
            created_at: 1,
            updated_at: 1,
          }],
          total: 1,
          page: 1,
          page_size: 100,
        };
      },
    } as unknown as ForgeaxVideoAssetService;
    const media = createForgeaxMediaCapability(service, {
      runtimeId: 'rt-video',
      projectRoot: '/project',
    });

    await expect(media.list('game-1')).resolves.toEqual([
      expect.objectContaining({ id: 'image-1', type: 'image', contentType: 'image/png' }),
      expect.objectContaining({ id: 'video-1', type: 'video', contentType: 'video/mp4' }),
      expect.objectContaining({ id: 'audio-1', type: 'audio', contentType: 'audio/mpeg' }),
    ]);
    await expect(media.list('game-1', { type: 'font' })).resolves.toEqual([]);
    expect(requestedTypes).toEqual(['image', 'video', 'audio']);
  });

  test('maps list, local reads, uploads, retries, and delete through the existing service', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-media-adapter-'));
    roots.push(root);
    await mkdir(join(root, '.forgeax', 'games', 'game-1'), { recursive: true });
    const mediaPath = join(root, 'clip.mp4');
    await writeFile(mediaPath, new Uint8Array([1, 2, 3]));
    const created: any[] = [];
    let received = new Uint8Array();
    let deleted: string | undefined;
    let preparedFileName: string | undefined;
    const dto = {
      resource_id: 'resource-1',
      game_id: 'game-1',
      media_type: 'video' as const,
      name: 'clip.mp4',
      url: '/api/v1/kino/resources/resource-1/content',
      source_meta: {
        mime_type: 'video/mp4',
        extra: {
          bytes: 3,
          source: 'fixture',
          workbench_fingerprint: 'fingerprint',
        },
      },
      created_at: 1,
      updated_at: 2,
    };
    const service: ForgeaxVideoAssetService = {
      listResources: async () => ({ items: [dto], total: 1, page: 1, page_size: 100 }),
      getResource: async () => dto,
      playResource: async () => ({
        kind: 'local',
        filePath: mediaPath,
        mimeType: 'video/mp4',
        bytes: 3,
        etag: 'W/"fixture"',
        lastModified: new Date(0).toUTCString(),
      }),
      prepareUpload: async (input) => {
        preparedFileName = input.fileName;
        return {
          upload: { method: 'PUT', url: '/upload', headers: {}, expires_at: new Date().toISOString() },
          object_url: 'workbench-upload:token',
          upload_token: 'token',
        };
      },
      receiveUpload: async (_token, stream) => {
        received = new Uint8Array(await new Response(stream).arrayBuffer());
      },
      createResource: async (input) => {
        created.push(input);
        return { ...dto, resource_id: input.game_id === 'game-1' ? 'resource-1' : 'bad' };
      },
      updateResource: async (_id, input) => ({
        ...dto,
        name: input.name,
        source_meta: input.source_meta,
      }),
      deleteResource: async (id) => { deleted = id; },
    };
    const media = createForgeaxMediaCapability(service, {
      runtimeId: 'rt-video',
      projectRoot: root,
    });

    const listed = await media.list('game-1', { type: 'video' });
    expect(listed[0]).toMatchObject({
      id: 'resource-1',
      type: 'video',
      filename: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes: 3,
      metadata: { bytes: 3, source: 'fixture' },
      url: '/__workbench__/v1/extension/rt-video/media/resources/resource-1/content?gameId=game-1',
    });
    expect(await media.read('game-1', 'resource-1')).toEqual({
      contentType: 'video/mp4',
      bytes: new Uint8Array([1, 2, 3]),
    });
    await media.put('game-1', {
      filename: 'generated-asset',
      contentType: 'video/mp4',
      bytes: new Uint8Array([4, 5]),
    });
    expect(preparedFileName).toBe('generated-asset.mp4');
    expect(received).toEqual(new Uint8Array([4, 5]));
    expect(created).toHaveLength(1);
    expect(await media.update('game-1', 'resource-1', {
      filename: 'renamed.mp4',
      metadata: { source: 'renamed' },
    })).toMatchObject({
      filename: 'renamed.mp4',
      metadata: { source: 'renamed' },
    });
    await media.delete('game-1', 'resource-1');
    expect(deleted).toBe('resource-1');
  });

  test('executes the active provider direct-upload instruction before creating a resource', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-media-adapter-'));
    roots.push(root);
    await mkdir(join(root, '.forgeax', 'games', 'game-1'), { recursive: true });
    let uploaded = new Uint8Array();
    let uploadRequest: { url: string; method?: string; contentType?: string } | undefined;
    let created = false;
    const service = {
      getProviderUploadTransport: () => 'direct' as const,
      prepareUpload: async () => ({
        upload: {
          method: 'PUT' as const,
          url: 'https://cos.example.test/signed-upload',
          headers: { 'content-type': 'video/mp4', 'x-provider-header': 'required' },
          expires_at: new Date().toISOString(),
        },
        object_url: 'http://127.0.0.1/api/v1/kino/uploads/token',
        upload_token: 'token',
      }),
      receiveUpload: async () => { throw new Error('receiver transport must not be used'); },
      createResource: async (input: { game_id: string }) => {
        created = true;
        return {
          resource_id: 'resource-1',
          game_id: input.game_id,
          media_type: 'video' as const,
          name: 'clip.mp4',
          url: 'https://media.example.test/clip.mp4',
          created_at: 1,
          updated_at: 1,
        };
      },
    } as unknown as ForgeaxVideoAssetService;
    const media = createForgeaxMediaCapability(service, {
      runtimeId: 'rt-video',
      projectRoot: root,
      fetch: async (input, init) => {
        uploadRequest = {
          url: String(input),
          method: init?.method,
          contentType: new Headers(init?.headers).get('content-type') ?? undefined,
        };
        uploaded = new Uint8Array(await new Response(init?.body).arrayBuffer());
        return new Response(null, { status: 200 });
      },
    });

    await media.put('game-1', {
      filename: 'clip.mp4',
      contentType: 'video/mp4',
      bytes: new Uint8Array([4, 5, 6]),
    });

    expect(uploadRequest).toEqual({
      url: 'https://cos.example.test/signed-upload',
      method: 'PUT',
      contentType: 'video/mp4',
    });
    expect(uploaded).toEqual(new Uint8Array([4, 5, 6]));
    expect(created).toBeTrue();
  });

  test('returns an exact idempotent retry and rejects a conflicting payload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-media-adapter-'));
    roots.push(root);
    await mkdir(join(root, '.forgeax', 'games', 'game-1'), { recursive: true });
    let stored: any;
    let creates = 0;
    let reservedId = '';
    const service: ForgeaxVideoAssetService = {
      listResources: async () => ({ items: [], total: 0, page: 1, page_size: 100 }),
      getResource: async (id) => {
        if (!stored || stored.resource_id !== id) {
          throw new KinoApiError('resource not found', 404);
        }
        return stored;
      },
      playResource: async () => { throw new Error('unused'); },
      prepareUpload: async (input) => {
        reservedId = input.clientResourceId ?? 'unstable';
        return {
          upload: { method: 'PUT', url: '/upload', headers: {}, expires_at: new Date().toISOString() },
          object_url: 'workbench-upload:token',
          upload_token: 'token',
        };
      },
      receiveUpload: async () => {},
      createResource: async (input) => {
        creates += 1;
        stored = {
          resource_id: reservedId,
          game_id: input.game_id,
          media_type: input.media_type,
          name: input.name,
          url: input.url,
          source_meta: input.source_meta,
          created_at: 1,
          updated_at: 1,
        };
        return stored;
      },
      updateResource: async () => { throw new Error('unused'); },
      deleteResource: async () => {},
    };
    const media = createForgeaxMediaCapability(service, {
      runtimeId: 'rt-video',
      projectRoot: root,
    });
    const input = {
      filename: 'clip.mp4',
      contentType: 'video/mp4',
      bytes: new Uint8Array([7, 8, 9]),
      idempotencyKey: 'task-123',
    };

    const first = await media.put('game-1', input);
    const retry = await media.put('game-1', input);

    expect(retry).toEqual(first);
    expect(creates).toBe(1);
    await expect(media.put('game-1', {
      ...input,
      bytes: new Uint8Array([9, 8, 7]),
    })).rejects.toThrow('reused with different input');
  });

  test('persists resumable upload checkpoints and completes exactly once after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-media-adapter-'));
    roots.push(root);
    await mkdir(join(root, '.forgeax', 'games', 'game-1'), { recursive: true });
    let stored: any;
    let reservedId = '';
    let creates = 0;
    let received = new Uint8Array();
    const service: ForgeaxVideoAssetService = {
      listResources: async () => ({ items: [], total: 0, page: 1, page_size: 100 }),
      getResource: async (id) => {
        if (!stored || stored.resource_id !== id) throw new KinoApiError('not found', 404);
        return stored;
      },
      playResource: async () => { throw new Error('unused'); },
      prepareUpload: async (input) => {
        reservedId = input.clientResourceId ?? 'unstable';
        return {
          upload: { method: 'PUT', url: '/upload', headers: {}, expires_at: new Date().toISOString() },
          object_url: 'workbench-upload:token',
          upload_token: 'token',
        };
      },
      receiveUpload: async (_token, stream) => {
        received = new Uint8Array(await new Response(stream).arrayBuffer());
      },
      createResource: async (input) => {
        creates += 1;
        stored = {
          resource_id: reservedId,
          game_id: input.game_id,
          media_type: input.media_type,
          name: input.name,
          url: input.url,
          source_meta: input.source_meta,
          created_at: 1,
          updated_at: 1,
        };
        return stored;
      },
      updateResource: async () => { throw new Error('unused'); },
      deleteResource: async () => {},
    };
    const options = { runtimeId: 'rt-video', projectRoot: root };
    const media = createForgeaxMediaCapability(service, options);
    const input = {
      filename: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes: 4,
      metadata: { source: 'browser-upload' },
      idempotencyKey: 'browser-upload-1',
    };

    const upload = await media.createUpload('game-1', input);
    expect(upload).toMatchObject({ offset: 0, state: 'uploading' });
    expect(await media.writeUploadChunk('game-1', upload.id, {
      offset: 0,
      bytes: new Uint8Array([1, 2]),
    })).toMatchObject({ offset: 2 });
    expect(await media.writeUploadChunk('game-1', upload.id, {
      offset: 0,
      bytes: new Uint8Array([1, 2]),
    })).toMatchObject({ offset: 2 });
    await expect(media.writeUploadChunk('game-1', upload.id, {
      offset: 0,
      bytes: new Uint8Array([2, 1]),
    })).rejects.toThrow('conflicts with stored bytes');

    const recovered = createForgeaxMediaCapability(service, options);
    expect(await recovered.getUpload('game-1', upload.id)).toMatchObject({ offset: 2 });
    await recovered.writeUploadChunk('game-1', upload.id, {
      offset: 2,
      bytes: new Uint8Array([3, 4]),
    });
    const [asset, concurrentRetry] = await Promise.all([
      recovered.completeUpload('game-1', upload.id),
      recovered.completeUpload('game-1', upload.id),
    ]);
    expect(received).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(asset.metadata).toEqual({
      source: 'browser-upload',
      created_at: 1,
      updated_at: 1,
    });
    expect(concurrentRetry).toEqual(asset);
    expect(creates).toBe(1);

    const restarted = createForgeaxMediaCapability(service, options);
    expect(await restarted.completeUpload('game-1', upload.id)).toEqual(asset);
    expect(await restarted.createUpload('game-1', input)).toMatchObject({
      id: upload.id,
      offset: 4,
      state: 'completed',
    });
    expect(creates).toBe(1);
    await expect(restarted.createUpload('game-1', {
      ...input,
      filename: 'other.mp4',
    })).rejects.toThrow('reused with different input');
  });
});
