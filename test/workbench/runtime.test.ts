import { describe, expect, test } from 'bun:test';
import type { WorkbenchHost } from '@forgeax/workbench-host/node';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import {
  createForgeaxWorkbenchHostGetter,
  resolveInstalledWorkbenchPackage,
  type ForgeaxWorkbenchHostDependencies,
} from '../../src/workbench/runtime';
import { scanExtensionSource } from '@forgeax/workbench-host/node';

describe('createForgeaxWorkbenchHostGetter', () => {
  test('resolves the installed extension from the server package boundary', async () => {
    const source = await resolveInstalledWorkbenchPackage('@forgeax/wb-game-video');
    expect(source.kind).toBe('directory');
    const scanned = await scanExtensionSource(source);
    expect(scanned.manifest).toMatchObject({
      id: '@forgeax/wb-game-video',
      version: '0.2.0',
    });
  });

  test('installed wb-game-video does not reference legacy Studio protocols', async () => {
    const source = await resolveInstalledWorkbenchPackage('@forgeax/wb-game-video');
    const scanned = await scanExtensionSource(source);
    const entries = await readdir(scanned.packageRoot, {
      recursive: true,
      withFileTypes: true,
    });
    const textExtensions = new Set(['.css', '.html', '.js', '.json', '.map', '.ts']);
    const text = (
      await Promise.all(entries
        .filter((entry) => entry.isFile() && textExtensions.has(extname(entry.name)))
        .map((entry) => readFile(join(entry.parentPath, entry.name), 'utf8')))
    ).join('\n');

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
      async scanExtensionSource() {
        calls.push('scan');
        return {
          root: '/extension',
          manifestPath: '/extension/forgeax-extension.json',
          manifest: {
            id: '@forgeax/wb-game-video',
            version: '0.2.0',
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
        };
      },
      createWorkbenchHost(options) {
        calls.push(`host:${options.isExtensionTrusted?.({
          runtimeId: 'runtime-video',
          root: '/extension',
          manifest: {
            id: '@forgeax/wb-game-video',
            version: '0.2.0',
            name: 'Video Game',
            entrypoints: { browser: 'dist/index.js', host: 'dist/server/host.js' },
          },
        } as never)}`);
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
      'package:@forgeax/wb-game-video',
      'scan',
      'register:@forgeax/wb-game-video@0.2.0',
      'adapters:runtime-video',
      'host:true',
    ]);
  });

  test('fails closed when package identity drifts', async () => {
    const getter = createForgeaxWorkbenchHostGetter({
      packageExtension: () => ({}) as never,
      scanExtensionSource: async () => ({
        manifest: {
          id: '@forgeax/wb-game-video',
          version: '0.3.0',
        },
      }) as never,
    });

    await expect(getter({
      projectRoot: '/project',
      mediaService: {} as never,
      modelRouter: {} as never,
    })).rejects.toThrow('Expected @forgeax/wb-game-video@0.2.0');
  });
});
