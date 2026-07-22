import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import type {
  PlaybackSource,
  VideoAssetRequestContext,
} from '../../src/video-assets/contracts';
import type {
  BatchCreateKinoResourcesResult,
  KinoEnvelope,
  KinoResourceDTO,
  KinoResourcePage,
} from '../../src/video-assets/kino-api';
import { KinoApiError } from '../../src/video-assets/kino-api';
import { createVideoAssetRouter } from '../../src/video-assets/router';
import {
  createVideoAssetRuntime,
  ProjectUploadSessionRepository,
} from '../../src/video-assets/index';
import type { PrepareUploadResponse, VideoAssetService } from '../../src/video-assets/service';
import type { UploadSession } from '../../src/video-assets/upload-sessions';
import manifestV1Fixture from './fixtures/manifest-v1.json';

const FIXTURE = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);

function identityFromAuth(value: string): string {
  return createHash('sha256').update(`authorization:${value}`, 'utf8').digest('hex');
}

function identityFromCookie(value: string): string {
  return createHash('sha256').update(`cookie:${value}`, 'utf8').digest('hex');
}

async function json<T>(
  app: Hono,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: KinoEnvelope<T> }> {
  const response = await app.request(path, init);
  const body = (await response.json()) as KinoEnvelope<T>;
  return { status: response.status, body };
}

function mountRouter(router: Hono): Hono {
  const app = new Hono();
  app.route('/api/v1/kino', router);
  return app;
}

let projectRoot: string;
let gameId: string;
let assetsDir: string;
let app: Hono;

function makeGame(slug = 'demo'): void {
  gameId = slug;
  assetsDir = resolve(projectRoot, '.forgeax/games', slug, 'game-video', 'assets');
  mkdirSync(assetsDir, { recursive: true });
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'video-router-'));
  makeGame();
  const runtime = createVideoAssetRuntime({ getProjectRoot: () => projectRoot });
  app = mountRouter(runtime.router);
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('createVideoAssetRouter list', () => {
  test('returns empty list in Kino envelope', async () => {
    const result = await json<KinoResourcePage>(
      app,
      `/api/v1/kino/resources?game_id=${gameId}&page=1&page_size=20`,
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      code: 0,
      message: 'ok',
      data: { items: [], total: 0, page: 1, page_size: 20 },
    });
  });

  test('rejects missing game_id', async () => {
    const result = await json<null>(app, '/api/v1/kino/resources?page=1&page_size=20');

    expect(result.status).toBe(400);
    expect(result.body.code).toBe(400);
    expect(result.body.data).toBeNull();
    expect(result.body.error_code).toBeDefined();
  });

  test('rejects image media_type', async () => {
    const result = await json<null>(
      app,
      `/api/v1/kino/resources?game_id=${gameId}&media_type=image&page=1&page_size=20`,
    );

    expect(result.status).toBe(400);
    expect(result.body.error_code).toBe('invalid_media_type');
    expect(result.body.message).toBe('Invalid media type');
  });

  test('rejects invalid page values strictly', async () => {
    const result = await json<null>(
      app,
      `/api/v1/kino/resources?game_id=${gameId}&page=0&page_size=20`,
    );

    expect(result.status).toBe(400);
    expect(result.body.error_code).toBe('invalid_page');
  });

  test('lists resources from a legacy v1 manifest without upgrading on disk', async () => {
    writeFileSync(
      resolve(assetsDir, 'manifest.json'),
      `${JSON.stringify(manifestV1Fixture, null, 2)}\n`,
      'utf-8',
    );

    const result = await json<KinoResourcePage>(
      app,
      `/api/v1/kino/resources?game_id=${gameId}&page=1&page_size=20`,
    );

    expect(result.status).toBe(200);
    expect(result.body.code).toBe(0);
    expect(result.body.data.total).toBe(2);
    expect(result.body.data.items.map((item) => item.resource_id).sort()).toEqual([
      'm-narr-door',
      'm-narr-open',
    ]);
    expect(JSON.parse(readFileSync(resolve(assetsDir, 'manifest.json'), 'utf-8')).version).toBe(1);
  });
});

