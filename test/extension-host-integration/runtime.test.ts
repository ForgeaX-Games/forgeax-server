import { describe, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionHost } from '@forgeax/extension-host/node';
import {
  createForgeaxExtensionHostGetter,
  resolveInstalledExtensionPackage,
  type ForgeaxExtensionHostDependencies,
} from '../../src/extension-host-integration/runtime';

test('resolves a data-only extension package through its package metadata', async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), 'forgeax-data-only-extension-'));
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@forgeax-extension/data-only',
    version: '1.0.0',
  }));
  const requested: string[] = [];

  try {
    const source = await resolveInstalledExtensionPackage('@forgeax-extension/data-only', {
      resolvePackage(specifier) {
        requested.push(specifier);
        if (specifier === '@forgeax-extension/data-only/package.json') {
          return join(packageRoot, 'package.json');
        }
        throw new Error(`No root export for ${specifier}`);
      },
    });

    expect(requested).toEqual(['@forgeax-extension/data-only/package.json']);
    expect(source).toEqual({ kind: 'directory', path: await realpath(packageRoot) });
  } finally {
    await rm(packageRoot, { recursive: true });
  }
});

describe('createForgeaxExtensionHostGetter', () => {
  test('packages and registers the declared extension release once', async () => {
    const calls: string[] = [];
    const host = { catalog: async () => [] } as unknown as ExtensionHost;
    const dependencies: ForgeaxExtensionHostDependencies = {
      extensions: [{ id: 'extension.test', version: '1.0.0' }],
      packageExtension(specifier) {
        calls.push(`package:${specifier}`);
        return { kind: 'package', specifier };
      },
      async scanExtensionSource() {
        calls.push('scan');
        return {
          root: '/extension',
          manifestPath: '/extension/forgeax-extension.json',
          manifest: {
            id: 'extension.test',
            version: '1.0.0',
            name: 'Test Extension',
            entrypoints: { browser: 'dist/index.js', host: 'dist/server/host.js' },
          },
        } as never;
      },
      createRuntimeRegistry: () => ({
        register(source: any) {
          calls.push(`register:${source.manifest.id}@${source.manifest.version}`);
          return { runtimeId: 'runtime-test' };
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
        };
      },
      createExtensionHost(options) {
        expect(options.capabilities).toBeDefined();
        calls.push(`host:${String(options.isExtensionTrusted?.({
          runtimeId: 'runtime-test',
          root: '/extension',
          manifest: {
            id: 'extension.test',
            version: '1.0.0',
            name: 'Test Extension',
            entrypoints: { browser: 'dist/index.js', host: 'dist/server/host.js' },
          },
        } as never))}`);
        return host;
      },
    };
    const getter = createForgeaxExtensionHostGetter(dependencies);
    const options = { projectRoot: '/project', mediaService: {} as never, modelRouter: {} as never };

    expect(await getter(options)).toBe(host);
    expect(await getter(options)).toBe(host);
    expect(calls).toEqual([
      'package:extension.test',
      'scan',
      'register:extension.test@1.0.0',
      'adapters:runtime-test',
      'host:true',
    ]);
  });

  test('fails closed when a declared extension identity drifts', async () => {
    const getter = createForgeaxExtensionHostGetter({
      extensions: [{ id: 'extension.test', version: '1.0.0' }],
      packageExtension: () => ({ kind: 'package', specifier: 'extension.test' }),
      scanExtensionSource: async () => ({ manifest: { id: 'other.test', version: '1.0.0' } }) as never,
      createRuntimeRegistry: () => ({ register: () => ({ runtimeId: 'runtime-test' }) }) as never,
      createAdapters: async () => ({} as never),
      createExtensionHost: () => ({}) as never,
    });

    await expect(getter({
      projectRoot: '/project',
      mediaService: {} as never,
      modelRouter: {} as never,
    })).rejects.toThrow('Expected extension.test@1.0.0');
  });

  test('rejects an incompatible required extension', async () => {
    const getter = createForgeaxExtensionHostGetter({
      extensions: [{ id: 'required.test', version: '1.0.0', required: true }],
      packageExtension: () => ({ kind: 'package', specifier: 'required.test' }),
      scanExtensionSource: async () => { throw new Error('manifest schema mismatch'); },
      createRuntimeRegistry: () => ({ register: () => ({ runtimeId: 'runtime-test' }) }) as never,
      createAdapters: async () => ({} as never),
      createExtensionHost: () => ({}) as never,
    });

    await expect(getter({
      projectRoot: '/project',
      mediaService: {} as never,
      modelRouter: {} as never,
    })).rejects.toThrow('manifest schema mismatch');
  });

  test('excludes an incompatible optional extension while keeping compatible extensions', async () => {
    const rejected: string[] = [];
    const registered: string[] = [];
    const getter = createForgeaxExtensionHostGetter({
      extensions: [
        { id: 'compatible.test', version: '1.0.0', required: true },
        { id: 'optional.test', version: '2.0.0', required: false },
      ],
      packageExtension: (specifier) => ({ kind: 'package', specifier }),
      scanExtensionSource: async (source) => {
        if (source.kind === 'package' && source.specifier === 'optional.test') {
          throw new Error('manifest schema mismatch');
        }
        return { manifest: { id: 'compatible.test', version: '1.0.0' } } as never;
      },
      onOptionalExtensionRejected: (extension, error) => {
        rejected.push(`${extension.id}@${extension.version}:${String(error)}`);
      },
      createRuntimeRegistry: () => ({
        register(source: any) {
          registered.push(source.manifest.id);
          return { runtimeId: 'runtime-test' };
        },
      }) as never,
      createAdapters: async () => ({} as never),
      createExtensionHost: () => ({}) as never,
    });

    await getter({
      projectRoot: '/project',
      mediaService: {} as never,
      modelRouter: {} as never,
    });

    expect(registered).toEqual(['compatible.test']);
    expect(rejected).toEqual([
      'optional.test@2.0.0:Error: manifest schema mismatch',
    ]);
  });

  test('excludes an optional extension with duplicate tool ids', async () => {
    const rejected: string[] = [];
    const registered: string[] = [];
    const getter = createForgeaxExtensionHostGetter({
      extensions: [
        { id: 'compatible.test', version: '1.0.0', required: true },
        { id: 'broken.test', version: '1.0.0', required: false },
      ],
      packageExtension: (specifier) => ({ kind: 'package', specifier }),
      scanExtensionSource: async (source) => {
        if (source.kind === 'package' && source.specifier === 'broken.test') {
          return {
            manifest: {
              id: 'broken.test',
              version: '1.0.0',
              tools: [{ id: 'asset.duplicate' }, { id: 'asset.duplicate' }],
            },
          } as never;
        }
        return {
          manifest: {
            id: 'compatible.test',
            version: '1.0.0',
            tools: [],
          },
        } as never;
      },
      onOptionalExtensionRejected: (extension, error) => {
        rejected.push(`${extension.id}@${extension.version}:${String(error)}`);
      },
      createRuntimeRegistry: () => ({
        register(source: any) {
          registered.push(source.manifest.id);
          return { runtimeId: 'runtime-test' };
        },
      }) as never,
      createAdapters: async () => ({} as never),
      createExtensionHost: () => ({}) as never,
    });

    await getter({
      projectRoot: '/project',
      mediaService: {} as never,
      modelRouter: {} as never,
    });

    expect(registered).toEqual(['compatible.test']);
    expect(rejected).toEqual([
      'broken.test@1.0.0:Error: Extension broken.test@1.0.0 declares duplicate tool id: asset.duplicate',
    ]);
  });
});
