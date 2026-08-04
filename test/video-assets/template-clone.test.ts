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
  test('delegates template assets to providers without an upstream catalog', async () => {
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
        return {
          kind: 'cos',
          ref: `https://cos.example.test/${target.gameId}/intro.mp4`,
          upstreamResourceId: 'cos-intro',
        };
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
      ref: 'https://cos.example.test/target/intro.mp4',
      upstreamResourceId: 'cos-intro',
    });
  });

  test('restores videos from the current Kino game scope instead of the template manifest', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'forgeax-video-restore-'));
    roots.push(root);
    const sourceGameDir = resolve(root, 'source');
    const targetGameDir = resolve(root, 'target');
    mkdirSync(resolve(sourceGameDir, 'assets'), { recursive: true });
    mkdirSync(resolve(targetGameDir, 'assets'), { recursive: true });
    const templateVideo = {
      id: 'narr-open',
      kind: 'video',
      name: 'narr-open.mp4',
      status: 'ready',
      mimeType: 'video/mp4',
      bytes: 6,
      createdAt: 1,
      updatedAt: 1,
      provider: { kind: 'cos', ref: 'videos/source/narr-open.mp4' },
    };
    const templateImage = {
      id: 'cover',
      kind: 'image',
      name: 'cover.png',
      status: 'ready',
      mimeType: 'image/png',
      bytes: 6,
      createdAt: 1,
      updatedAt: 1,
      provider: { kind: 'cos', ref: 'images/source/cover.png' },
    };
    writeFileSync(
      resolve(sourceGameDir, 'assets/manifest.json'),
      JSON.stringify({ version: 2, assets: [templateVideo, templateImage] }),
    );
    writeFileSync(
      resolve(targetGameDir, 'assets/manifest.json'),
      JSON.stringify({ version: 2, assets: [templateVideo, templateImage] }),
    );

    const listCalls: Array<{ mediaType: string; gameId: string; page: number; pageSize: number }> = [];
    const provider: VideoAssetProvider = {
      kind: 'kino',
      supportedMediaTypes: ['video', 'image', 'audio'],
      prepareUpload: async () => { throw new Error('unused'); },
      inspectUpload: async () => { throw new Error('unused'); },
      finalizeResource: async () => { throw new Error('unused'); },
      getPlayback: async () => { throw new Error('unused'); },
      delete: async () => {},
      cloneAsset: async () => { throw new Error('must not clone a template asset'); },
      listUpstream: async (mediaType, page, pageSize, context) => {
        listCalls.push({ mediaType, gameId: context.gameId, page, pageSize });
        return {
          items: [{
            upstreamResourceId: 'kino-history',
            name: 'history.mp4',
            url: 'https://kino.example.test/target/history.mp4',
            durationMs: 2400,
            mimeType: 'video/mp4',
            createdAt: 10,
            updatedAt: 20,
          }],
          total: 1,
          page,
          pageSize,
        };
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
      sourceGameId: 'source-template',
      targetGameDir,
      targetGameId: 'target',
    });

    expect(listCalls).toEqual([{
      mediaType: 'video',
      gameId: 'target',
      page: 1,
      pageSize: 100,
    }]);
    const stored = JSON.parse(
      readFileSync(resolve(targetGameDir, 'assets/manifest.json'), 'utf-8'),
    );
    expect(stored.assets.map((asset: { id: string }) => asset.id).sort()).toEqual([
      'cover',
      'kino-history',
    ]);
    expect(stored.assets.find((asset: { id: string }) => asset.id === 'kino-history')).toEqual(
      expect.objectContaining({
        kind: 'video',
        name: 'history.mp4',
        provider: {
          kind: 'kino',
          ref: 'https://kino.example.test/target/history.mp4',
          upstreamResourceId: 'kino-history',
        },
      }),
    );
  });

  test('removes copied template videos when the current Kino game scope is empty', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'forgeax-video-empty-'));
    roots.push(root);
    const sourceGameDir = resolve(root, 'source');
    const targetGameDir = resolve(root, 'target');
    mkdirSync(resolve(sourceGameDir, 'assets'), { recursive: true });
    mkdirSync(resolve(targetGameDir, 'assets'), { recursive: true });
    const manifest = {
      version: 2,
      assets: [{
        id: 'narr-open',
        kind: 'video',
        name: 'narr-open.mp4',
        status: 'ready',
        mimeType: 'video/mp4',
        bytes: 6,
        createdAt: 1,
        updatedAt: 1,
        provider: { kind: 'cos', ref: 'videos/source/narr-open.mp4' },
      }],
    };
    writeFileSync(resolve(sourceGameDir, 'assets/manifest.json'), JSON.stringify(manifest));
    writeFileSync(resolve(targetGameDir, 'assets/manifest.json'), JSON.stringify(manifest));

    const provider: VideoAssetProvider = {
      kind: 'kino',
      prepareUpload: async () => { throw new Error('unused'); },
      inspectUpload: async () => { throw new Error('unused'); },
      finalizeResource: async () => { throw new Error('unused'); },
      getPlayback: async () => { throw new Error('unused'); },
      delete: async () => {},
      listUpstream: async (_mediaType, page, pageSize) => ({
        items: [],
        total: 0,
        page,
        pageSize,
      }),
    };
    const service = new VideoAssetService({
      getProjectRoot: () => root,
      providers: new VideoAssetProviderRegistry(provider),
      manifest: new VideoAssetManifestRepository(),
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
      sourceGameId: 'source-template',
      targetGameDir,
      targetGameId: 'target',
    });

    const stored = JSON.parse(
      readFileSync(resolve(targetGameDir, 'assets/manifest.json'), 'utf-8'),
    );
    expect(stored.assets).toEqual([]);
  });
});
