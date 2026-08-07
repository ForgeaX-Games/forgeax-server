import { constants } from 'node:fs';
import {
  mkdir,
  open,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  MediaUpload,
  MediaUploadChunk,
  MediaUploadInput,
} from '@forgeax/workbench-host/contracts';

const UPLOAD_ID_RE = /^upload-[0-9a-f]{32}$/;

interface StoredMediaUpload {
  readonly version: 1;
  readonly id: string;
  readonly gameId: string;
  readonly fingerprint: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly metadata?: Record<string, unknown>;
  readonly state: 'uploading' | 'completed';
  readonly assetId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fingerprint(input: MediaUploadInput): string {
  return createHash('sha256')
    .update(input.filename)
    .update('\0')
    .update(input.contentType)
    .update('\0')
    .update(String(input.sizeBytes))
    .update('\0')
    .update(JSON.stringify(input.metadata ?? null) ?? 'null')
    .digest('hex');
}

function idempotentUploadId(gameId: string, key: string): string {
  const digest = createHash('sha256')
    .update(gameId)
    .update('\0')
    .update(key)
    .digest('hex');
  return `upload-${digest.slice(0, 32)}`;
}

function randomUploadId(): string {
  return `upload-${randomUUID().replaceAll('-', '')}`;
}

function assertStoredUpload(value: unknown): asserts value is StoredMediaUpload {
  if (!isRecord(value)) throw new Error('Workbench media upload checkpoint is invalid');
  if (
    value.version !== 1
    || typeof value.id !== 'string'
    || !UPLOAD_ID_RE.test(value.id)
    || typeof value.gameId !== 'string'
    || value.gameId.length === 0
    || typeof value.fingerprint !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.fingerprint)
    || typeof value.filename !== 'string'
    || value.filename.length === 0
    || typeof value.contentType !== 'string'
    || value.contentType.length === 0
    || typeof value.sizeBytes !== 'number'
    || !Number.isSafeInteger(value.sizeBytes)
    || value.sizeBytes < 0
    || (value.metadata !== undefined && !isRecord(value.metadata))
    || (value.state !== 'uploading' && value.state !== 'completed')
    || (value.assetId !== undefined && (typeof value.assetId !== 'string' || value.assetId.length === 0))
    || (value.state === 'completed' && value.assetId === undefined)
  ) {
    throw new Error('Workbench media upload checkpoint is invalid');
  }
}

function publicUpload(stored: StoredMediaUpload, offset: number): MediaUpload {
  return {
    id: stored.id,
    filename: stored.filename,
    contentType: stored.contentType,
    sizeBytes: stored.sizeBytes,
    offset,
    state: stored.state,
    ...(stored.metadata === undefined ? {} : { metadata: stored.metadata }),
  };
}

async function readTextNoFollow(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}

async function readBytesNoFollow(path: string, expectedSize: number): Promise<Uint8Array> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size !== expectedSize) {
      throw new Error('Workbench media upload bytes are invalid');
    }
    return new Uint8Array(await file.readFile());
  } finally {
    await file.close();
  }
}

async function writeJsonAtomically(path: string, value: StoredMediaUpload): Promise<void> {
  const tempPath = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      mode: 0o600,
    });
    await rename(tempPath, path);
  } finally {
    await rm(tempPath, { force: true });
  }
}

/** Durable, game-scoped checkpoints for the Workbench resumable media contract. */
export class ForgeaxMediaUploadStore {
  readonly #rootForGame: (gameId: string) => string;
  readonly #queues = new Map<string, Promise<void>>();

  constructor(rootForGame: (gameId: string) => string) {
    this.#rootForGame = rootForGame;
  }

