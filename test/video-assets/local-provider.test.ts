import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import type { VideoAssetRequestContext } from '../../src/video-assets/contracts';
import { KinoApiError } from '../../src/video-assets/kino-api';
import { createLocalVideoAssetProvider } from '../../src/video-assets/providers/local';
import { MAX_VIDEO_UPLOAD_BYTES } from '../../src/video-assets/upload-sessions';

const FIXTURE = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);

class FakeUploadWriter extends EventEmitter {
  writes = 0;
  falseWrites = 0;
  destroyed = false;

  constructor(readonly outcome: 'drain' | 'error') {
    super();
  }

  write(): boolean {
    this.writes += 1;
    this.falseWrites += 1;
    queueMicrotask(() => {
      if (this.outcome === 'drain') {
        this.emit('drain');
      } else {
        this.emit('error', new Error('writer failed during drain'));
      }
    });
    return false;
  }

  end(): void {
    queueMicrotask(() => this.emit('finish'));
  }

  destroy(): void {
    this.destroyed = true;
  }
}

let projectRoot: string;
let gameId: string;
let assetsDir: string;
let provider: ReturnType<typeof createLocalVideoAssetProvider>;
let context: VideoAssetRequestContext;

function makeGame(slug = 'demo'): void {
  gameId = slug;
  assetsDir = resolve(projectRoot, '.forgeax/games', slug, 'game-video', 'assets');
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
  projectRoot = mkdtempSync(join(tmpdir(), 'local-provider-'));
  makeGame();
  provider = createLocalVideoAssetProvider(() => projectRoot);
  context = {
    gameId,
    identity: 'user-1',
    origin: 'http://127.0.0.1:18900',
  };
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('LocalVideoAssetProvider.prepareUpload', () => {
  test('returns same-origin PUT instruction with mp4 content-type and ten-minute expiry', async () => {
    const token = '11111111-1111-4111-8111-111111111111';
    const now = Date.now();
    const draft = await provider.prepareUpload(
      {
        uploadToken: token,
        fileName: 'clip.mp4',
        mimeType: 'video/mp4',
        bytes: FIXTURE.byteLength,
      },
      context,
    );

    expect(draft.instruction.method).toBe('PUT');
    expect(draft.instruction.url).toBe(
      `${context.origin}/api/v1/kino/uploads/${token}?game_id=${encodeURIComponent(context.gameId)}`,
    );
    expect(draft.instruction.headers['content-type']).toBe('video/mp4');
    const expiresAt = Date.parse(draft.instruction.expiresAt);
    expect(expiresAt - now).toBeGreaterThanOrEqual(9 * 60 * 1000);
    expect(expiresAt - now).toBeLessThanOrEqual(10 * 60 * 1000 + 1000);
    expect(draft.state).toEqual({
      ref: `.uploads/${token}.part`,
      bytes: FIXTURE.byteLength,
      mimeType: 'video/mp4',
    });
  });
});

describe('LocalVideoAssetProvider.receiveUpload', () => {
  test('streams exact bytes into the temp part file', async () => {
    const token = '22222222-2222-4222-8222-222222222222';
    const { state } = await provider.prepareUpload(
      {
        uploadToken: token,
        fileName: 'clip.mp4',
        mimeType: 'video/mp4',
        bytes: FIXTURE.byteLength,
      },
      context,
    );

    await provider.receiveUpload!(state, streamFrom(FIXTURE), context);

    const partPath = resolve(assetsDir, '.uploads', `${token}.part`);
    expect(readFileSync(partPath)).toEqual(Buffer.from(FIXTURE));
    expect(existsSync(resolve(assetsDir, 'blobs', `${token}.mp4`))).toBe(false);
  });

  test('waits for drain after writer.write returns false', async () => {
    const token = '23232323-2323-4232-8232-232323232323';
    const writer = new FakeUploadWriter('drain');
    const injected = createLocalVideoAssetProvider(() => projectRoot, {
      createWriter: () => writer,
    });
    const { state } = await injected.prepareUpload(
      {
        uploadToken: token,
        fileName: 'clip.mp4',
        mimeType: 'video/mp4',
        bytes: FIXTURE.byteLength,
      },
      context,
    );

    await injected.receiveUpload!(state, streamFrom(FIXTURE), context);

    expect(writer.writes).toBe(1);
    expect(writer.falseWrites).toBe(1);
    expect(writer.destroyed).toBe(false);
  });

  test(
    'cancels the reader, destroys the writer, and cleans the part on error during drain',
    async () => {
      const token = '24242424-2424-4242-8242-242424242424';
      const writer = new FakeUploadWriter('error');
      const injected = createLocalVideoAssetProvider(() => projectRoot, {
        createWriter: () => writer,
      });
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(FIXTURE);
        },
        cancel() {
          cancelled = true;
        },
      });
      const { state } = await injected.prepareUpload(
        {
          uploadToken: token,
          fileName: 'clip.mp4',
          mimeType: 'video/mp4',
          bytes: FIXTURE.byteLength,
        },
        context,
      );

      await expect(injected.receiveUpload!(state, body, context)).rejects.toThrow(
        'writer failed during drain',
      );

      expect(cancelled).toBe(true);
      expect(writer.destroyed).toBe(true);
      expect(existsSync(resolve(assetsDir, '.uploads', `${token}.part`))).toBe(false);
    },
    1_000,
  );

  test('rejects oversize streams and cleans up the temp file', async () => {
    const token = '33333333-3333-4333-8333-333333333333';
    const { state } = await provider.prepareUpload(
      {
        uploadToken: token,
        fileName: 'clip.mp4',
        mimeType: 'video/mp4',
        bytes: 2,
      },
      context,
    );

    await expectKinoError(
      provider.receiveUpload!(state, streamFrom(FIXTURE), context),
      400,
      'invalid_upload_size',
    );
    expect(existsSync(resolve(assetsDir, '.uploads', `${token}.part`))).toBe(false);
  });

  test('rejects streams above the global 100MB cap', async () => {
    const token = '44444444-4444-4444-8444-444444444444';
    const { state } = await provider.prepareUpload(
      {
        uploadToken: token,
        fileName: 'clip.mp4',
        mimeType: 'video/mp4',
        bytes: MAX_VIDEO_UPLOAD_BYTES,
      },
      context,
    );

    const oversized = new Uint8Array(MAX_VIDEO_UPLOAD_BYTES + 1);
    await expectKinoError(
      provider.receiveUpload!(state, streamFrom(oversized), context),
      400,
      'invalid_upload_size',
    );
    expect(existsSync(resolve(assetsDir, '.uploads', `${token}.part`))).toBe(false);
  });
});

