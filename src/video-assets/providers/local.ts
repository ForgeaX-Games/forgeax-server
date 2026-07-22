import {
  copyFileSync,
  createWriteStream,
  existsSync,
  linkSync,
  mkdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type {
  ProviderPrepareUploadInput,
  UploadedObject,
  VideoAsset,
  VideoAssetProvider,
  VideoAssetRequestContext,
} from '../contracts';
import type { ProjectRootResolver } from '../game-path';
import { resolveVideoAssetsDir } from '../game-path';
import { KinoApiError } from '../kino-api';
import { MAX_VIDEO_UPLOAD_BYTES } from '../upload-sessions';

const PREPARE_TTL_MS = 10 * 60 * 1000;
const LOCAL_BLOB_REF_RE = /^blobs\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.mp4$/;
const TEMP_UPLOAD_REF_RE =
  /^\.uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.part$/i;

interface LocalUploadState {
  ref: string;
  bytes: number;
  mimeType: 'video/mp4';
}

export interface LocalUploadWriter {
  write(chunk: Uint8Array): boolean;
  end(): void;
  destroy(error?: Error): void;
  once(event: 'error' | 'drain' | 'finish', listener: (...args: unknown[]) => void): this;
  off(event: 'error' | 'drain' | 'finish', listener: (...args: unknown[]) => void): this;
}

export interface LocalVideoAssetProviderOptions {
  createWriter?: (path: string) => LocalUploadWriter;
}

function assetsDirFor(context: VideoAssetRequestContext, getProjectRoot: ProjectRootResolver): string {
  return resolveVideoAssetsDir(context.gameId, getProjectRoot);
}

function assertSafeRelativeRef(ref: string): void {
  if (
    ref.includes('\0') ||
    ref.includes('..') ||
    ref.startsWith('/') ||
    ref.startsWith('\\')
  ) {
    throw new KinoApiError('Invalid local provider ref', 400, 'invalid_provider_ref');
  }
}

function parseUploadState(state: Record<string, unknown>): LocalUploadState {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new KinoApiError('Invalid upload session', 400, 'invalid_upload_session');
  }

  const ref = state.ref;
  const bytes = state.bytes;
  const mimeType = state.mimeType;
  if (typeof ref !== 'string' || !TEMP_UPLOAD_REF_RE.test(ref)) {
    throw new KinoApiError('Invalid upload session', 400, 'invalid_upload_session');
  }
  if (
    typeof bytes !== 'number' ||
    !Number.isFinite(bytes) ||
    bytes <= 0 ||
    bytes > MAX_VIDEO_UPLOAD_BYTES
  ) {
    throw new KinoApiError('Invalid upload size', 400, 'invalid_upload_size');
  }
  if (mimeType !== 'video/mp4') {
    throw new KinoApiError('Invalid upload mime type', 400, 'invalid_media_type');
  }

  return { ref, bytes, mimeType };
}

function assertSafeBlobRef(ref: string): void {
  assertSafeRelativeRef(ref);
  if (!LOCAL_BLOB_REF_RE.test(ref)) {
    throw new KinoApiError('Invalid local provider ref', 400, 'invalid_provider_ref');
  }
}

function removeIfExists(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Best-effort cleanup after upload failures.
  }
}

function removeUploadPart(path: string): void {
  try {
    rmSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new KinoApiError(
        'Failed to clean up local upload',
        500,
        'provider_cleanup_failed',
      );
    }
  }
}

async function streamToPartFile(
  body: ReadableStream<Uint8Array>,
  destination: string,
  declaredBytes: number,
  createWriter: (path: string) => LocalUploadWriter,
): Promise<number> {
  mkdirSync(resolve(destination, '..'), { recursive: true });
  removeIfExists(destination);

  const writer = createWriter(destination);
  const reader = body.getReader();
  let received = 0;
  let rejectWriterError!: (error: unknown) => void;
  const writerError = new Promise<never>((_resolve, reject) => {
    rejectWriterError = reject;
  });
  const onWriterError = (error: unknown): void => rejectWriterError(error);
  writer.once('error', onWriterError);

  const waitForWriterSignal = (
    event: 'drain' | 'finish',
  ): { promise: Promise<void>; cancel: () => void } => {
    let listener!: () => void;
    const promise = new Promise<void>((resolveSignal) => {
      listener = () => resolveSignal();
      writer.once(event, listener);
    });
    return {
      promise,
      cancel: () => writer.off(event, listener),
    };
  };

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), writerError]);
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }

      received += value.byteLength;
      if (received > declaredBytes || received > MAX_VIDEO_UPLOAD_BYTES) {
        throw new KinoApiError('Invalid upload size', 400, 'invalid_upload_size');
      }

      if (!writer.write(value)) {
        const drain = waitForWriterSignal('drain');
        try {
          await Promise.race([drain.promise, writerError]);
        } finally {
          drain.cancel();
        }
      }
    }

    const finish = waitForWriterSignal('finish');
    writer.end();
    try {
      await Promise.race([finish.promise, writerError]);
    } finally {
      finish.cancel();
    }

    if (received !== declaredBytes) {
      throw new KinoApiError('Invalid upload size', 400, 'invalid_upload_size');
    }

    return received;
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // Preserve the original stream failure.
    }
    writer.destroy();
    removeIfExists(destination);
    throw error;
  } finally {
    writer.off('error', onWriterError);
    reader.releaseLock();
  }
}