  async create(gameId: string, input: MediaUploadInput): Promise<MediaUpload> {
    const uploadId = input.idempotencyKey
      ? idempotentUploadId(gameId, input.idempotencyKey)
      : randomUploadId();
    return this.#withLock(gameId, uploadId, async () => {
      const existing = await this.#read(gameId, uploadId);
      if (existing) {
        if (existing.stored.fingerprint !== fingerprint(input)) {
          throw new TypeError('Media upload idempotency key was reused with different input');
        }
        return publicUpload(existing.stored, existing.offset);
      }

      const root = this.#rootForGame(gameId);
      await mkdir(root, { recursive: true, mode: 0o700 });
      const stored: StoredMediaUpload = {
        version: 1,
        id: uploadId,
        gameId,
        fingerprint: fingerprint(input),
        filename: input.filename,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        state: 'uploading',
      };
      const { checkpointPath, partPath } = this.#paths(gameId, uploadId);
      let removePart = false;
      try {
        await writeFile(partPath, new Uint8Array(), {
          flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          mode: 0o600,
        });
        removePart = true;
        await writeJsonAtomically(checkpointPath, stored);
        removePart = false;
      } finally {
        if (removePart) await rm(partPath, { force: true });
      }
      return publicUpload(stored, 0);
    });
  }

  async get(gameId: string, uploadId: string): Promise<MediaUpload | null> {
    return this.#withLock(gameId, uploadId, async () => {
      const existing = await this.#read(gameId, uploadId);
      return existing ? publicUpload(existing.stored, existing.offset) : null;
    });
  }

  async writeChunk(
    gameId: string,
    uploadId: string,
    input: MediaUploadChunk,
  ): Promise<MediaUpload | null> {
    if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
      throw new TypeError('Upload offset must be a non-negative safe integer');
    }
    return this.#withLock(gameId, uploadId, async () => {
      const existing = await this.#read(gameId, uploadId);
      if (!existing) return null;
      const bytes = new Uint8Array(input.bytes);
      const { stored } = existing;
      const { partPath } = this.#paths(gameId, uploadId);
      const file = await open(
        partPath,
        constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW,
      );
      try {
        const info = await file.stat();
        const offset = info.size;
        if (input.offset < offset) {
          const available = Math.min(bytes.byteLength, offset - input.offset);
          const prior = new Uint8Array(available);
          const result = await file.read(prior, 0, available, input.offset);
          if (
            result.bytesRead === bytes.byteLength
            && prior.every((value, index) => value === bytes[index])
          ) {
            return publicUpload(stored, offset);
          }
          throw new TypeError('Upload chunk conflicts with stored bytes');
        }
        if (stored.state === 'completed') throw new TypeError('Upload is already completed');
        if (input.offset !== offset) throw new TypeError('Upload chunk offset is not resumable');
        if (offset + bytes.byteLength > stored.sizeBytes) {
          throw new TypeError('Upload chunk exceeds declared size');
        }
        await file.writeFile(bytes);
        await file.sync();
        return publicUpload(stored, offset + bytes.byteLength);
      } finally {
        await file.close();
      }
    });
  }

  async complete<T>(
    gameId: string,
    uploadId: string,
    operation: (checkpoint: {
      upload: MediaUpload;
      readBytes: () => Promise<Uint8Array>;
      assetId?: string;
    }) => Promise<{ asset: T; assetId: string }>,
  ): Promise<T> {
    return this.#withLock(gameId, uploadId, async () => {
      const existing = await this.#read(gameId, uploadId);
      if (!existing) throw new TypeError('Upload was not found');
      if (existing.offset !== existing.stored.sizeBytes) throw new TypeError('Upload is incomplete');
      const { partPath } = this.#paths(gameId, uploadId);
      const completed = await operation({
        upload: publicUpload(existing.stored, existing.offset),
        readBytes: () => readBytesNoFollow(partPath, existing.offset),
        ...(existing.stored.assetId === undefined ? {} : { assetId: existing.stored.assetId }),
      });
      if (!completed.assetId) throw new TypeError('Completed media asset id must not be empty');
      if (
        existing.stored.assetId !== undefined
        && existing.stored.assetId !== completed.assetId
      ) {
        throw new Error('Completed upload points to a different media asset');
      }
      const stored: StoredMediaUpload = {
        ...existing.stored,
        state: 'completed',
        assetId: completed.assetId,
      };
      await writeJsonAtomically(this.#paths(gameId, uploadId).checkpointPath, stored);
      return completed.asset;
    });
  }

  #paths(gameId: string, uploadId: string): { checkpointPath: string; partPath: string } {
    if (!UPLOAD_ID_RE.test(uploadId)) throw new TypeError('Invalid media upload id');
    const root = this.#rootForGame(gameId);
    return {
      checkpointPath: join(root, `${uploadId}.json`),
      partPath: join(root, `${uploadId}.part`),
    };
  }

  async #read(
    gameId: string,
    uploadId: string,
  ): Promise<{ stored: StoredMediaUpload; offset: number } | null> {
    const { checkpointPath, partPath } = this.#paths(gameId, uploadId);
    let raw: string;
    try {
      raw = await readTextNoFollow(checkpointPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error('Workbench media upload checkpoint is invalid');
    }
    assertStoredUpload(value);
    if (value.id !== uploadId || value.gameId !== gameId) {
      throw new Error('Workbench media upload checkpoint identity is invalid');
    }
    const file = await open(partPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > value.sizeBytes) {
        throw new Error('Workbench media upload bytes are invalid');
      }
      return { stored: value, offset: info.size };
    } finally {
      await file.close();
    }
  }

  async #withLock<T>(
    gameId: string,
    uploadId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${gameId}\0${uploadId}`;
    const previous = this.#queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const current = previous.then(() => gate);
    this.#queues.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#queues.get(key) === current) this.#queues.delete(key);
    }
  }
}
