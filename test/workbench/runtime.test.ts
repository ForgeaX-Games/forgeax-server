import { describe, expect, test } from 'bun:test';
import type { WorkbenchHost } from '@forgeax/workbench-host/node';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createForgeaxWorkbenchHostGetter,
  FORGEAX_KINO_VIDEO_CAPABILITY,
  resolveInstalledWorkbenchPackage,
  WORKBENCH_EXTENSIONS,
  type ForgeaxWorkbenchHostDependencies,
} from '../../src/workbench/runtime';
import { scanExtensionSource } from '@forgeax/workbench-host/node';

describe('createForgeaxWorkbenchHostGetter', () => {
  test('resolves the installed extension from the server package boundary', async () => {
    const source = await resolveInstalledWorkbenchPackage('@forgeax-extension/wb-game-video');
    expect(source.kind).toBe('directory');
    const scanned = await scanExtensionSource(source);
    expect(scanned.manifest).toMatchObject({
      id: '@forgeax-extension/wb-game-video',
      version: '0.3.2',
    });
  });

  test('uses the wb-game-video workspace backend in web development', async () => {
    const source = await resolveInstalledWorkbenchPackage(
      '@forgeax-extension/wb-game-video',
      { startupProfile: 'web-dev' },
    );
    expect(source.kind).toBe('directory');
    const scanned = await scanExtensionSource(source);
    expect(scanned.packageRoot).toEndWith('/packages/marketplace/extensions/wb-game-video');
    expect(scanned.manifest).toMatchObject({
      id: '@forgeax-extension/wb-game-video',
      version: '0.3.2',
    });
  });

  test('installed wb-game-video does not reference legacy Studio protocols', async () => {
    const source = await resolveInstalledWorkbenchPackage('@forgeax-extension/wb-game-video');
    const scanned = await scanExtensionSource(source);
    // Inspect the package manifest and executable entrypoints only. The release
    // contains hundreds of built-in media files; recursively reading every
    // asset makes this boundary test needlessly slow and flaky.
    const text = (await Promise.all([
      'forgeax-extension.json',
      'package.json',
      'dist/index.js',
      'dist/server/host.js',
    ].map((relativePath) => readFile(join(scanned.packageRoot, relativePath), 'utf8')))).join('\n');

    for (const forbidden of [
      '/__gva__',
      '/__ce-api__',
      '/api/game-host',
      'FORGEAX_SERVER_PORT',
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  test('packages and registers the exact wb-game-video release once', async () => {
    const calls: string[] = [];
    const host = { catalog: async () => [] } as unknown as WorkbenchHost;
    const dependencies: ForgeaxWorkbenchHostDependencies = {
      packageExtension(specifier) {
        calls.push(`package:${specifier}`);
        return { kind: 'package', specifier } as never;
      },
      async scanExtensionSource(source) {
        calls.push('scan');
        return {
          root: '/extension',
          manifestPath: '/extension/forgeax-extension.json',
          manifest: {
            id: '@forgeax-extension/wb-game-video',
            version: '0.3.2',
            name: 'Video Game',
            entrypoints: { browser: 'dist/index.js', host: 'dist/server/host.js' },
          },
        } as never;
      },
      createRuntimeRegistry: () => ({
        register(source: any) {
          calls.push(`register:${source.manifest.id}@${source.manifest.version}`);
          return { runtimeId: 'runtime-video' };
        },
      }) as never,
      async createAdapters(_options, runtimeId) {
        calls.push(`adapters:${runtimeId}`);
        return {
          workspace: {} as never,
          versioning: {} as never,
          media: {} as never,
          models: {} as never,
          capabilities: { forGame: () => ({ invoke: async () => undefined }) },
          providerExtensions: [{ extensionId: '@forgeax-extension/kino-video-provider' }] as never,
          capabilitySelections: FORGEAX_KINO_VIDEO_CAPABILITY,
        };
      },
      createWorkbenchHost(options) {
        expect(options.capabilities).toBeDefined();
        calls.push(`host:${options.capabilitySelections?.[0]?.providerId}:${options.providerExtensions?.[0]?.extensionId}`);
        void options.isExtensionTrusted?.({
          runtimeId: 'runtime-video',
          root: '/extension',
          manifest: {
            id: '@forgeax-extension/wb-game-video',
            version: '0.3.2',
            name: 'Video Game',
            entrypoints: { browser: 'dist/index.js', host: 'dist/server/host.js' },
          },
        } as never);
        return host;
      },
    };
    const getter = createForgeaxWorkbenchHostGetter(dependencies);
    const options = {
      projectRoot: '/project',
      mediaService: {} as never,
      modelRouter: {} as never,
    };

    expect(await getter(options)).toBe(host);
    expect(await getter(options)).toBe(host);
    expect(calls).toEqual([
      'package:@forgeax-extension/wb-game-video',
      'scan',
      'register:@forgeax-extension/wb-game-video@0.3.2',
      'adapters:runtime-video',
      'host:arrival-kino:@forgeax-extension/kino-video-provider',
    ]);
  });

  test('fails closed when package identity drifts', async () => {
    const getter = createForgeaxWorkbenchHostGetter({
      packageExtension: () => ({}) as never,
      scanExtensionSource: async () => ({
        manifest: {
          id: '@forgeax-extension/wb-game-video',
          version: '0.3.0',
        },
      }) as never,
    });

    await expect(getter({
      projectRoot: '/project',
      mediaService: {} as never,
      modelRouter: {} as never,
    })).rejects.toThrow('Expected @forgeax-extension/wb-game-video@0.3.2');
  });

  test('exports the exact handshake extension and provider selection', () => {
    expect(WORKBENCH_EXTENSIONS).toEqual([
      { id: '@forgeax-extension/wb-game-video', version: '0.3.2' },
    ]);
    expect(FORGEAX_KINO_VIDEO_CAPABILITY).toEqual([{
      id: 'media.video.generate',
      version: 1,
      providerId: 'arrival-kino',
    }]);
  });
});
