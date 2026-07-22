import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import manifestV1Fixture from './fixtures/manifest-v1.json';
import {
  VideoAssetMigrationError,
  convertVideoManifestV1,
  migrateVideoAssetDirectory,
  validateScenarioReferences,
} from '../../src/video-assets/migration';
import {
  parseMigrateCliArgs,
  uploadVideoAssetBatch,
} from '../../scripts/migrate-video-assets';

const FIXTURE_BYTES = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);

let gameDir: string;
let assetsDir: string;
let blobsDir: string;

function manifestPath(): string {
  return join(assetsDir, 'manifest.json');
}

function writeBlob(name: string, bytes: Uint8Array): void {
  writeFileSync(join(blobsDir, name), bytes);
}

function sampleScenario(refs: string[]): Record<string, unknown> {
  const scenes: Record<string, unknown> = {};
  for (const ref of refs) {
    scenes[ref] = {
      id: ref,
      media: { kind: 'VIDEO', ref, meta: {} },
    };
  }
  return {
    id: 'nodia-main',
    scenes,
  };
}

function writeScenario(refs: string[]): void {
  const scenariosPath = join(gameDir, 'game-video', 'scenarios.json');
  mkdirSync(join(gameDir, 'game-video'), { recursive: true });
  writeFileSync(
    scenariosPath,
    JSON.stringify(
      {
        version: 1,
        activeId: 'nodia-main',
        items: [{ id: 'nodia-main', scenario: sampleScenario(refs) }],
      },
      null,
      2,
    ),
    'utf-8',
  );
}

beforeEach(() => {
  gameDir = mkdtempSync(join(tmpdir(), 'video-asset-migration-'));
  assetsDir = join(gameDir, 'game-video', 'assets');
  blobsDir = join(assetsDir, 'blobs');
  mkdirSync(blobsDir, { recursive: true });
  writeScenario(['m-narr-open', 'm-narr-door']);
});

afterEach(() => {
  rmSync(gameDir, { recursive: true, force: true });
});

