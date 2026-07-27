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

const MANIFEST_RELATIVE = join('assets', 'manifest.json');

interface ManifestFileOperations {
  readText(path: string): string;
  makeDirectory(path: string): void;
  writeText(path: string, contents: string): void;
  rename(source: string, destination: string): void;
  remove(path: string): void;
}

interface RootAssetManifest {
  version: 2;
  assets: unknown[];
  [key: string]: unknown;
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
  return resolve(gameDir, 'assets');
}

function emptyRootManifest(): RootAssetManifest {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isManagedVideoAsset(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.kind === 'video' || value.kind === 'image' || value.kind === 'audio') &&
    Object.hasOwn(value, 'provider')
  );
}

function isLegacyVideoAsset(value: unknown): boolean {
  return isRecord(value) && value.kind === 'video' && typeof value.filename === 'string';
}

function assertRootAssetIds(assets: unknown[]): void {
  const ids = new Set<string>();
  for (const asset of assets) {
    if (
      !isRecord(asset) ||
      typeof asset.id !== 'string' ||
      asset.id.length === 0 ||
      typeof asset.kind !== 'string' ||
      asset.kind.length === 0
    ) {
      throw new KinoApiError('Invalid asset', 400, 'invalid_asset');
    }
    if (ids.has(asset.id)) {
      throw new KinoApiError(`Duplicate asset id: ${asset.id}`, 400, 'duplicate_asset_id');
    }
    ids.add(asset.id);
  }
}

function parseManifestFile(
  manifestPath: string,
  files: ManifestFileOperations,
): { root: RootAssetManifest; videos: VideoAssetManifest } {
  let raw: string;
  try {
    raw = files.readText(manifestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { root: emptyRootManifest(), videos: { version: 2, assets: [] } };
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
    if (!isRecord(parsed) || !Array.isArray(parsed.assets)) {
      throw new KinoApiError('Invalid manifest assets', 400, 'invalid_manifest');
    }
    assertRootAssetIds(parsed.assets);
    const videos = { version: 2, assets: parsed.assets.filter(isManagedVideoAsset) };
    try {
      return {
        root: { ...parsed, version: 2, assets: [...parsed.assets] },
        videos: validateAndCloneVideoAssetManifest(videos),
      };
    } catch (error) {
      mapSchemaError(error);
    }
  }
  if (version === 1) {
    if (!isRecord(parsed) || !Array.isArray(parsed.assets)) {
      throw new KinoApiError('Invalid manifest assets', 400, 'invalid_manifest');
    }
    try {
      assertRootAssetIds(parsed.assets);
    } catch {
      throw new KinoApiError('Invalid v1 manifest schema', 400, 'invalid_manifest_schema');
    }
    const legacyAssets = parsed.assets.filter(isLegacyVideoAsset);
    try {
      const videos = convertVideoManifestV1({ version: 1, assets: legacyAssets });
      const foreignAssets = parsed.assets.filter((asset) => !isLegacyVideoAsset(asset));
      const root: RootAssetManifest = {
        ...parsed,
        version: 2,
        assets: [...foreignAssets, ...videos.assets],
      };
      assertRootAssetIds(root.assets);
      return { root, videos };
    } catch (error) {
      mapLegacyManifestError(error);
    }
  }
  throw new KinoApiError('Unsupported manifest version', 400, 'unsupported_manifest_version');
}

function writeManifestAtomic(
  gameDir: string,
  manifest: RootAssetManifest,
  files: ManifestFileOperations,
): void {
  assertRootAssetIds(manifest.assets);
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
    return parseManifestFile(manifestPathFor(gameDir), this.#files).videos;
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
      const { root, videos } = parseManifestFile(manifestPathFor(gameDir), this.#files);
      const result = await mutation(videos);
      try {
        validateVideoAssetManifest(videos);
      } catch (error) {
        mapSchemaError(error);
      }

      const managedIds = new Set(
        root.assets.filter(isManagedVideoAsset).map((asset) => (asset as Record<string, unknown>).id),
      );
      const nextVideos = new Map(videos.assets.map((asset) => [asset.id, asset]));
      const mergedAssets: unknown[] = [];
      for (const asset of root.assets) {
        const id = (asset as Record<string, unknown>).id as string;
        if (!managedIds.has(id)) {
          if (nextVideos.has(id)) {
            throw new KinoApiError(`Duplicate asset id: ${id}`, 400, 'duplicate_asset_id');
          }
          mergedAssets.push(asset);
          continue;
        }
        const replacement = nextVideos.get(id);
        if (replacement) {
          mergedAssets.push(replacement);
          nextVideos.delete(id);
        }
      }
      mergedAssets.push(...nextVideos.values());
      const nextRoot = { ...root, version: 2 as const, assets: mergedAssets };
      writeManifestAtomic(gameDir, nextRoot, this.#files);
      return result;
    });
  }
}