function blobSize(path: string): number {
  return statSync(path).size;
}

export function createLocalVideoAssetProvider(
  getProjectRoot: ProjectRootResolver,
  options: LocalVideoAssetProviderOptions = {},
): VideoAssetProvider {
  const createWriter =
    options.createWriter ??
    ((path: string): LocalUploadWriter =>
      createWriteStream(path, { flags: 'wx' }) as LocalUploadWriter);
  return {
    kind: 'local',

    async prepareUpload(input: ProviderPrepareUploadInput, context: VideoAssetRequestContext) {
      assetsDirFor(context, getProjectRoot);
      const expiresAt = new Date(Date.now() + PREPARE_TTL_MS).toISOString();

      return {
        instruction: {
          method: 'PUT' as const,
          url: `${context.origin}/api/v1/kino/uploads/${input.uploadToken}?game_id=${encodeURIComponent(context.gameId)}`,
          headers: {
            'content-type': 'video/mp4',
          },
          expiresAt,
        },
        state: {
          ref: `.uploads/${input.uploadToken}.part`,
          bytes: input.bytes,
          mimeType: input.mimeType,
        },
      };
    },

    async receiveUpload(state, body, context) {
      const upload = parseUploadState(state);
      const assetsDir = assetsDirFor(context, getProjectRoot);
      const partPath = resolve(assetsDir, upload.ref);
      await streamToPartFile(body, partPath, upload.bytes, createWriter);
    },

    async inspectUpload(state, context) {
      const upload = parseUploadState(state);
      const assetsDir = assetsDirFor(context, getProjectRoot);
      const partPath = resolve(assetsDir, upload.ref);
      if (!existsSync(partPath)) {
        throw new KinoApiError('Upload not found', 404, 'upload_not_found');
      }

      const bytes = blobSize(partPath);
      if (bytes !== upload.bytes) {
        throw new KinoApiError('Invalid upload size', 400, 'invalid_upload_size');
      }

      return {
        ref: upload.ref,
        bytes: upload.bytes,
        mimeType: upload.mimeType,
      } satisfies UploadedObject;
    },

    async cleanupUpload(state, context) {
      const upload = parseUploadState(state);
      const assetsDir = assetsDirFor(context, getProjectRoot);
      removeUploadPart(resolve(assetsDir, upload.ref));
    },

    async finalizeResource(object, input, context) {
      const upload = parseUploadState({
        ref: object.ref,
        bytes: object.bytes,
        mimeType: object.mimeType,
      });
      const assetsDir = assetsDirFor(context, getProjectRoot);
      const tempPath = resolve(assetsDir, upload.ref);
      const blobRef = `blobs/${input.resourceId}.mp4`;
      assertSafeBlobRef(blobRef);
      const blobPath = resolve(assetsDir, blobRef);

      if (existsSync(blobPath)) {
        const existingBytes = blobSize(blobPath);
        if (existingBytes === object.bytes) {
          return { kind: 'local', ref: blobRef };
        }
        throw new KinoApiError(
          'Conflicting local blob already exists',
          409,
          'provider_finalize_conflict',
        );
      }

      if (!existsSync(tempPath)) {
        throw new KinoApiError('Upload not found', 404, 'upload_not_found');
      }

      const tempBytes = blobSize(tempPath);
      if (tempBytes !== object.bytes) {
        throw new KinoApiError('Invalid upload size', 400, 'invalid_upload_size');
      }

      mkdirSync(resolve(blobPath, '..'), { recursive: true });
      const stagedBlobPath = `${blobPath}.tmp-${randomUUID()}`;
      try {
        copyFileSync(tempPath, stagedBlobPath);
        try {
          linkSync(stagedBlobPath, blobPath);
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code === 'EEXIST' &&
            blobSize(blobPath) === object.bytes
          ) {
            return { kind: 'local', ref: blobRef };
          }
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new KinoApiError(
              'Conflicting local blob already exists',
              409,
              'provider_finalize_conflict',
            );
          }
          throw error;
        }
      } finally {
        removeIfExists(stagedBlobPath);
      }
      return { kind: 'local', ref: blobRef };
    },

    async getPlayback(asset, context) {
      assertSafeBlobRef(asset.provider.ref);
      const assetsDir = assetsDirFor(context, getProjectRoot);
      const filePath = resolve(assetsDir, asset.provider.ref);
      if (!existsSync(filePath)) {
        throw new KinoApiError('Resource content not found', 404, 'resource_content_not_found');
      }

      const bytes = blobSize(filePath);
      return {
        kind: 'local',
        filePath,
        mimeType: asset.mimeType,
        bytes,
      };
    },

    async delete(asset, context) {
      assertSafeBlobRef(asset.provider.ref);
      const assetsDir = assetsDirFor(context, getProjectRoot);
      const blobPath = resolve(assetsDir, asset.provider.ref);
      removeIfExists(blobPath);
    },
  };
}