describe('createVideoAssetRouter prepare upload', () => {
  test('rejects image mime_type on prepare', async () => {
    const result = await json<null>(app, '/api/v1/kino/image-assets/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        game_id: gameId,
        file_name: 'clip.png',
        mime_type: 'image/png',
        bytes: FIXTURE.byteLength,
      }),
    });

    expect(result.status).toBe(400);
    expect(result.body.error_code).toBe('invalid_media_type');
  });

  test('does not trust Content-Type over declared mime_type', async () => {
    const result = await json<null>(app, '/api/v1/kino/image-assets/upload', {
      method: 'POST',
      headers: { 'content-type': 'video/mp4' },
      body: JSON.stringify({
        game_id: gameId,
        file_name: 'clip.png',
        mime_type: 'image/png',
        bytes: FIXTURE.byteLength,
      }),
    });

    expect(result.status).toBe(400);
    expect(result.body.error_code).toBe('invalid_media_type');
  });

  test('rejects fractional upload bytes', async () => {
    const result = await json<null>(app, '/api/v1/kino/image-assets/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        game_id: gameId,
        file_name: 'clip.mp4',
        mime_type: 'video/mp4',
        bytes: 1.5,
      }),
    });

    expect(result.status).toBe(400);
    expect(result.body.error_code).toBe('invalid_upload_size');
  });

  test('accepts migration-only client_resource_id on prepare upload', async () => {
    const result = await json<PrepareUploadResponse>(app, '/api/v1/kino/image-assets/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        game_id: gameId,
        file_name: 'clip.mp4',
        mime_type: 'video/mp4',
        bytes: FIXTURE.byteLength,
        client_resource_id: 'm-narr-open',
      }),
    });

    expect(result.status).toBe(200);
    expect(result.body.code).toBe(0);
  });

  test('maps snake_case replace_existing and validates it strictly', async () => {
    const missing = await json<null>(app, '/api/v1/kino/image-assets/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        game_id: gameId,
        file_name: 'clip.mp4',
        mime_type: 'video/mp4',
        bytes: FIXTURE.byteLength,
        client_resource_id: 'm-narr-open',
        replace_existing: true,
      }),
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error_code).toBe('replace_target_not_found');

    const invalid = await json<null>(app, '/api/v1/kino/image-assets/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        game_id: gameId,
        file_name: 'clip.mp4',
        mime_type: 'video/mp4',
        bytes: FIXTURE.byteLength,
        client_resource_id: 'm-narr-open',
        replace_existing: 'true',
      }),
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error_code).toBe('invalid_replace_existing');
  });
});

