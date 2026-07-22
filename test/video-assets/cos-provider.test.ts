import { beforeEach, describe, expect, test } from 'bun:test';
import COS from 'cos-nodejs-sdk-v5';
import type { VideoAssetRequestContext } from '../../src/video-assets/contracts';
import { KinoApiError } from '../../src/video-assets/kino-api';
import type { CosObjectClient } from '../../src/video-assets/providers/cos';
import {
  buildCosSdkClientOptions,
  createDefaultCosObjectClient,
  createCosVideoAssetProvider,
} from '../../src/video-assets/providers/cos';
import type { CosVideoStorageConfig } from '../../src/video-assets/config';

const FIXTURE_BYTES = 6;
const FIXED_UUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONFIG: CosVideoStorageConfig = {
  kind: 'cos',
  bucket: 'cos-bucket-1250000000',
  region: 'ap-guangzhou',
  secretId: 'AKIDEXAMPLE',
  secretKey: 'cos-secret-value',
  prefix: 'videos',
};

class FakeCosClient implements CosObjectClient {
  deleted: string[] = [];
  readonly heads = new Map<string, { bytes: number; mimeType?: string }>();

  signPutCalls: Array<{ key: string; mimeType: string; expiresIn: number }> = [];
  signGetCalls: Array<{ key: string; expiresIn: number }> = [];

  async signPut(key: string, mimeType: string, expiresIn: number): Promise<string> {
    this.signPutCalls.push({ key, mimeType, expiresIn });
    return `https://cos.example.test/${key}?put=1`;
  }

  async signGet(key: string, expiresIn: number): Promise<string> {
    this.signGetCalls.push({ key, expiresIn });
    return `https://cos.example.test/${key}?get=1`;
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

let client: FakeCosClient;
let provider: ReturnType<typeof createCosVideoAssetProvider>;
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
  client = new FakeCosClient();
  provider = createCosVideoAssetProvider(CONFIG, {
    client,
    randomUuid: () => FIXED_UUID,
  });
  context = {
    gameId: 'demo',
    identity: 'user-1',
    origin: 'http://127.0.0.1:18900',
  };
});

describe('CosVideoAssetProvider.prepareUpload', () => {
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
      'https://cos.example.test/videos/demo/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.mp4?put=1',
    );
    expect(draft.instruction.headers['content-type']).toBe('video/mp4');
    const expiresAt = Date.parse(draft.instruction.expiresAt);
    expect(expiresAt - now).toBeGreaterThanOrEqual(9 * 60 * 1000);
    expect(expiresAt - now).toBeLessThanOrEqual(10 * 60 * 1000 + 1000);
    expect(client.signPutCalls).toEqual([
      {
        key: 'videos/demo/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.mp4',
        mimeType: 'video/mp4',
        expiresIn: 600,
      },
    ]);
    expect(draft.state).toEqual({
      ref: 'videos/demo/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.mp4',
      bytes: FIXTURE_BYTES,
      mimeType: 'video/mp4',
    });
    expect(JSON.stringify(draft)).not.toContain('cos-secret-value');
  });
});

describe('CosVideoAssetProvider.inspectUpload', () => {
  test('accepts exact bytes and normalized video/mp4 content-type', async () => {
    const key = 'videos/demo/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.mp4';
    client.heads.set(key, { bytes: FIXTURE_BYTES, mimeType: 'video/mp4' });
    const state = { ref: key, bytes: FIXTURE_BYTES, mimeType: 'video/mp4' as const };

    await expect(provider.inspectUpload(state, context)).resolves.toEqual({
      ref: key,
      bytes: FIXTURE_BYTES,
      mimeType: 'video/mp4',
    });
  });

  test('rejects size mismatch and best-effort deletes the polluted object', async () => {
    const key = 'videos/demo/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.mp4';
    client.heads.set(key, { bytes: FIXTURE_BYTES + 1, mimeType: 'video/mp4' });
    const state = { ref: key, bytes: FIXTURE_BYTES, mimeType: 'video/mp4' as const };

    await expectKinoError(provider.inspectUpload(state, context), 400, 'invalid_upload_size');
    expect(client.deleted).toEqual([key]);
  });

  test('rejects mime mismatch and best-effort deletes the polluted object', async () => {
    const key = 'videos/demo/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.mp4';
    client.heads.set(key, { bytes: FIXTURE_BYTES, mimeType: 'application/octet-stream' });
    const state = { ref: key, bytes: FIXTURE_BYTES, mimeType: 'video/mp4' as const };

    await expectKinoError(provider.inspectUpload(state, context), 400, 'invalid_media_type');
    expect(client.deleted).toEqual([key]);
  });
});

