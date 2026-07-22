import { beforeEach, describe, expect, test } from 'bun:test';
import type { VideoAssetRequestContext } from '../../src/video-assets/contracts';
import { KinoApiError } from '../../src/video-assets/kino-api';
import type { S3ObjectClient } from '../../src/video-assets/providers/s3';
import {
  buildS3ClientConfig,
  createDefaultS3ObjectClient,
  createS3VideoAssetProvider,
} from '../../src/video-assets/providers/s3';
import type { S3VideoStorageConfig } from '../../src/video-assets/config';

const FIXTURE_BYTES = 6;
const FIXED_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONFIG: S3VideoStorageConfig = {
  kind: 's3',
  bucket: 'forgeax-videos',
  region: 'ap-east-1',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'super-secret-value',
  prefix: 'uploads',
};

class FakeS3Client implements S3ObjectClient {
  deleted: string[] = [];
  readonly heads = new Map<string, { bytes: number; mimeType?: string }>();

  signPutCalls: Array<{ key: string; mimeType: string; expiresIn: number }> = [];
  signGetCalls: Array<{ key: string; expiresIn: number }> = [];

  async signPut(key: string, mimeType: string, expiresIn: number): Promise<string> {
    this.signPutCalls.push({ key, mimeType, expiresIn });
    return `https://s3.example.test/${key}?put=1`;
  }

  async signGet(key: string, expiresIn: number): Promise<string> {
    this.signGetCalls.push({ key, expiresIn });
    return `https://s3.example.test/${key}?get=1`;
  }

  async head(key: string): Promise<{ bytes: number; mimeType?: string }> {
    const value = this.heads.get(key);
    if (!value) {
      throw new Error('not found');
    }
    return value;
  }

  async delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.heads.delete(key);
  }
}

let client: FakeS3Client;
let provider: ReturnType<typeof createS3VideoAssetProvider>;
let context: VideoAssetRequestContext;

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
  client = new FakeS3Client();
  provider = createS3VideoAssetProvider(CONFIG, {
    client,
    randomUuid: () => FIXED_UUID,
  });
  context = {
    gameId: 'demo',
    identity: 'user-1',
    origin: 'http://127.0.0.1:18900',
  };
});

describe('S3VideoAssetProvider.prepareUpload', () => {
  test('returns a ten-minute presigned PUT with scoped unpredictable key', async () => {
    const now = Date.now();
    const draft = await provider.prepareUpload(
      {
        uploadToken: 'unused-token',
        fileName: 'clip.mp4',
        mimeType: 'video/mp4',
        bytes: FIXTURE_BYTES,
      },
      context,
    );

    expect(draft.instruction.method).toBe('PUT');
    expect(draft.instruction.url).toBe(
      'https://s3.example.test/uploads/demo/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4?put=1',
    );
    expect(draft.instruction.headers['content-type']).toBe('video/mp4');
    const expiresAt = Date.parse(draft.instruction.expiresAt);
    expect(expiresAt - now).toBeGreaterThanOrEqual(9 * 60 * 1000);
    expect(expiresAt - now).toBeLessThanOrEqual(10 * 60 * 1000 + 1000);
    expect(client.signPutCalls).toEqual([
      {
        key: 'uploads/demo/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4',
        mimeType: 'video/mp4',
        expiresIn: 600,
      },
    ]);
    expect(draft.state).toEqual({
      ref: 'uploads/demo/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4',
      bytes: FIXTURE_BYTES,
      mimeType: 'video/mp4',
    });
    expect(JSON.stringify(draft)).not.toContain('super-secret-value');
  });
});

describe('S3VideoAssetProvider.inspectUpload', () => {
  test('accepts exact bytes and normalized video/mp4 content-type', async () => {
    const key = 'uploads/demo/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4';
    client.heads.set(key, { bytes: FIXTURE_BYTES, mimeType: 'video/mp4; charset=binary' });
    const state = { ref: key, bytes: FIXTURE_BYTES, mimeType: 'video/mp4' as const };

    await expect(provider.inspectUpload(state, context)).resolves.toEqual({
      ref: key,
      bytes: FIXTURE_BYTES,
      mimeType: 'video/mp4',
    });
  });

  test('rejects size mismatch and best-effort deletes the polluted object', async () => {
    const key = 'uploads/demo/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4';
    client.heads.set(key, { bytes: FIXTURE_BYTES + 1, mimeType: 'video/mp4' });
    const state = { ref: key, bytes: FIXTURE_BYTES, mimeType: 'video/mp4' as const };

    await expectKinoError(provider.inspectUpload(state, context), 400, 'invalid_upload_size');
    expect(client.deleted).toEqual([key]);
  });

  test('rejects mime mismatch and best-effort deletes the polluted object', async () => {
    const key = 'uploads/demo/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4';
    client.heads.set(key, { bytes: FIXTURE_BYTES, mimeType: 'video/webm' });
    const state = { ref: key, bytes: FIXTURE_BYTES, mimeType: 'video/mp4' as const };

    await expectKinoError(provider.inspectUpload(state, context), 400, 'invalid_media_type');
    expect(client.deleted).toEqual([key]);
  });
});