describe('createVideoAssetRouter local flow', () => {
  test('prepare → PUT → create → get → update → range/HEAD → delete', async () => {
    const auth = 'Bearer test-token';
    const identity = identityFromAuth(auth);

    const prepared = await json<PrepareUploadResponse>(
      app,
      '/api/v1/kino/image-assets/upload',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: auth,
        },
        body: JSON.stringify({
          game_id: gameId,
          file_name: 'clip.mp4',
          mime_type: 'video/mp4',
          bytes: FIXTURE.byteLength,
        }),
      },
    );

    expect(prepared.status).toBe(200);
    expect(prepared.body.code).toBe(0);
    expect(prepared.body.data.upload.method).toBe('PUT');
    expect(prepared.body.data.upload.url).toContain(`game_id=${encodeURIComponent(gameId)}`);

    const putUrl = new URL(prepared.body.data.upload.url, 'http://127.0.0.1:18900');
    const put = await app.request(putUrl.pathname + putUrl.search, {
      method: 'PUT',
      headers: {
        authorization: auth,
        'content-type': 'video/mp4',
      },
      body: FIXTURE,
    });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as KinoEnvelope<null>;
    expect(putBody.code).toBe(0);
    expect(putBody.data).toBeNull();

    const created = await json<KinoResourceDTO>(app, '/api/v1/kino/resources', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: auth,
      },
      body: JSON.stringify({
        game_id: gameId,
        media_type: 'video',
        url: prepared.body.data.object_url,
        name: 'clip.mp4',
      }),
    });
    expect(created.status).toBe(200);
    const resourceId = created.body.data.resource_id;

    const fetched = await json<KinoResourceDTO>(
      app,
      `/api/v1/kino/resources/${resourceId}?game_id=${gameId}`,
      { headers: { authorization: auth } },
    );
    expect(fetched.status).toBe(200);
    expect(fetched.body.data.resource_id).toBe(resourceId);

    const updated = await json<KinoResourceDTO>(
      app,
      `/api/v1/kino/resources/${resourceId}?game_id=${gameId}`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          authorization: auth,
        },
        body: JSON.stringify({
          game_id: gameId,
          resource_id: resourceId,
          media_type: 'video',
          url: fetched.body.data.url,
          name: 'renamed.mp4',
        }),
      },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.data.name).toBe('renamed.mp4');

    const range = await app.request(
      `/api/v1/kino/resources/${resourceId}/content?game_id=${gameId}`,
      { headers: { range: 'bytes=2-4', authorization: auth } },
    );
    expect(range.status).toBe(206);
    expect(range.headers.get('accept-ranges')).toBe('bytes');
    expect(range.headers.get('content-range')).toBe(`bytes 2-4/${FIXTURE.byteLength}`);
    expect(range.headers.get('content-length')).toBe('3');
    expect(new Uint8Array(await range.arrayBuffer())).toEqual(FIXTURE.slice(2, 5));

    const head = await app.request(
      `/api/v1/kino/resources/${resourceId}/content?game_id=${gameId}`,
      { method: 'HEAD', headers: { authorization: auth } },
    );
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe('video/mp4');
    expect(await head.text()).toBe('');

    const deleted = await json<null>(
      app,
      `/api/v1/kino/resources/${resourceId}?game_id=${gameId}`,
      { method: 'DELETE', headers: { authorization: auth } },
    );
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ code: 0, message: 'ok', data: null });
  });
});