describe('CosVideoAssetProvider.finalizeResource', () => {
  test('returns the scoped object key without using resourceId', async () => {
    const key = 'videos/demo/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.mp4';
    const mapping = await provider.finalizeResource(
      { ref: key, bytes: FIXTURE_BYTES, mimeType: 'video/mp4' },
      { resourceId: 'stable-logical-id', name: 'clip.mp4' },
      context,
    );

    expect(mapping).toEqual({ kind: 'cos', ref: key });
    expect(mapping.ref).not.toContain('stable-logical-id');
  });

  test('rejects cross-game refs', async () => {
    await expectKinoError(
      provider.finalizeResource(
        {
          ref: 'videos/other-game/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.mp4',
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

describe('CosVideoAssetProvider.getPlayback', () => {
  test('returns a five-minute presigned GET redirect URL', async () => {
    const key = 'videos/demo/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.mp4';
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
        provider: { kind: 'cos', ref: key },
      },
      context,
    );

    expect(playback).toEqual({
      kind: 'redirect',
      url: 'https://cos.example.test/videos/demo/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.mp4?get=1',
    });
    expect(client.signGetCalls).toEqual([{ key, expiresIn: 300 }]);
  });
});

describe('CosVideoAssetProvider.delete', () => {
  test('deletes only the mapped object key', async () => {
    const key = 'videos/demo/ffffffff-ffff-4fff-8fff-ffffffffffff.mp4';
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
        provider: { kind: 'cos', ref: key },
      },
      context,
    );

    expect(client.deleted).toEqual([key]);
  });
});

describe('createDefaultCosObjectClient', () => {
  test('uses the default public myqcloud host when endpoint is unset', async () => {
    const realClient = createDefaultCosObjectClient(CONFIG);
    const signedUrl = await realClient.signPut(
      'videos/demo/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.mp4',
      'video/mp4',
      600,
    );

    expect(new URL(signedUrl).hostname).toBe(
      'cos-bucket-1250000000.cos.ap-guangzhou.myqcloud.com',
    );
  });

  test('presigns against bucket-prefixed custom endpoint host via SDK Domain template', async () => {
    const customConfig: CosVideoStorageConfig = {
      ...CONFIG,
      bucket: 'media-bucket-1250000000',
      endpoint: 'storage.example.com',
    };
    const realClient = createDefaultCosObjectClient(customConfig);
    const key = 'videos/demo/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.mp4';

    const putUrl = await realClient.signPut(key, 'video/mp4', 600);
    expect(new URL(putUrl).hostname).toBe(
      'media-bucket-1250000000.storage.example.com',
    );

    const getUrl = await realClient.signGet(key, 300);
    expect(new URL(getUrl).hostname).toBe(
      'media-bucket-1250000000.storage.example.com',
    );
  });

  test('builds one COS client Domain template shared by sign, head, and delete', () => {
    const customConfig: CosVideoStorageConfig = {
      ...CONFIG,
      bucket: 'media-bucket-1250000000',
      endpoint: 'storage.example.com',
    };

    expect(buildCosSdkClientOptions(customConfig)).toEqual({
      SecretId: customConfig.secretId,
      SecretKey: customConfig.secretKey,
      Domain: '{Bucket}.storage.example.com',
    });
    expect(buildCosSdkClientOptions(CONFIG)).toEqual({
      SecretId: CONFIG.secretId,
      SecretKey: CONFIG.secretKey,
    });
  });

  test('constructs one COS client with production options and uses it for head and delete', async () => {
    const customConfig: CosVideoStorageConfig = {
      ...CONFIG,
      bucket: 'media-bucket-1250000000',
      endpoint: 'storage.example.com',
    };
    const factoryOptions: COS.COSOptions[] = [];
    const headCalls: COS.HeadObjectParams[] = [];
    const deleteCalls: COS.DeleteObjectParams[] = [];
    const cosInstance = {
      async headObject(params: COS.HeadObjectParams) {
        headCalls.push(params);
        return {
          headers: {
            'content-length': String(FIXTURE_BYTES),
            'content-type': 'video/mp4',
          },
        };
      },
      async deleteObject(params: COS.DeleteObjectParams) {
        deleteCalls.push(params);
        return {};
      },
    } as unknown as COS;
    const realClient = createDefaultCosObjectClient(customConfig, {
      cosFactory(options) {
        factoryOptions.push(options);
        return cosInstance;
      },
    });

    const key = 'videos/demo/x.mp4';
    await realClient.head(key);
    await realClient.delete(key);

    expect(factoryOptions).toEqual([buildCosSdkClientOptions(customConfig)]);
    expect(factoryOptions[0]?.Domain).toBe(
      '{Bucket}.storage.example.com',
    );
    expect(headCalls).toEqual([
      { Bucket: customConfig.bucket, Region: customConfig.region, Key: key },
    ]);
    expect(deleteCalls).toEqual([
      { Bucket: customConfig.bucket, Region: customConfig.region, Key: key },
    ]);
  });

  test('includes content-type in the real presigned PUT header list', async () => {
    const realClient = createDefaultCosObjectClient(CONFIG);

    const signedUrl = await realClient.signPut(
      'videos/demo/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.mp4',
      'video/mp4',
      600,
    );
    const parsed = new URL(signedUrl);
    const signedHeaders = parsed.searchParams.get('q-header-list')?.split(';');

    expect(signedHeaders).toContain('content-type');
    expect(signedUrl).not.toContain('cos-secret-value');
  });

  test('returns Content-Type in the upload instruction headers', async () => {
    const draft = await provider.prepareUpload(
      {
        uploadToken: 'unused-token',
        fileName: 'clip.mp4',
        mimeType: 'video/mp4',
        bytes: FIXTURE_BYTES,
      },
      context,
    );
    const contentType = Object.entries(draft.instruction.headers).find(
      ([name]) => name.toLowerCase() === 'content-type',
    )?.[1];

    expect(contentType).toBe('video/mp4');
  });
});