describe('S3VideoAssetProvider.finalizeResource', () => {
  test('returns the scoped object key without using resourceId', async () => {
    const key = 'uploads/demo/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4';
    const mapping = await provider.finalizeResource(
      { ref: key, bytes: FIXTURE_BYTES, mimeType: 'video/mp4' },
      { resourceId: 'stable-logical-id', name: 'clip.mp4' },
      context,
    );

    expect(mapping).toEqual({ kind: 's3', ref: key });
    expect(mapping.ref).not.toContain('stable-logical-id');
  });

  test('rejects cross-game refs', async () => {
    await expectKinoError(
      provider.finalizeResource(
        {
          ref: 'uploads/other-game/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4',
          bytes: FIXTURE_BYTES,
          mimeType: 'video/mp4',
        },
        { resourceId: 'stable-logical-id', name: 'clip.mp4' },
        context,
      ),
      400,
      'invalid_provider_ref',
    );
  });
});

describe('S3VideoAssetProvider.getPlayback', () => {
  test('returns a five-minute presigned GET redirect URL', async () => {
    const key = 'uploads/demo/cccccccc-cccc-4ccc-8ccc-cccccccccccc.mp4';
    const playback = await provider.getPlayback(
      {
        id: 'res-playback',
        kind: 'video',
        name: 'clip.mp4',
        status: 'ready',
        mimeType: 'video/mp4',
        bytes: FIXTURE_BYTES,
        createdAt: 1,
        updatedAt: 2,
        provider: { kind: 's3', ref: key },
      },
      context,
    );

    expect(playback).toEqual({
      kind: 'redirect',
      url: 'https://s3.example.test/uploads/demo/cccccccc-cccc-4ccc-8ccc-cccccccccccc.mp4?get=1',
    });
    expect(client.signGetCalls).toEqual([{ key, expiresIn: 300 }]);
  });

  test('rejects unsafe provider refs', async () => {
    await expectKinoError(
      provider.getPlayback(
        {
          id: 'evil',
          kind: 'video',
          name: 'clip.mp4',
          status: 'ready',
          mimeType: 'video/mp4',
          bytes: 1,
          createdAt: 1,
          updatedAt: 2,
          provider: { kind: 's3', ref: '../escape.mp4' },
        },
        context,
      ),
      400,
      'invalid_provider_ref',
    );
  });
});

describe('S3VideoAssetProvider.delete', () => {
  test('deletes only the mapped object key', async () => {
    const key = 'uploads/demo/dddddddd-dddd-4ddd-8ddd-dddddddddddd.mp4';
    await provider.delete(
      {
        id: 'res-delete',
        kind: 'video',
        name: 'clip.mp4',
        status: 'ready',
        mimeType: 'video/mp4',
        bytes: FIXTURE_BYTES,
        createdAt: 1,
        updatedAt: 2,
        provider: { kind: 's3', ref: key },
      },
      context,
    );

    expect(client.deleted).toEqual([key]);
  });
});

describe('createDefaultS3ObjectClient', () => {
  test('enables path-style addressing only for a configured endpoint', () => {
    const defaultClientConfig = buildS3ClientConfig(CONFIG);
    expect(defaultClientConfig.endpoint).toBeUndefined();
    expect(defaultClientConfig.forcePathStyle ?? false).toBe(false);

    const endpoint = 'https://s3.example.test';
    const endpointClientConfig = buildS3ClientConfig({
      ...CONFIG,
      endpoint,
    });
    expect(endpointClientConfig.endpoint).toBe(endpoint);
    expect(endpointClientConfig.forcePathStyle).toBe(true);
  });

  test('includes content-type in the real presigned PUT signed headers', async () => {
    const realClient = createDefaultS3ObjectClient({
      ...CONFIG,
      endpoint: 'https://s3.example.test',
    });

    const signedUrl = await realClient.signPut(
      'uploads/demo/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4',
      'video/mp4',
      600,
    );
    const parsed = new URL(signedUrl);
    const signedHeaders = parsed.searchParams.get('X-Amz-SignedHeaders')?.split(';');

    expect(signedHeaders).toContain('content-type');
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(signedUrl).not.toContain('super-secret-value');
  });
});