describe('createVideoAssetRouter identity and errors', () => {
  test('rejects cross-game PUT and identity mismatch', async () => {
    const firstAuth = 'Bearer owner';
    const prepared = await json<PrepareUploadResponse>(
      app,
      '/api/v1/kino/image-assets/upload',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: firstAuth },
        body: JSON.stringify({
          game_id: gameId,
          file_name: 'clip.mp4',
          mime_type: 'video/mp4',
          bytes: FIXTURE.byteLength,
        }),
      },
    );
    const putUrl = new URL(prepared.body.data.upload.url);

    const identityMismatch = await json<null>(
      app,
      putUrl.pathname + putUrl.search,
      {
        method: 'PUT',
        headers: { authorization: 'Bearer another-user' },
        body: FIXTURE,
      },
    );
    expect(identityMismatch.status).toBe(403);
    expect(identityMismatch.body.error_code).toBe(
      'upload_session_identity_mismatch',
    );

    makeGame('other-game');
    const crossGame = await json<null>(
      app,
      `${putUrl.pathname}?game_id=other-game`,
      {
        method: 'PUT',
        headers: { authorization: firstAuth },
        body: FIXTURE,
      },
    );
    expect(crossGame.status).toBe(404);
    expect(crossGame.body.error_code).toBe('upload_session_not_found');
  });

  test('passes authorization identity to service context', async () => {
    const calls: VideoAssetRequestContext[] = [];
    const fakeService = {
      listResources: async (_query: unknown, context: VideoAssetRequestContext) => {
        calls.push(context);
        return { items: [], total: 0, page: 1, page_size: 20 };
      },
    } as unknown as VideoAssetService;

    const router = createVideoAssetRouter(fakeService);
    const localApp = mountRouter(router);
    const auth = 'Bearer secret';

    await json(
      localApp,
      `/api/v1/kino/resources?game_id=${gameId}&page=1&page_size=20`,
      { headers: { authorization: auth, cookie: 'ignored=1' } },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.identity).toBe(identityFromAuth(auth));
    expect(calls[0]?.authorization).toBe(auth);
    expect(calls[0]?.cookie).toBe('ignored=1');
    expect(calls[0]?.gameId).toBe(gameId);
  });

  test('uses cookie identity when authorization is absent', async () => {
    const calls: VideoAssetRequestContext[] = [];
    const fakeService = {
      listResources: async (_query: unknown, context: VideoAssetRequestContext) => {
        calls.push(context);
        return { items: [], total: 0, page: 1, page_size: 20 };
      },
    } as unknown as VideoAssetService;

    const router = createVideoAssetRouter(fakeService);
    const localApp = mountRouter(router);

    await json(localApp, `/api/v1/kino/resources?game_id=${gameId}`, {
      headers: { cookie: 'sid=abc' },
    });

    expect(calls[0]?.identity).toBe(identityFromCookie('sid=abc'));
  });

  test('preserves business error_code in envelope', async () => {
    const fakeService = {
      listResources: async () => {
        throw new KinoApiError('Upload session game mismatch', 400, 'upload_session_game_mismatch');
      },
    } as unknown as VideoAssetService;

    const router = createVideoAssetRouter(fakeService);
    const localApp = mountRouter(router);
    const result = await json<null>(localApp, `/api/v1/kino/resources?game_id=${gameId}`);

    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      code: 400,
      message: 'Upload session game mismatch',
      data: null,
      error_code: 'upload_session_game_mismatch',
    });
  });

  test('preserves a strictly branded provider error without importing its class', async () => {
    class VideoAssetProviderError extends Error {
      readonly name = 'VideoAssetProviderError';

      constructor(
        message: string,
        readonly status: number,
        readonly errorCode?: string,
      ) {
        super(message);
      }
    }

    const fakeService = {
      listResources: async () => {
        throw new VideoAssetProviderError('Kino upstream rejected upload', 409, 'kino_conflict');
      },
    } as unknown as VideoAssetService;

    const localApp = mountRouter(createVideoAssetRouter(fakeService));
    const result = await json<null>(localApp, `/api/v1/kino/resources?game_id=${gameId}`);

    expect(result.status).toBe(409);
    expect(result.body).toEqual({
      code: 409,
      message: 'Kino upstream rejected upload',
      data: null,
      error_code: 'kino_conflict',
    });
  });

  test('truncates trusted provider error messages before returning them', async () => {
    const longMessage = 'x'.repeat(2_000);
    const error = Object.assign(new Error(longMessage), {
      name: 'VideoAssetProviderError',
      status: 502,
      errorCode: 'upstream_unavailable',
    });
    const fakeService = {
      listResources: async () => {
        throw error;
      },
    } as unknown as VideoAssetService;

    const localApp = mountRouter(createVideoAssetRouter(fakeService));
    const result = await json<null>(localApp, `/api/v1/kino/resources?game_id=${gameId}`);

    expect(result.status).toBe(502);
    expect(result.body.message).toBe(longMessage.slice(0, 512));
    expect(result.body.message).toHaveLength(512);
    expect(result.body.error_code).toBe('upstream_unavailable');
  });

  for (const [label, error] of [
    [
      'plain object',
      {
        name: 'VideoAssetProviderError',
        message: 'forged',
        status: 400,
        errorCode: 'forged_error',
      },
    ],
    [
      'unsafe status',
      Object.assign(new Error('bad status'), {
        name: 'VideoAssetProviderError',
        status: 399,
        errorCode: 'bad_status',
      }),
    ],
    [
      'non-integer status',
      Object.assign(new Error('bad status'), {
        name: 'VideoAssetProviderError',
        status: 400.5,
        errorCode: 'bad_status',
      }),
    ],
    [
      'unsafe error code',
      Object.assign(new Error('bad code'), {
        name: 'VideoAssetProviderError',
        status: 400,
        errorCode: 'bad code!',
      }),
    ],
    [
      'oversized error code',
      Object.assign(new Error('bad code'), {
        name: 'VideoAssetProviderError',
        status: 400,
        errorCode: 'a'.repeat(129),
      }),
    ],
  ] as const) {
    test(`does not trust malformed provider error: ${label}`, async () => {
      const fakeService = {
        listResources: async () => {
          throw error;
        },
      } as unknown as VideoAssetService;

      const localApp = mountRouter(createVideoAssetRouter(fakeService));
      const result = await json<null>(localApp, `/api/v1/kino/resources?game_id=${gameId}`);

      expect(result.status).toBe(500);
      expect(result.body).toEqual({
        code: 500,
        message: 'Internal server error',
        data: null,
      });
    });
  }

  test('sanitizes unknown errors without leaking stack or path', async () => {
    const fakeService = {
      listResources: async () => {
        const error = new Error(`failed at ${projectRoot}/secret`);
        error.stack = `Error: failed at ${projectRoot}/secret\n    at ${projectRoot}/router.ts:1:1`;
        throw error;
      },
    } as unknown as VideoAssetService;

    const router = createVideoAssetRouter(fakeService);
    const localApp = mountRouter(router);
    const result = await json<null>(localApp, `/api/v1/kino/resources?game_id=${gameId}`);
    const serialized = JSON.stringify(result.body);

    expect(result.status).toBe(500);
    expect(result.body.code).toBe(500);
    expect(result.body.data).toBeNull();
    expect(serialized).not.toContain(projectRoot);
    expect(serialized).not.toContain('router.ts');
  });

  test('returns a typed 500 envelope for zero-byte Local content', async () => {
    const fakeService = {
      playResource: async (): Promise<PlaybackSource> => ({
        kind: 'local',
        filePath: '/must/not/be/opened.mp4',
        mimeType: 'video/mp4',
        bytes: 0,
      }),
    } as unknown as VideoAssetService;
    const localApp = mountRouter(createVideoAssetRouter(fakeService));
    const path = `/api/v1/kino/resources/res-1/content?game_id=${gameId}`;

    const response = await localApp.request(path);
    const body = (await response.json()) as KinoEnvelope<null>;
    expect(response.status).toBe(500);
    expect(body).toEqual({
      code: 500,
      message: 'Invalid video asset size',
      data: null,
      error_code: 'invalid_video_asset_size',
    });

    const head = await localApp.request(path, { method: 'HEAD' });
    expect(head.status).toBe(500);
    expect(await head.text()).toBe('');
  });

  test('rejects invalid JSON bodies with 400 envelope', async () => {
    const result = await json<null>(app, '/api/v1/kino/resources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });

    expect(result.status).toBe(400);
    expect(result.body.error_code).toBe('invalid_json');
  });

  test('passes the original upload stream to the service without pre-reading or buffering', async () => {
    let pulls = 0;
    let receivedBody: ReadableStream<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(FIXTURE);
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const fakeService = {
      receiveUpload: async (
        _token: string,
        body: ReadableStream<Uint8Array>,
      ) => {
        receivedBody = body;
      },
    } as unknown as VideoAssetService;
    const localApp = mountRouter(createVideoAssetRouter(fakeService));
    const request = new Request(
      `http://localhost/api/v1/kino/uploads/token?game_id=${gameId}`,
      {
        method: 'PUT',
        body: stream,
        duplex: 'half',
      },
    );
    const rawBody = request.body!;
    const pullsBeforeFetch = pulls;

    const response = await localApp.fetch(request);

    expect(response.status).toBe(200);
    expect(receivedBody).toBe(rawBody);
    expect(pulls).toBe(pullsBeforeFetch);
  });

  test('rejects a missing upload body without calling the service', async () => {
    let calls = 0;
    const fakeService = {
      receiveUpload: async () => {
        calls += 1;
      },
    } as unknown as VideoAssetService;
    const localApp = mountRouter(createVideoAssetRouter(fakeService));

    const response = await localApp.request(
      `/api/v1/kino/uploads/token?game_id=${gameId}`,
      { method: 'PUT' },
    );
    const body = (await response.json()) as KinoEnvelope<null>;

    expect(response.status).toBe(400);
    expect(body.error_code).toBe('invalid_upload_body');
    expect(calls).toBe(0);
  });

  test('rejects explicit Content-Length zero without reading the upload stream', async () => {
    let pulls = 0;
    let calls = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(FIXTURE);
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const fakeService = {
      receiveUpload: async () => {
        calls += 1;
      },
    } as unknown as VideoAssetService;
    const localApp = mountRouter(createVideoAssetRouter(fakeService));
    const request = new Request(
      `http://localhost/api/v1/kino/uploads/token?game_id=${gameId}`,
      {
        method: 'PUT',
        headers: { 'content-length': '0' },
        body: stream,
        duplex: 'half',
      },
    );
    const pullsBeforeFetch = pulls;

    const response = await localApp.fetch(request);
    const body = (await response.json()) as KinoEnvelope<null>;

    expect(response.status).toBe(400);
    expect(body.error_code).toBe('invalid_upload_body');
    expect(calls).toBe(0);
    expect(pulls).toBe(pullsBeforeFetch);
  });

  test('does not buffer a large upload without Content-Length', async () => {
    let pulls = 0;
    let receivedBody: ReadableStream<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(1024 * 1024));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const fakeService = {
      receiveUpload: async (
        _token: string,
        body: ReadableStream<Uint8Array>,
      ) => {
        receivedBody = body;
      },
    } as unknown as VideoAssetService;
    const localApp = mountRouter(createVideoAssetRouter(fakeService));
    const request = new Request(
      `http://localhost/api/v1/kino/uploads/token?game_id=${gameId}`,
      {
        method: 'PUT',
        body: stream,
        duplex: 'half',
      },
    );
    const pullsBeforeFetch = pulls;

    const response = await localApp.fetch(request);

    expect(response.status).toBe(200);
    expect(receivedBody).toBe(request.body!);
    expect(pulls).toBe(pullsBeforeFetch);
  });

  test('returns 416 for invalid and multi-range requests', async () => {
    const auth = 'Bearer range-test';
    const prepared = await json<PrepareUploadResponse>(
      app,
      '/api/v1/kino/image-assets/upload',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: auth },
        body: JSON.stringify({
          game_id: gameId,
          file_name: 'clip.mp4',
          mime_type: 'video/mp4',
          bytes: FIXTURE.byteLength,
        }),
      },
    );
    const putUrl = new URL(prepared.body.data.upload.url, 'http://127.0.0.1:18900');
    await app.request(putUrl.pathname + putUrl.search, {
      method: 'PUT',
      headers: { authorization: auth, 'content-type': 'video/mp4' },
      body: FIXTURE,
    });
    const created = await json<KinoResourceDTO>(app, '/api/v1/kino/resources', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify({
        game_id: gameId,
        media_type: 'video',
        url: prepared.body.data.object_url,
      }),
    });
    const resourceId = created.body.data.resource_id;
    const contentPath = `/api/v1/kino/resources/${resourceId}/content?game_id=${gameId}`;

    const invalid = await app.request(contentPath, {
      headers: { range: 'bytes=999-1000', authorization: auth },
    });
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get('content-range')).toBe(`bytes */${FIXTURE.byteLength}`);

    const multi = await app.request(contentPath, {
      headers: { range: 'bytes=0-1,2-3', authorization: auth },
    });
    expect(multi.status).toBe(416);
    expect(multi.headers.get('content-range')).toBe(`bytes */${FIXTURE.byteLength}`);

    const openEnded = await app.request(contentPath, {
      headers: { range: 'bytes=2-', authorization: auth },
    });
    expect(openEnded.status).toBe(206);
    expect(openEnded.headers.get('content-range')).toBe(
      `bytes 2-5/${FIXTURE.byteLength}`,
    );
    expect(new Uint8Array(await openEnded.arrayBuffer())).toEqual(FIXTURE.slice(2));

    const suffix = await app.request(contentPath, {
      headers: { range: 'bytes=-3', authorization: auth },
    });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get('content-range')).toBe(
      `bytes 3-5/${FIXTURE.byteLength}`,
    );
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(FIXTURE.slice(-3));

    const oversizedSuffix = await app.request(contentPath, {
      headers: { range: 'bytes=-999', authorization: auth },
    });
    expect(oversizedSuffix.status).toBe(206);
    expect(oversizedSuffix.headers.get('content-range')).toBe(
      `bytes 0-5/${FIXTURE.byteLength}`,
    );
    expect(oversizedSuffix.headers.get('content-length')).toBe(
      String(FIXTURE.byteLength),
    );
    expect(new Uint8Array(await oversizedSuffix.arrayBuffer())).toEqual(FIXTURE);
  });
});

