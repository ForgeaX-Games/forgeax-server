import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type {
  ProviderMapping,
  VideoAssetProvider,
} from '../../src/video-assets/contracts';
import { VideoAssetManifestRepository } from '../../src/video-assets/manifest-repository';
import { VideoAssetProviderRegistry } from '../../src/video-assets/provider-registry';
import { VideoAssetService } from '../../src/video-assets/service';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('VideoAssetService.cloneTemplateAssets', () => {
  test('adds copied template assets to an empty target manifest', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'forgeax-video-clone-'));
    roots.push(root);
    const sourceGameDir = resolve(root, 'source');
    const targetGameDir = resolve(root, 'target');
    mkdirSync(resolve(sourceGameDir, 'assets'), { recursive: true });
    mkdirSync(resolve(targetGameDir, 'assets'), { recursive: true });
    const manifest = {
      version: 2,
      assets: [{
        id: 'intro',
        kind: 'video',
        name: 'intro.mp4',
        status: 'ready',
        mimeType: 'video/mp4',
        bytes: 6,
        createdAt: 1,
        updatedAt: 1,
        provider: { kind: 'cos', ref: 'videos/source/intro.mp4' },
      }],
    };
    writeFileSync(resolve(sourceGameDir, 'assets/manifest.json'), JSON.stringify(manifest));
    writeFileSync(
      resolve(targetGameDir, 'assets/manifest.json'),
      JSON.stringify({ version: 2, assets: [] }),
    );

    const cloneCalls: string[] = [];
    const provider: VideoAssetProvider = {
      kind: 'cos',
      prepareUpload: async () => { throw new Error('unused'); },
      inspectUpload: async () => { throw new Error('unused'); },
      finalizeResource: async () => { throw new Error('unused'); },
      getPlayback: async () => { throw new Error('unused'); },
      delete: async () => {},
      cloneAsset: async (asset, source, target): Promise<ProviderMapping> => {
        cloneCalls.push(`${source.gameId}:${target.gameId}:${asset.id}`);
        return { kind: 'cos', ref: `videos/${target.gameId}/intro.mp4` };
      },
    };
    const repository = new VideoAssetManifestRepository();
    const service = new VideoAssetService({
      getProjectRoot: () => root,
      providers: new VideoAssetProviderRegistry(provider),
      manifest: repository,
      uploadSessions: {
        write: async () => {},
        read: async () => null,
        validate: () => {},
        reserve: async () => { throw new Error('unused'); },
        complete: async () => { throw new Error('unused'); },
      },
    });

    await service.cloneTemplateAssets({
      sourceGameDir,
      sourceGameId: 'source',
      targetGameDir,
      targetGameId: 'target',
    });

    expect(cloneCalls).toEqual(['source:target:intro']);
    const stored = JSON.parse(
      readFileSync(resolve(targetGameDir, 'assets/manifest.json'), 'utf-8'),
    );
    expect(stored.assets[0].provider).toEqual({
      kind: 'cos',
      ref: 'videos/target/intro.mp4',
    });
  });
});