describe('LocalVideoAssetProvider.inspectUpload', () => {
  test('reports ref, bytes, and mime after a successful upload', async () => {
    const token = '55555555-5555-4555-8555-555555555555';
    const { state } = await provider.prepareUpload(
      {
        uploadToken: token,
        fileName: 'clip.mp4',
        mimeType: 'video/mp4',
        bytes: FIXTURE.byteLength,
      },
      context,
    );
    await provider.receiveUpload!(state, streamFrom(FIXTURE), context);

    await expect(provider.inspectUpload(state, context)).resolves.toEqual({
      ref: `.uploads/${token}.part`,
      bytes: FIXTURE.byteLength,
      mimeType: 'video/mp4',
    });
  });
});

describe('LocalVideoAssetProvider.finalizeResource', () => {
  test('atomically moves the temp upload into blobs/<resourceId>.mp4', async () => {
    const token = '66666666-6666-4666-8666-666666666666';
    const resourceId = 'res-finalize';
    const { state } = await provider.prepareUpload(
      {
        uploadToken: token,
        fileName: 'clip.mp4',
        mimeType: 'video/mp4',
        bytes: FIXTURE.byteLength,
      },
      context,
    );
    await provider.receiveUpload!(state, streamFrom(FIXTURE), context);
    const uploaded = await provider.inspectUpload(state, context);

    const mapping = await provider.finalizeResource(
      uploaded,
      { resourceId, name: 'clip.mp4' },
      context,
    );

    expect(mapping).toEqual({ kind: 'local', ref: `blobs/${resourceId}.mp4` });
    expect(existsSync(resolve(assetsDir, '.uploads', `${token}.part`))).toBe(true);
    expect(readFileSync(resolve(assetsDir, 'blobs', `${resourceId}.mp4`))).toEqual(
      Buffer.from(FIXTURE),
    );

    await provider.cleanupUpload!(state, context);
    expect(existsSync(resolve(assetsDir, '.uploads', `${token}.part`))).toBe(false);
  });

  test('is idempotent when the destination blob already exists with the same size', async () => {
    const token = '77777777-7777-4777-8777-777777777777';
    const resourceId = 'res-retry';
    const blobPath = resolve(assetsDir, 'blobs', `${resourceId}.mp4`);
    mkdirSync(resolve(assetsDir, 'blobs'), { recursive: true });
    writeFileSync(blobPath, FIXTURE);

    const uploaded = {
      ref: `.uploads/${token}.part`,
      bytes: FIXTURE.byteLength,
      mimeType: 'video/mp4' as const,
    };

    await expect(
      provider.finalizeResource(uploaded, { resourceId, name: 'clip.mp4' }, context),
    ).resolves.toEqual({ kind: 'local', ref: `blobs/${resourceId}.mp4` });
  });

  test('rejects conflicting destination blobs', async () => {
    const token = '88888888-8888-4888-8888-888888888888';
    const resourceId = 'res-conflict';
    const blobPath = resolve(assetsDir, 'blobs', `${resourceId}.mp4`);
    mkdirSync(resolve(assetsDir, 'blobs'), { recursive: true });
    writeFileSync(blobPath, Buffer.from([0x99]));

    const uploaded = {
      ref: `.uploads/${token}.part`,
      bytes: FIXTURE.byteLength,
      mimeType: 'video/mp4' as const,
    };

    await expectKinoError(
      provider.finalizeResource(uploaded, { resourceId, name: 'clip.mp4' }, context),
      409,
      'provider_finalize_conflict',
    );
  });
});

