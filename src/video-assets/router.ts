import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { PlaybackSource, VideoAssetRequestContext } from './contracts';
import type {
  CreateKinoResourceInput,
  KinoEnvelope,
  UpdateKinoResourceInput,
} from './kino-api';
import { KinoApiError } from './kino-api';
import { isValidVideoAssetResourceId } from './resource-id';
import type { VideoAssetService } from './service';
import { MAX_VIDEO_UPLOAD_BYTES, VIDEO_UPLOAD_MIME } from './upload-sessions';

type RangeParseResult =
  | { kind: 'full' }
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'unsatisfiable' }
  | { kind: 'invalid' };

function kinoOk<T>(data: T): KinoEnvelope<T> {
  return { code: 0, message: 'ok', data };
}

function kinoError(status: number, message: string, errorCode?: string): KinoEnvelope<null> {
  return {
    code: status,
    message,
    data: null,
    ...(errorCode ? { error_code: errorCode } : {}),
  };
}

const PROVIDER_ERROR_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_PROVIDER_ERROR_MESSAGE_LENGTH = 512;

interface TrustedVideoAssetError {
  status: number;
  message: string;
  errorCode?: string;
}

function asTrustedVideoAssetError(error: unknown): TrustedVideoAssetError | undefined {
  if (error instanceof KinoApiError) {
    return error;
  }
  if (!(error instanceof Error) || error.name !== 'VideoAssetProviderError') {
    return undefined;
  }

  const candidate = error as Error & { status?: unknown; errorCode?: unknown };
  if (
    !Number.isSafeInteger(candidate.status) ||
    (candidate.status as number) < 400 ||
    (candidate.status as number) > 599
  ) {
    return undefined;
  }
  if (
    candidate.errorCode !== undefined &&
    (typeof candidate.errorCode !== 'string' ||
      !PROVIDER_ERROR_CODE_RE.test(candidate.errorCode))
  ) {
    return undefined;
  }

  return {
    status: candidate.status as number,
    message: candidate.message.slice(0, MAX_PROVIDER_ERROR_MESSAGE_LENGTH),
    ...(candidate.errorCode !== undefined ? { errorCode: candidate.errorCode } : {}),
  };
}

function respondWithTrustedError(c: Context, error: unknown): Promise<Response> {
  const trusted = asTrustedVideoAssetError(error);
  if (trusted) {
    return respondWithEnvelope(
      c,
      trusted.status,
      kinoError(trusted.status, trusted.message, trusted.errorCode),
    );
  }
  return respondWithEnvelope(c, 500, kinoError(500, 'Internal server error'));
}

function resolveIdentity(authorization: string | undefined, cookie: string | undefined): string {
  if (authorization) {
    return createHash('sha256').update(`authorization:${authorization}`, 'utf8').digest('hex');
  }
  if (cookie) {
    return createHash('sha256').update(`cookie:${cookie}`, 'utf8').digest('hex');
  }
  return 'anonymous';
}

function buildRequestContext(
  c: Context,
  gameId: string,
): VideoAssetRequestContext {
  const url = new URL(c.req.url);
  const authorization = c.req.header('authorization');
  const cookie = c.req.header('cookie');
  return {
    gameId,
    identity: resolveIdentity(authorization, cookie),
    authorization,
    cookie,
    origin: url.origin,
  };
}

function requireGameIdFromQuery(c: Context, paramName = 'game_id'): string {
  const gameId = c.req.query(paramName)?.trim();
  if (!gameId) {
    throw new KinoApiError('Missing game_id', 400, 'missing_game_id');
  }
  return gameId;
}

function requireGameIdFromBody(body: Record<string, unknown>): string {
  const gameId = body.game_id;
  if (typeof gameId !== 'string' || gameId.trim().length === 0) {
    throw new KinoApiError('Missing game_id', 400, 'missing_game_id');
  }
  return gameId.trim();
}

async function readJsonObject(c: Context): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new KinoApiError('Invalid JSON body', 400, 'invalid_json');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new KinoApiError('Invalid JSON body', 400, 'invalid_json');
  }
  return raw as Record<string, unknown>;
}

function parseStrictInteger(value: string | undefined, field: string): number | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    throw new KinoApiError(`Invalid ${field}`, 400, field === 'page' ? 'invalid_page' : 'invalid_page_size');
  }
  return Number.parseInt(value, 10);
}

function resolveUploadFileName(body: Record<string, unknown>): string {
  const fileName = body.file_name;
  if (typeof fileName === 'string' && fileName.trim().length > 0) {
    return fileName.trim();
  }

  const extension = body.extension;
  const normalized =
    typeof extension === 'string' ? extension.trim().replace(/^\./, '').toLowerCase() : '';
  if (normalized !== 'mp4') {
    throw new KinoApiError('Invalid upload file name', 400, 'invalid_file_name');
  }
  return `video-${randomUUID()}.mp4`;
}