describe('createVideoAssetRouter redirect playback', () => {
  test('returns 302 with no-store for redirect providers', async () => {
    const fakeService = {
      playResource: async (): Promise<PlaybackSource> => ({
        kind: 'redirect',
        url: 'https://cdn.example/video.mp4?sig=1',
      }),
    } as unknown as VideoAssetService;

    const router = createVideoAssetRouter(fakeService);
    const localApp = mountRouter(router);
    const response = await localApp.request(
      `/api/v1/kino/resources/res-1/content?game_id=${gameId}`,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://cdn.example/video.mp4?sig=1');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('createVideoAssetRouter route order', () => {
  test('registers batch before item routes', async () => {
    const calls: string[] = [];
    const fakeService = {
      batchCreateResources: async () => {
        calls.push('batch');
        return { created_count: 0, skipped_count: 0, items: [] } satisfies BatchCreateKinoResourcesResult;
      },
      getResource: async () => {
        calls.push('get');
        throw new Error('should not hit get');
      },
    } as unknown as VideoAssetService;

    const router = createVideoAssetRouter(fakeService);
    const localApp = mountRouter(router);

    await json(localApp, '/api/v1/kino/resources/batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ game_id: gameId, resources: [] }),
    });

    expect(calls).toEqual(['batch']);
  });
});

describe('ProjectUploadSessionRepository concurrency', () => {
  test('serializes conflicting reserve calls for the same token', async () => {
    const repository = new ProjectUploadSessionRepository(() => projectRoot);
    const token = '11111111-1111-4111-8111-111111111111';
    const session: UploadSession = {
      token,
      gameId,
      identity: 'anonymous',
      fileName: 'clip.mp4',
      mimeType: 'video/mp4',
      bytes: FIXTURE.byteLength,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      providerKind: 'local',
      providerState: {
        ref: `.uploads/${token}.part`,
        bytes: FIXTURE.byteLength,
        mimeType: 'video/mp4',
      },
    };
    await repository.write(session);

    const results = await Promise.allSettled([
      repository.reserve(token, 'resource-a', gameId),
      repository.reserve(token, 'resource-b', gameId),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const stored = await repository.read(token, gameId);
    expect(stored).not.toBeNull();
    expect(['resource-a', 'resource-b']).toContain(stored!.resourceId!);
  });
});
