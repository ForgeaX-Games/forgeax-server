import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createForgeaxMediaCapability, type ForgeaxVideoAssetService } from '../../src/workbench/media-adapter';
import { KinoApiError } from '../../src/video-assets/kino-api';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('createForgeaxMediaCapability', () => {
  test('maps list, local reads, uploads, retries, and delete through the existing service', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-media-adapter-'));
    roots.push(root);
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
      source_meta: { mime_type: 'video/mp4', extra: { workbench_fingerprint: 'fingerprint' } },
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
      deleteResource: async (id) => { deleted = id; },
    };
    const media = createForgeaxMediaCapability(service, { runtimeId: 'rt-video' });

    const listed = await media.list('game-1', { type: 'video' });
    expect(listed[0]).toMatchObject({
      id: 'resource-1',
      type: 'video',
      contentType: 'video/mp4',
      url: '/__workbench__/v1/extension/rt-video/media/assets/resource-1?gameId=game-1',
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
    await media.delete('game-1', 'resource-1');
    expect(deleted).toBe('resource-1');
  });

  test('returns an exact idempotent retry and rejects a conflicting payload', async () => {
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
      deleteResource: async () => {},
    };
    const media = createForgeaxMediaCapability(service, { runtimeId: 'rt-video' });
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
});