describe('convertVideoManifestV1', () => {
  test('converts fixture v1 metadata to stable v2 ids', () => {
    const converted = convertVideoManifestV1(manifestV1Fixture);
    expect(converted.version).toBe(2);
    expect(converted.assets).toHaveLength(2);
    expect(converted.assets[0]).toEqual({
      id: 'm-narr-open',
      kind: 'video',
      name: 'narr-open',
      status: 'ready',
      mimeType: 'video/mp4',
      bytes: 128,
      createdAt: 1751500000000,
      updatedAt: 1751500000000,
      provider: { kind: 'local', ref: 'blobs/narr-open.mp4' },
      meta: {
        scenarioId: 'nodia-main',
        source: 'local-import',
      },
    });
  });

  test('returns an idempotent clone for already-valid v2 manifests', () => {
    const v2 = convertVideoManifestV1(manifestV1Fixture);
    const again = convertVideoManifestV1(v2);
    expect(again).toEqual(v2);
    expect(again).not.toBe(v2);
  });

  test.each([
    ['null asset', { version: 2, assets: [null] }],
    ['invalid name', {
      version: 2,
      assets: [{
        id: 'a', kind: 'video', name: 1, status: 'ready', mimeType: 'video/mp4',
        bytes: 1, createdAt: 1, updatedAt: 1,
        provider: { kind: 'local', ref: 'blobs/a.mp4' },
      }],
    }],
    ['invalid status', {
      version: 2,
      assets: [{
        id: 'a', kind: 'video', name: 'a', status: 'unknown', mimeType: 'video/mp4',
        bytes: 1, createdAt: 1, updatedAt: 1,
        provider: { kind: 'local', ref: 'blobs/a.mp4' },
      }],
    }],
    ['invalid duration', {
      version: 2,
      assets: [{
        id: 'a', kind: 'video', name: 'a', status: 'ready', mimeType: 'video/mp4',
        bytes: 1, durationMs: -1, createdAt: 1, updatedAt: 1,
        provider: { kind: 'local', ref: 'blobs/a.mp4' },
      }],
    }],
    ['invalid timestamp', {
      version: 2,
      assets: [{
        id: 'a', kind: 'video', name: 'a', status: 'ready', mimeType: 'video/mp4',
        bytes: 1, createdAt: Number.NaN, updatedAt: 1,
        provider: { kind: 'local', ref: 'blobs/a.mp4' },
      }],
    }],
    ['missing provider', {
      version: 2,
      assets: [{
        id: 'a', kind: 'video', name: 'a', status: 'ready', mimeType: 'video/mp4',
        bytes: 1, createdAt: 1, updatedAt: 1,
      }],
    }],
    ['invalid remote provider ref', {
      version: 2,
      assets: [{
        id: 'a', kind: 'video', name: 'a', status: 'ready', mimeType: 'video/mp4',
        bytes: 1, createdAt: 1, updatedAt: 1,
        provider: { kind: 's3', ref: '' },
      }],
    }],
    ['invalid upstream id', {
      version: 2,
      assets: [{
        id: 'a', kind: 'video', name: 'a', status: 'ready', mimeType: 'video/mp4',
        bytes: 1, createdAt: 1, updatedAt: 1,
        provider: { kind: 'kino', ref: 'object', upstreamResourceId: 2 },
      }],
    }],
    ['invalid error', {
      version: 2,
      assets: [{
        id: 'a', kind: 'video', name: 'a', status: 'failed', mimeType: 'video/mp4',
        bytes: 1, createdAt: 1, updatedAt: 1, error: {},
        provider: { kind: 's3', ref: 'object' },
      }],
    }],
    ['invalid meta', {
      version: 2,
      assets: [{
        id: 'a', kind: 'video', name: 'a', status: 'ready', mimeType: 'video/mp4',
        bytes: 1, createdAt: 1, updatedAt: 1, meta: [],
        provider: { kind: 's3', ref: 'object' },
      }],
    }],
  ])('rejects malformed v2 manifest with a typed migration error: %s', (_name, input) => {
    try {
      convertVideoManifestV1(input as never);
      throw new Error('expected migration validation error');
    } catch (error) {
      expect(error).toBeInstanceOf(VideoAssetMigrationError);
      expect((error as VideoAssetMigrationError).code).toBe('invalid_manifest_schema');
    }
  });

  test('rejects unsupported manifest versions', () => {
    expect(() =>
      convertVideoManifestV1({ version: 3, assets: [] }),
    ).toThrow(VideoAssetMigrationError);
  });

  test('rejects duplicate stable ids', () => {
    expect(() =>
      convertVideoManifestV1({
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
    ).toThrow(/duplicate/i);
  });

  test('rejects unsafe local blob paths', () => {
    expect(() =>
      convertVideoManifestV1({
        version: 1,
        assets: [
          {
            id: 'bad',
            kind: 'video',
            filename: '../escape.mp4',
            mimeType: 'video/mp4',
            bytes: 1,
            createdAt: 1,
          },
        ],
      }),
    ).toThrow(/path/i);
  });
});

describe('validateScenarioReferences', () => {
  test('returns referenced and missing media ids from scenario structure', () => {
    const manifest = convertVideoManifestV1(manifestV1Fixture);
    const result = validateScenarioReferences(manifest, sampleScenario(['m-narr-open', 'm-narr-door', 'missing-ref']));
    expect(result.referenced).toEqual(['m-narr-door', 'm-narr-open', 'missing-ref']);
    expect(result.missing).toEqual(['missing-ref']);
  });
});

describe('migrateVideoAssetDirectory', () => {
  test('dry-run validates v2 conversion without writing manifest', () => {
    writeFileSync(manifestPath(), `${JSON.stringify(manifestV1Fixture, null, 2)}\n`, 'utf-8');

    const report = migrateVideoAssetDirectory({ gameDir, dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.wroteManifest).toBe(false);
    expect(JSON.parse(readFileSync(manifestPath(), 'utf-8')).version).toBe(1);
    expect(report.missingBlobs).toEqual([
      { id: 'm-narr-open', ref: 'blobs/narr-open.mp4', reason: 'missing' },
      { id: 'm-narr-door', ref: 'blobs/narr-door.mp4', reason: 'missing' },
    ]);
  });

  test('dry-run on already-v2 manifest validates before reporting missing blobs', () => {
    const converted = convertVideoManifestV1(manifestV1Fixture);
    writeFileSync(manifestPath(), `${JSON.stringify(converted, null, 2)}\n`, 'utf-8');

    const report = migrateVideoAssetDirectory({ gameDir, dryRun: true });
    expect(report.converted.version).toBe(2);
    expect(report.wroteManifest).toBe(false);
    expect(report.missingBlobs?.length).toBe(2);
  });

  test('real migration backs up v1, writes v2 atomically, and is idempotent', () => {
    writeFileSync(manifestPath(), `${JSON.stringify(manifestV1Fixture, null, 2)}\n`, 'utf-8');

    expect(() => migrateVideoAssetDirectory({ gameDir, dryRun: false })).toThrow(VideoAssetMigrationError);

    const openBytes = new Uint8Array(128);
    openBytes.fill(0x11);
    const doorBytes = new Uint8Array(256);
    doorBytes.fill(0x22);
    writeBlob('narr-open.mp4', openBytes);
    writeBlob('narr-door.mp4', doorBytes);

    const first = migrateVideoAssetDirectory({ gameDir, dryRun: false });
    expect(first.wroteManifest).toBe(true);
    expect(existsSync(join(assetsDir, 'manifest.json.v1.bak'))).toBe(true);
    expect(JSON.parse(readFileSync(manifestPath(), 'utf-8')).version).toBe(2);
    expect(readdirSync(assetsDir).filter((name) => name.endsWith('.tmp-')).length).toBe(0);

    const backupMtime = statSync(join(assetsDir, 'manifest.json.v1.bak')).mtimeMs;
    const second = migrateVideoAssetDirectory({ gameDir, dryRun: false });
    expect(second.wroteManifest).toBe(false);
    expect(statSync(join(assetsDir, 'manifest.json.v1.bak')).mtimeMs).toBe(backupMtime);
  });

  test('fails without modifying manifest when local blobs are missing', () => {
    writeFileSync(manifestPath(), `${JSON.stringify(manifestV1Fixture, null, 2)}\n`, 'utf-8');

    expect(() => migrateVideoAssetDirectory({ gameDir, dryRun: false })).toThrow(VideoAssetMigrationError);
    expect(JSON.parse(readFileSync(manifestPath(), 'utf-8')).version).toBe(1);
  });

  test('refuses to overwrite a different existing v1 backup', () => {
    writeFileSync(manifestPath(), `${JSON.stringify(manifestV1Fixture, null, 2)}\n`, 'utf-8');
    writeFileSync(`${manifestPath()}.v1.bak`, '{"different":true}\n', 'utf-8');
    writeBlob('narr-open.mp4', new Uint8Array(128));
    writeBlob('narr-door.mp4', new Uint8Array(256));

    try {
      migrateVideoAssetDirectory({ gameDir, dryRun: false });
      throw new Error('expected backup conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(VideoAssetMigrationError);
      expect((error as VideoAssetMigrationError).code).toBe('backup_conflict');
    }
    expect(JSON.parse(readFileSync(manifestPath(), 'utf-8')).version).toBe(1);
    expect(readFileSync(`${manifestPath()}.v1.bak`, 'utf-8')).toBe('{"different":true}\n');
  });

  test('lists legacy graph snapshots as ignored metadata', () => {
    writeFileSync(manifestPath(), `${JSON.stringify(manifestV1Fixture, null, 2)}\n`, 'utf-8');
    writeFileSync(join(gameDir, 'game-video', 'scenarios.graph_1.json'), '{}', 'utf-8');

    const report = migrateVideoAssetDirectory({ gameDir, dryRun: true });
    expect(report.legacyIgnored?.graphSnapshots).toEqual(['scenarios.graph_1.json']);
  });
});

describe('migrate-video-assets CLI parser', () => {
  test('requires --game-dir and parses optional flags', () => {
    expect(() => parseMigrateCliArgs([])).toThrow('--game-dir is required');
    const parsed = parseMigrateCliArgs([
      '--game-dir',
      '/tmp/game-nodia-fighting',
      '--dry-run',
      '--server-url',
      'http://127.0.0.1:18900',
    ]);
    expect(parsed.gameDir.endsWith('game-nodia-fighting')).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.serverUrl).toBe('http://127.0.0.1:18900');
  });

  test('upload helper performs N prepare and PUT requests before one authenticated batch commit', async () => {
    const sources = [
      new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'video/mp4' }),
      new Blob([new Uint8Array([5, 6, 7, 8])], { type: 'video/mp4' }),
    ];
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/image-assets/upload')) {
        const body = JSON.parse(String(init?.body)) as { client_resource_id: string };
        return Response.json({
          data: {
            upload: {
              url: `https://objects.example/${body.client_resource_id}`,
              headers: { 'x-signed-header': body.client_resource_id },
            },
            object_url: `http://localhost:18900/api/v1/kino/uploads/${body.client_resource_id}`,
          },
        });
      }
      if (url.endsWith('/resources/batch')) {
        return Response.json({
          data: {
            created_count: 2,
            skipped_count: 0,
            items: [
              { resource_id: 'm-narr-open' },
              { resource_id: 'm-narr-door' },
            ],
          },
        });
      }
      return new Response(null, { status: 200 });
    };

    await uploadVideoAssetBatch({
      fetchImpl,
      serverUrl: 'http://localhost:18900',
      gameSlug: 'game-nodia-fighting',
      assets: [
        {
          assetId: 'm-narr-open',
          body: sources[0],
          size: sources[0].size,
          fileName: 'narr-open.mp4',
          durationMs: 100,
        },
        {
          assetId: 'm-narr-door',
          body: sources[1],
          size: sources[1].size,
          fileName: 'narr-door.mp4',
        },
      ],
      authorization: 'Bearer secret',
      cookie: 'sid=secret',
    });

    const prepares = calls.filter((call) => call.url.endsWith('/image-assets/upload'));
    const puts = calls.filter((call) => call.init?.method === 'PUT');
    const batches = calls.filter((call) => call.url.endsWith('/resources/batch'));
    expect(prepares).toHaveLength(2);
    expect(prepares.map((call) => JSON.parse(String(call.init?.body)))).toEqual([
      {
        game_id: 'game-nodia-fighting',
        mime_type: 'video/mp4',
        bytes: 4,
        file_name: 'narr-open.mp4',
        client_resource_id: 'm-narr-open',
        replace_existing: true,
      },
      {
        game_id: 'game-nodia-fighting',
        mime_type: 'video/mp4',
        bytes: 4,
        file_name: 'narr-door.mp4',
        client_resource_id: 'm-narr-door',
        replace_existing: true,
      },
    ]);
    expect(puts).toHaveLength(2);
    expect(batches).toHaveLength(1);
    expect(puts[0].init?.headers).toEqual({ 'x-signed-header': 'm-narr-open' });
    expect(puts[1].init?.headers).toEqual({ 'x-signed-header': 'm-narr-door' });
    expect(puts[0].init?.headers).not.toHaveProperty('authorization');
    expect(puts[1].init?.headers).not.toHaveProperty('cookie');
    expect(batches[0].init?.headers).toMatchObject({
      authorization: 'Bearer secret',
      cookie: 'sid=secret',
    });
    const batchBody = JSON.parse(String(batches[0].init?.body));
    expect(batchBody.resources).toEqual([
      {
        media_type: 'video',
        url: 'http://localhost:18900/api/v1/kino/uploads/m-narr-open',
        name: 'narr-open.mp4',
        type: 'UPLOAD',
        source: 'migration',
        source_meta: { duration_ms: 100 },
      },
      {
        media_type: 'video',
        url: 'http://localhost:18900/api/v1/kino/uploads/m-narr-door',
        name: 'narr-door.mp4',
        type: 'UPLOAD',
        source: 'migration',
        source_meta: {},
      },
    ]);
    expect(puts.map((call) => call.init?.body)).toEqual(sources);
  });

  test('streams large lazy bodies in order without materializing them and skips batch after second PUT failure', async () => {
    let arrayBufferCalls = 0;
    const makeLargeLazyBody = (label: string) => ({
      label,
      arrayBuffer() {
        arrayBufferCalls += 1;
        throw new Error('must remain lazy');
      },
    }) as unknown as NonNullable<RequestInit['body']>;
    const sources = [makeLargeLazyBody('first'), makeLargeLazyBody('second')];
    const uploadedBodies: Array<NonNullable<RequestInit['body']>> = [];
    const events: string[] = [];
    let putCount = 0;
    let batchCalls = 0;
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/image-assets/upload')) {
        const body = JSON.parse(String(init?.body)) as { client_resource_id: string };
        events.push(`prepare:${body.client_resource_id}`);
        return Response.json({
          data: {
            upload: { url: `https://objects.example/${Date.now()}`, headers: {} },
            object_url: `http://localhost:18900/api/v1/kino/uploads/${Date.now()}`,
          },
        });
      }
      if (init?.method === 'PUT') {
        putCount += 1;
        events.push(`put:${putCount}`);
        uploadedBodies.push(init.body!);
        return new Response(null, { status: putCount === 2 ? 500 : 200 });
      }
      batchCalls += 1;
      return new Response(null, { status: 200 });
    };

    await expect(
      uploadVideoAssetBatch({
        fetchImpl,
        serverUrl: 'http://localhost:18900',
        gameSlug: 'game-nodia-fighting',
        assets: [
          { assetId: 'm-a', body: sources[0], size: 5_000_000_000, fileName: 'a.mp4' },
          { assetId: 'm-b', body: sources[1], size: 6_000_000_000, fileName: 'b.mp4' },
        ],
      }),
    ).rejects.toBeInstanceOf(VideoAssetMigrationError);
    expect(batchCalls).toBe(0);
    expect(uploadedBodies).toEqual(sources);
    expect(arrayBufferCalls).toBe(0);
    expect(events).toEqual(['prepare:m-a', 'put:1', 'prepare:m-b', 'put:2']);
  });

  test('preserves every source when the single batch commit fails', async () => {
    const sources = [new Blob(['a']), new Blob(['b'])];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/image-assets/upload')) {
        return Response.json({
          data: {
            upload: { url: `https://objects.example/${Date.now()}`, headers: {} },
            object_url: `http://localhost:18900/api/v1/kino/uploads/${Date.now()}`,
          },
        });
      }
      if (init?.method === 'PUT') {
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 500 });
    };

    await expect(
      uploadVideoAssetBatch({
        fetchImpl,
        serverUrl: 'http://localhost:18900',
        gameSlug: 'game-nodia-fighting',
        assets: [
          { assetId: 'm-a', body: sources[0], size: sources[0].size, fileName: 'a.mp4' },
          { assetId: 'm-b', body: sources[1], size: sources[1].size, fileName: 'b.mp4' },
        ],
      }),
    ).rejects.toBeInstanceOf(VideoAssetMigrationError);
    expect(sources[0].size).toBe(1);
    expect(sources[1].size).toBe(1);
  });
});