describe('LocalVideoAssetProvider.cleanupUpload', () => {
  test('deletes only a strictly validated temp upload ref', async () => {
    const token = '67676767-6767-4676-8676-676767676767';
    const partPath = resolve(assetsDir, '.uploads', `${token}.part`);
    mkdirSync(resolve(assetsDir, '.uploads'), { recursive: true });
    writeFileSync(partPath, FIXTURE);

    await provider.cleanupUpload!(
      {
        ref: `.uploads/${token}.part`,
        bytes: FIXTURE.byteLength,
        mimeType: 'video/mp4',
      },
      context,
    );
    expect(existsSync(partPath)).toBe(false);

    await expectKinoError(
      provider.cleanupUpload!(
        {
          ref: 'blobs/keep.mp4',
          bytes: FIXTURE.byteLength,
          mimeType: 'video/mp4',
        },
        context,
      ),
      400,
      'invalid_upload_session',
    );
  });
});

describe('LocalVideoAssetProvider.getPlayback', () => {
  test('returns local metadata needed for Range playback', async () => {
    const resourceId = 'res-playback';
    const blobPath = resolve(assetsDir, 'blobs', `${resourceId}.mp4`);
    mkdirSync(resolve(assetsDir, 'blobs'), { recursive: true });
    writeFileSync(blobPath, FIXTURE);

    const playback = await provider.getPlayback(
      {
        id: resourceId,
        kind: 'video',
        name: 'clip.mp4',
        status: 'ready',
        mimeType: 'video/mp4',
        bytes: FIXTURE.byteLength,
        createdAt: 1,
        updatedAt: 2,
        provider: { kind: 'local', ref: `blobs/${resourceId}.mp4` },
      },
      context,
    );

    expect(playback).toEqual({
      kind: 'local',
      filePath: blobPath,
      mimeType: 'video/mp4',
      bytes: FIXTURE.byteLength,
    });

    const rangeSlice = readFileSync(blobPath).subarray(2, 5);
    expect(rangeSlice).toEqual(Buffer.from([0x02, 0x03, 0x04]));
  });
});

describe('LocalVideoAssetProvider.delete', () => {
  test('deletes only the mapped blob and treats missing files as idempotent', async () => {
    const resourceId = 'res-delete';
    const blobPath = resolve(assetsDir, 'blobs', `${resourceId}.mp4`);
    mkdirSync(resolve(assetsDir, 'blobs'), { recursive: true });
    writeFileSync(blobPath, FIXTURE);

    const asset = {
      id: resourceId,
      kind: 'video' as const,
      name: 'clip.mp4',
      status: 'ready' as const,
      mimeType: 'video/mp4' as const,
      bytes: FIXTURE.byteLength,
      createdAt: 1,
      updatedAt: 2,
      provider: { kind: 'local' as const, ref: `blobs/${resourceId}.mp4` },
    };

    await provider.delete(asset, context);
    expect(existsSync(blobPath)).toBe(false);

    await expect(provider.delete(asset, context)).resolves.toBeUndefined();
  });

  test('rejects unsafe provider refs', async () => {
    await expectKinoError(
      provider.delete(
        {
          id: 'evil',
          kind: 'video',
          name: 'clip.mp4',
          status: 'ready',
          mimeType: 'video/mp4',
          bytes: 1,
          createdAt: 1,
          updatedAt: 2,
          provider: { kind: 'local', ref: '../escape.mp4' },
        },
        context,
      ),
      400,
      'invalid_provider_ref',
    );
  });
});