function parseRangeHeader(header: string | undefined, size: number): RangeParseResult {
  if (!header) {
    return { kind: 'full' };
  }
  const trimmed = header.trim();
  if (!trimmed.startsWith('bytes=')) {
    return { kind: 'invalid' };
  }
  const spec = trimmed.slice('bytes='.length);
  if (spec.includes(',')) {
    return { kind: 'invalid' };
  }

  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match) {
    return { kind: 'invalid' };
  }

  const [, startText, endText] = match;
  if (startText === '' && endText === '') {
    return { kind: 'invalid' };
  }

  if (startText === '') {
    const suffix = Number.parseInt(endText!, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) {
      return { kind: 'invalid' };
    }
    if (suffix >= size) {
      return { kind: 'partial', start: 0, end: size - 1 };
    }
    return { kind: 'partial', start: size - suffix, end: size - 1 };
  }

  const start = Number.parseInt(startText, 10);
  if (!Number.isFinite(start) || start < 0) {
    return { kind: 'invalid' };
  }
  if (start >= size) {
    return { kind: 'unsatisfiable' };
  }

  if (endText === '') {
    return { kind: 'partial', start, end: size - 1 };
  }

  const end = Number.parseInt(endText, 10);
  if (!Number.isFinite(end) || end < start) {
    return { kind: 'invalid' };
  }
  if (end >= size) {
    return { kind: 'partial', start, end: size - 1 };
  }
  return { kind: 'partial', start, end };
}

async function respondWithEnvelope(c: Context, status: number, body: KinoEnvelope<unknown>) {
  return c.json(body, status as 200);
}

async function handleServiceCall<T>(
  c: Context,
  task: () => Promise<T>,
): Promise<Response> {
  try {
    const data = await task();
    return respondWithEnvelope(c, 200, kinoOk(data));
  } catch (error) {
    return respondWithTrustedError(c, error);
  }
}

async function handleVoidServiceCall(c: Context, task: () => Promise<void>): Promise<Response> {
  try {
    await task();
    return respondWithEnvelope(c, 200, kinoOk<null>(null));
  } catch (error) {
    return respondWithTrustedError(c, error);
  }
}

async function serveLocalContent(
  c: Context,
  source: Extract<PlaybackSource, { kind: 'local' }>,
): Promise<Response> {
  if (!Number.isSafeInteger(source.bytes) || source.bytes <= 0) {
    throw new KinoApiError(
      'Invalid video asset size',
      500,
      'invalid_video_asset_size',
    );
  }
  const method = c.req.method;
  const rangeHeader = c.req.header('range');
  const parsed = parseRangeHeader(rangeHeader, source.bytes);

  if (parsed.kind === 'invalid' || parsed.kind === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: {
        'Content-Range': `bytes */${source.bytes}`,
        'Accept-Ranges': 'bytes',
      },
    });
  }

  const start = parsed.kind === 'partial' ? parsed.start : 0;
  const end = parsed.kind === 'partial' ? parsed.end : source.bytes - 1;
  const length = end - start + 1;
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Content-Type': source.mimeType,
    'Content-Length': String(length),
  });

  if (parsed.kind === 'partial') {
    headers.set('Content-Range', `bytes ${start}-${end}/${source.bytes}`);
  }

  if (method === 'HEAD') {
    return new Response(null, { status: parsed.kind === 'partial' ? 206 : 200, headers });
  }

  const stream = createReadStream(source.filePath, { start, end });
  return new Response(stream as unknown as ReadableStream, {
    status: parsed.kind === 'partial' ? 206 : 200,
    headers,
  });
}

function withGameScope() {
  return async (c: Context, next: () => Promise<void>) => {
    try {
      requireGameIdFromQuery(c);
      await next();
    } catch (error) {
      return respondWithTrustedError(c, error);
    }
  };
}

