import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { VideoAsset, VideoAssetManifest } from './contracts';
import { KinoApiError } from './kino-api';
import {
  convertVideoManifestV1,
  VideoAssetMigrationError,
} from './legacy-manifest';
import {
  validateAndCloneVideoAssetManifest,
  validateVideoAssetManifest,
  VideoAssetManifestSchemaError,
} from './manifest-schema';

const MANIFEST_RELATIVE = join('game-video', 'assets', 'manifest.json');

interface ManifestFileOperations {
  readText(path: string): string;
  makeDirectory(path: string): void;
  writeText(path: string, contents: string): void;
  rename(source: string, destination: string): void;
  remove(path: string): void;
}

const DEFAULT_FILE_OPERATIONS: ManifestFileOperations = {
  readText: (path) => readFileSync(path, 'utf-8'),
  makeDirectory: (path) => mkdirSync(path, { recursive: true }),
  writeText: (path, contents) => writeFileSync(path, contents, 'utf-8'),
  rename: renameSync,
  remove: (path) => rmSync(path, { force: true }),
};

function manifestPathFor(gameDir: string): string {
  return resolve(gameDir, MANIFEST_RELATIVE);
}

function assetsDirFor(gameDir: string): string {
  return resolve(gameDir, 'game-video', 'assets');
}

function emptyManifest(): VideoAssetManifest {
  return { version: 2, assets: [] };
}

function mapSchemaError(error: unknown): never {
  if (error instanceof VideoAssetManifestSchemaError) {
    throw new KinoApiError(error.message, 400, error.code);
  }
  throw error;
}

function mapLegacyManifestError(error: unknown): never {
  if (error instanceof VideoAssetMigrationError) {
    throw new KinoApiError(error.message, 400, error.code);
  }
  throw error;
}

function readManifestFile(
  manifestPath: string,
  files: ManifestFileOperations,
): VideoAssetManifest {
  let raw: string;
  try {
    raw = files.readText(manifestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyManifest();
    }
    throw new KinoApiError('Failed to read manifest', 500, 'manifest_storage_error');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new KinoApiError('Invalid manifest file', 400, 'invalid_manifest');
  }
  const version = (parsed as { version?: unknown }).version;
  if (version === 2) {
    try {
      return validateAndCloneVideoAssetManifest(parsed);
    } catch (error) {
      mapSchemaError(error);
    }
  }
  if (version === 1) {
    try {
      return convertVideoManifestV1(parsed as Record<string, unknown>);
    } catch (error) {
      mapLegacyManifestError(error);
    }
  }
  throw new KinoApiError('Unsupported manifest version', 400, 'unsupported_manifest_version');
}

function writeManifestAtomic(
  gameDir: string,
  manifest: VideoAssetManifest,
  files: ManifestFileOperations,
): void {
  try {
    validateVideoAssetManifest(manifest);
  } catch (error) {
    mapSchemaError(error);
  }
  let contents: string;
  try {
    contents = `${JSON.stringify(manifest, null, 2)}\n`;
  } catch {
    throw new KinoApiError('Invalid manifest file', 400, 'invalid_manifest');
  }

  const assetsDir = assetsDirFor(gameDir);
  const manifestPath = manifestPathFor(gameDir);
  const tempPath = `${manifestPath}.tmp-${randomUUID()}`;
  let removeTemp = false;
  try {
    files.makeDirectory(assetsDir);
    removeTemp = true;
    files.writeText(tempPath, contents);
    files.rename(tempPath, manifestPath);
    removeTemp = false;
  } catch {
    throw new KinoApiError('Failed to write manifest', 500, 'manifest_storage_error');
  } finally {
    if (removeTemp) {
      try {
        files.remove(tempPath);
      } catch {
        // Preserve the primary storage failure.
      }
    }
  }
}

export class VideoAssetManifestRepository {
  readonly #queues = new Map<string, Promise<void>>();
  readonly #files: ManifestFileOperations;

  constructor(fileOperations: Partial<ManifestFileOperations> = {}) {
    this.#files = { ...DEFAULT_FILE_OPERATIONS, ...fileOperations };
  }

  async #enqueue<T>(gameDir: string, task: () => Promise<T>): Promise<T> {
    const queueKey = resolve(gameDir);
    const previous = this.#queues.get(queueKey) ?? Promise.resolve();
    let release!: () => void;
    const current = previous.then(
      () => new Promise<void>((resolveQueue) => {
        release = resolveQueue;
      }),
    );
    this.#queues.set(queueKey, current);

    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.#queues.get(queueKey) === current) {
        this.#queues.delete(queueKey);
      }
    }
  }

  async read(gameDir: string): Promise<VideoAssetManifest> {
    return readManifestFile(manifestPathFor(gameDir), this.#files);
  }

  async get(gameDir: string, id: string): Promise<VideoAsset | null> {
    const manifest = await this.read(gameDir);
    return manifest.assets.find((asset) => asset.id === id) ?? null;
  }

  async mutate<T>(
    gameDir: string,
    mutation: (manifest: VideoAssetManifest) => T | Promise<T>,
  ): Promise<T> {
    return this.#enqueue(gameDir, async () => {
      const manifest = readManifestFile(manifestPathFor(gameDir), this.#files);
      const result = await mutation(manifest);
      writeManifestAtomic(gameDir, manifest, this.#files);
      return result;
    });
  }
}
