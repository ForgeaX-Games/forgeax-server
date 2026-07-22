import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { VideoAsset } from '../../src/video-assets/contracts';
import { KinoApiError } from '../../src/video-assets/kino-api';
import { VideoAssetManifestRepository } from '../../src/video-assets/manifest-repository';
import manifestV1Fixture from './fixtures/manifest-v1.json';

let gameDir: string;
const repo = new VideoAssetManifestRepository();

function manifestPath(): string {
  return resolve(gameDir, 'game-video/assets/manifest.json');
}

function sampleAsset(id: string): VideoAsset {
  return {
    id,
    kind: 'video',
    name: id,
    status: 'ready',
    mimeType: 'video/mp4',
    bytes: 128,
    createdAt: 1,
    updatedAt: 2,
    provider: { kind: 'local', ref: `blobs/${id}.mp4` },
  };
}

async function expectKinoError(
  action: Promise<unknown>,
  status: number,
  errorCode: string,
): Promise<void> {
  try {
    await action;
    throw new Error('expected KinoApiError');
  } catch (error) {
    expect(error).toBeInstanceOf(KinoApiError);
    expect((error as KinoApiError).status).toBe(status);
    expect((error as KinoApiError).errorCode).toBe(errorCode);
  }
}

beforeEach(() => {
  gameDir = mkdtempSync(join(tmpdir(), 'video-assets-manifest-'));
});

afterEach(() => {
  rmSync(gameDir, { recursive: true, force: true });
});

function writeV1Fixture(): void {
  mkdirSync(resolve(gameDir, 'game-video/assets'), { recursive: true });
  writeFileSync(manifestPath(), `${JSON.stringify(manifestV1Fixture, null, 2)}\n`, 'utf-8');
}

describe('VideoAssetManifestRepository.read', () => {
  test('returns an empty v2 manifest when no file exists', async () => {
    await expect(repo.read(gameDir)).resolves.toEqual({ version: 2, assets: [] });
  });

  test('normalizes v1 manifests in memory without writing v2 to disk', async () => {
    writeV1Fixture();

    const manifest = await repo.read(gameDir);
    expect(manifest.version).toBe(2);
    expect(manifest.assets).toHaveLength(2);
    expect(manifest.assets[0]?.id).toBe('m-narr-open');
    expect(manifest.assets[0]?.provider).toEqual({
      kind: 'local',
      ref: 'blobs/narr-open.mp4',
    });
    expect(manifest.assets[0]?.meta).toEqual({
      scenarioId: 'nodia-main',
      source: 'local-import',
    });
    expect(JSON.parse(readFileSync(manifestPath(), 'utf-8')).version).toBe(1);
  });

  test('rejects unsupported manifest versions', async () => {
    mkdirSync(resolve(gameDir, 'game-video/assets'), { recursive: true });
    writeFileSync(
      manifestPath(),
      JSON.stringify({ version: 3, assets: [] }),
      'utf-8',
    );
    await expectKinoError(repo.read(gameDir), 400, 'unsupported_manifest_version');
  });

  test('rejects malformed v1 manifests with typed errors', async () => {
    mkdirSync(resolve(gameDir, 'game-video/assets'), { recursive: true });
    writeFileSync(
      manifestPath(),
      JSON.stringify({ version: 1, assets: [null] }),
      'utf-8',
    );
    await expectKinoError(repo.read(gameDir), 400, 'invalid_manifest_schema');
  });

  test('rejects unsafe v1 local blob paths', async () => {
    mkdirSync(resolve(gameDir, 'game-video/assets'), { recursive: true });
    writeFileSync(
      manifestPath(),
      JSON.stringify({
        version: 1,
        assets: [{
          id: 'bad',
          kind: 'video',
          filename: '../escape.mp4',
          mimeType: 'video/mp4',
          bytes: 1,
          createdAt: 1,
        }],
      }),
      'utf-8',
    );
    await expectKinoError(repo.read(gameDir), 400, 'invalid_manifest_path');
  });

  test('rejects duplicate stable ids after v1 conversion', async () => {
    mkdirSync(resolve(gameDir, 'game-video/assets'), { recursive: true });
    writeFileSync(
      manifestPath(),
      JSON.stringify({
        version: 1,
        assets: [
          {
            id: 'a',
            kind: 'video',
            filename: 'blobs/a.mp4',
            mimeType: 'video/mp4',
            bytes: 1,
            createdAt: 1,
            meta: { mediaId: 'dup' },
          },
          {
            id: 'b',
            kind: 'video',
            filename: 'blobs/b.mp4',
            mimeType: 'video/mp4',
            bytes: 1,
            createdAt: 1,
            meta: { mediaId: 'dup' },
          },
        ],
      }),
      'utf-8',
    );
    await expectKinoError(repo.read(gameDir), 400, 'duplicate_asset_id');
  });

  test('distinguishes malformed JSON from unexpected read I/O', async () => {
    mkdirSync(resolve(gameDir, 'game-video/assets'), { recursive: true });
    writeFileSync(manifestPath(), '{bad json', 'utf-8');
    await expectKinoError(repo.read(gameDir), 400, 'invalid_manifest');

    const ioRepo = new VideoAssetManifestRepository({
      readText: () => {
        throw Object.assign(new Error('read failed'), { code: 'EIO' });
      },
    });
    await expectKinoError(ioRepo.read(gameDir), 500, 'manifest_storage_error');
  });
});