export function createVideoAssetRouter(service: VideoAssetService): Hono {
  const router = new Hono();

  router.post('/image-assets/upload', async (c) => {
    return handleServiceCall(c, async () => {
      const body = await readJsonObject(c);
      const gameId = requireGameIdFromBody(body);
      const mimeType = body.mime_type;
      if (mimeType !== VIDEO_UPLOAD_MIME) {
        throw new KinoApiError('Invalid upload mime type', 400, 'invalid_media_type');
      }
      const bytes = body.bytes;
      if (
        typeof bytes !== 'number' ||
        !Number.isSafeInteger(bytes) ||
        bytes <= 0 ||
        bytes > MAX_VIDEO_UPLOAD_BYTES
      ) {
        throw new KinoApiError('Invalid upload size', 400, 'invalid_upload_size');
      }
      const context = buildRequestContext(c, gameId);
      const clientResourceId = body.client_resource_id;
      if (clientResourceId !== undefined) {
        if (
          typeof clientResourceId !== 'string' ||
          !isValidVideoAssetResourceId(clientResourceId)
        ) {
          throw new KinoApiError('Invalid client resource id', 400, 'invalid_client_resource_id');
        }
      }
      const replaceExisting = body.replace_existing;
      if (replaceExisting !== undefined && typeof replaceExisting !== 'boolean') {
        throw new KinoApiError(
          'Invalid replace_existing',
          400,
          'invalid_replace_existing',
        );
      }
      return service.prepareUpload(
        {
          fileName: resolveUploadFileName(body),
          mimeType: VIDEO_UPLOAD_MIME,
          bytes,
          ...(clientResourceId !== undefined
            ? { clientResourceId: clientResourceId.trim() }
            : {}),
          ...(replaceExisting !== undefined ? { replaceExisting } : {}),
        },
        context,
      );
    });
  });

  router.put('/uploads/:upload_token', async (c) => {
    let gameId: string;
    try {
      gameId = requireGameIdFromQuery(c);
    } catch (error) {
      return respondWithTrustedError(c, error);
    }

    const body = c.req.raw.body;
    const contentLength = c.req.header('content-length')?.trim();
    if (body === null || (contentLength !== undefined && /^0+$/.test(contentLength))) {
      return respondWithEnvelope(
        c,
        400,
        kinoError(400, 'Upload body must not be null', 'invalid_upload_body'),
      );
    }

    return handleVoidServiceCall(c, async () => {
      const token = c.req.param('upload_token')!;
      await service.receiveUpload(token, body, buildRequestContext(c, gameId));
    });
  });

  router.get('/resources', async (c) => {
    return handleServiceCall(c, async () => {
      const gameId = requireGameIdFromQuery(c);
      const mediaType = c.req.query('media_type') ?? 'video';
      if (mediaType !== 'video') {
        throw new KinoApiError('Invalid media type', 400, 'invalid_media_type');
      }
      const page = parseStrictInteger(c.req.query('page'), 'page');
      const pageSize = parseStrictInteger(c.req.query('page_size'), 'page_size');
      const context = buildRequestContext(c, gameId);
      return service.listResources(
        {
          game_id: gameId,
          media_type: 'video',
          page,
          page_size: pageSize,
        },
        context,
      );
    });
  });

  router.post('/resources/batch', async (c) => {
    return handleServiceCall(c, async () => {
      const body = await readJsonObject(c);
      const gameId = requireGameIdFromBody(body);
      const resources = body.resources;
      if (!Array.isArray(resources)) {
        throw new KinoApiError('Invalid JSON body', 400, 'invalid_json');
      }
      const context = buildRequestContext(c, gameId);
      return service.batchCreateResources(
        { game_id: gameId, resources } as Parameters<VideoAssetService['batchCreateResources']>[0],
        context,
      );
    });
  });

  router.post('/resources', async (c) => {
    return handleServiceCall(c, async () => {
      const body = await readJsonObject(c);
      const gameId = requireGameIdFromBody(body);
      const context = buildRequestContext(c, gameId);
      return service.createResource(body as unknown as CreateKinoResourceInput, context);
    });
  });

  router.get('/resources/:resource_id', withGameScope(), async (c) => {
    return handleServiceCall(c, async () => {
      const gameId = requireGameIdFromQuery(c);
      const resourceId = c.req.param('resource_id')!;
      return service.getResource(resourceId, buildRequestContext(c, gameId));
    });
  });

  router.put('/resources/:resource_id', withGameScope(), async (c) => {
    return handleServiceCall(c, async () => {
      const gameId = requireGameIdFromQuery(c);
      const resourceId = c.req.param('resource_id')!;
      const body = await readJsonObject(c);
      requireGameIdFromBody(body);
      const context = buildRequestContext(c, gameId);
      return service.updateResource(
        resourceId,
        body as unknown as UpdateKinoResourceInput,
        context,
      );
    });
  });

  router.delete('/resources/:resource_id', withGameScope(), async (c) => {
    return handleVoidServiceCall(c, async () => {
      const gameId = requireGameIdFromQuery(c);
      const resourceId = c.req.param('resource_id')!;
      await service.deleteResource(resourceId, buildRequestContext(c, gameId));
    });
  });

  const serveContent = async (c: Context): Promise<Response> => {
    try {
      const gameId = requireGameIdFromQuery(c);
      const resourceId = c.req.param('resource_id')!;
      const source = await service.playResource(resourceId, buildRequestContext(c, gameId));
      if (source.kind === 'redirect') {
        return new Response(null, {
          status: 302,
          headers: {
            Location: source.url,
            'Cache-Control': 'no-store',
          },
        });
      }
      return await serveLocalContent(c, source);
    } catch (error) {
      return respondWithTrustedError(c, error);
    }
  };

  router.on(['GET', 'HEAD'], '/resources/:resource_id/content', withGameScope(), serveContent);

  return router;
}
