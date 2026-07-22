import { describe, expect, test } from 'bun:test';
import {
  VideoAssetManifestSchemaError,
  validateAndCloneVideoAssetManifest,
} from '../../src/video-assets/manifest-schema';
import { VideoAssetManifestRepository } from '../../src/video-assets/manifest-repository';
import {
  VideoAssetMigrationError,
  convertVideoManifestV1,
} from '../../src/video-assets/migration';
import { KinoApiError } from '../../src/video-assets/kino-api';

function validManifest(): Record<string, unknown> {
  return {
    version: 2,
    assets: [
      {
        id: 'asset-a',
        kind: 'video',
        name: 'asset-a',
        status: 'ready',
        mimeType: 'video/mp4',
        bytes: 10,
        durationMs: 0,
        createdAt: 1,
        updatedAt: 2,
        provider: { kind: 'local', ref: 'blobs/asset-a.mp4' },
        meta: { source: 'test' },
      },
    ],
  };
}

describe('shared video asset manifest schema', () => {
  test('returns a deep clone and accepts zero duration', () => {
    const input = validManifest();
    const validated = validateAndCloneVideoAssetManifest(input);
    expect(validated as unknown).toEqual(input);
    expect(validated).not.toBe(input);
    expect(validated.assets[0]).not.toBe((input.assets as unknown[])[0]);
  });

  test.each([
    ['zero bytes', (manifest: any) => { manifest.assets[0].bytes = 0; }],
    ['negative duration', (manifest: any) => { manifest.assets[0].durationMs = -1; }],
    ['non-finite timestamp', (manifest: any) => { manifest.assets[0].updatedAt = Infinity; }],
    ['invalid provider', (manifest: any) => { manifest.assets[0].provider = null; }],
    ['invalid meta', (manifest: any) => { manifest.assets[0].meta = []; }],
    ['invalid error', (manifest: any) => { manifest.assets[0].error = {}; }],
    ['duplicate id', (manifest: any) => { manifest.assets.push({ ...manifest.assets[0] }); }],
    ['duplicate local ref', (manifest: any) => {
      manifest.assets.push({
        ...manifest.assets[0],
        id: 'asset-b',
      });
    }],
  ])('all adapters reject the same malformed fixture: %s', async (_name, mutate) => {
    const input = validManifest();
    mutate(input);

    expect(() => validateAndCloneVideoAssetManifest(input)).toThrow(
      VideoAssetManifestSchemaError,
    );
    try {
      convertVideoManifestV1(input);
      throw new Error('expected migration schema error');
    } catch (error) {
      expect(error).toBeInstanceOf(VideoAssetMigrationError);
      expect((error as VideoAssetMigrationError).code).toMatch(
        /invalid_manifest_schema|duplicate_asset_id|duplicate_provider_ref/,
      );
    }

    const repository = new VideoAssetManifestRepository({
      readText: () => JSON.stringify(input),
    });
    try {
      await repository.read('/unused');
      throw new Error('expected repository schema error');
    } catch (error) {
      expect(error).toBeInstanceOf(KinoApiError);
      expect((error as KinoApiError).status).toBe(400);
    }
  });
});