describe('VideoAssetManifestRepository.mutate', () => {
  test('upgrades v1 manifests to v2 on the first successful mutation', async () => {
    writeV1Fixture();

    await repo.mutate(gameDir, (manifest) => {
      expect(manifest.version).toBe(2);
      expect(manifest.assets[0]?.id).toBe('m-narr-open');
    });

    const raw = readFileSync(manifestPath(), 'utf-8');
    expect(JSON.parse(raw).version).toBe(2);
    expect(JSON.parse(raw).assets[0]?.id).toBe('m-narr-open');
  });

  test('leaves v1 manifests untouched when the mutation callback throws', async () => {
    writeV1Fixture();

    await expect(
      repo.mutate(gameDir, () => {
        throw new Error('mutation failed');
      }),
    ).rejects.toThrow('mutation failed');
    expect(JSON.parse(readFileSync(manifestPath(), 'utf-8')).version).toBe(1);
  });

  test('retains both assets under concurrent mutations', async () => {
    await Promise.all([
      repo.mutate(gameDir, (manifest) => {
        manifest.assets.push(sampleAsset('a'));
      }),
      repo.mutate(gameDir, (manifest) => {
        manifest.assets.push(sampleAsset('b'));
      }),
    ]);

    const manifest = await repo.read(gameDir);
    expect(manifest.assets.map((asset) => asset.id).sort()).toEqual(['a', 'b']);
  });

  test('serializes equivalent resolved game directory paths', async () => {
    await Promise.all([
      repo.mutate(gameDir, (manifest) => {
        manifest.assets.push(sampleAsset('a'));
      }),
      repo.mutate(`${gameDir}/.`, (manifest) => {
        manifest.assets.push(sampleAsset('b'));
      }),
    ]);

    const manifest = await repo.read(gameDir);
    expect(manifest.assets.map((asset) => asset.id).sort()).toEqual(['a', 'b']);
  });

  test('writes manifest atomically without leaving temp files', async () => {
    await repo.mutate(gameDir, (manifest) => {
      manifest.assets.push(sampleAsset('clip'));
    });

    const raw = readFileSync(manifestPath(), 'utf-8');
    expect(JSON.parse(raw)).toEqual({
      version: 2,
      assets: [sampleAsset('clip')],
    });

    const assetsDir = resolve(gameDir, 'game-video/assets');
    const leftovers = readdirSync(assetsDir).filter((name) => name.startsWith('manifest.json.tmp-'));
    expect(leftovers).toEqual([]);
  });

  test('rejects duplicate asset ids', async () => {
    await repo.mutate(gameDir, (manifest) => {
      manifest.assets.push(sampleAsset('dup'));
    });

    await expectKinoError(
      repo.mutate(gameDir, (manifest) => {
        manifest.assets.push(sampleAsset('dup'));
      }),
      400,
      'duplicate_asset_id',
    );
    await expect(repo.read(gameDir)).resolves.toEqual({
      version: 2,
      assets: [sampleAsset('dup')],
    });
  });

  test('rejects unsafe local provider refs', async () => {
    await expectKinoError(
      repo.mutate(gameDir, (manifest) => {
        manifest.assets.push({
          ...sampleAsset('unsafe'),
          provider: { kind: 'local', ref: '../escape.mp4' },
        });
      }),
      400,
      'invalid_provider_ref',
    );

    await expectKinoError(
      repo.mutate(gameDir, (manifest) => {
        manifest.assets.push({
          ...sampleAsset('abs'),
          provider: { kind: 'local', ref: '/tmp/evil.mp4' },
        });
      }),
      400,
      'invalid_provider_ref',
    );
  });

  test('rejects non-positive and fractional Local asset bytes', async () => {
    for (const bytes of [0, -1, 1.5]) {
      await expectKinoError(
        repo.mutate(gameDir, (manifest) => {
          manifest.assets.push({
            ...sampleAsset(`invalid-bytes-${String(bytes).replace('.', '-')}`),
            bytes,
          });
        }),
        400,
        'invalid_asset',
      );
    }
  });

  test('rejects unknown provider kinds', async () => {
    await expectKinoError(
      repo.mutate(gameDir, (manifest) => {
        manifest.assets.push({
          ...sampleAsset('unknown'),
          provider: { kind: 'ftp', ref: 'remote' } as unknown as VideoAsset['provider'],
        });
      }),
      400,
      'invalid_provider_kind',
    );
  });

  test('cleans the temp file when atomic rename fails', async () => {
    const failingRepo = new VideoAssetManifestRepository({
      rename: () => {
        throw Object.assign(new Error('rename failed'), { code: 'EIO' });
      },
    });

    await expectKinoError(
      failingRepo.mutate(gameDir, (manifest) => {
        manifest.assets.push(sampleAsset('clip'));
      }),
      500,
      'manifest_storage_error',
    );

    const assetsDir = resolve(gameDir, 'game-video/assets');
    expect(readdirSync(assetsDir).filter((name) => name.includes('.tmp-'))).toEqual([]);
    expect(() => readFileSync(manifestPath(), 'utf-8')).toThrow();
  });
});

describe('VideoAssetManifestRepository.get', () => {
  test('returns one asset by stable id from a v1 manifest', async () => {
    writeV1Fixture();

    await expect(repo.get(gameDir, 'm-narr-open')).resolves.toMatchObject({
      id: 'm-narr-open',
      provider: { kind: 'local', ref: 'blobs/narr-open.mp4' },
    });
    await expect(repo.get(gameDir, 'missing')).resolves.toBeNull();
  });

  test('returns one asset by id', async () => {
    await repo.mutate(gameDir, (manifest) => {
      manifest.assets.push(sampleAsset('found'));
    });

    await expect(repo.get(gameDir, 'found')).resolves.toEqual(sampleAsset('found'));
    await expect(repo.get(gameDir, 'missing')).resolves.toBeNull();
  });
});
