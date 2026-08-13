import { describe, expect, test } from 'bun:test';
import type { WorkbenchHost } from '@forgeax/workbench-host/node';
import {
  createForgeaxWorkbenchHostGetter,
  type ForgeaxWorkbenchHostDependencies,
} from '../../src/workbench/runtime';

describe('createForgeaxWorkbenchHostGetter', () => {
  test('packages and registers the declared extension release once', async () => {
    const calls: string[] = [];
    const host = { catalog: async () => [] } as unknown as WorkbenchHost;
    const dependencies: ForgeaxWorkbenchHostDependencies = {
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
      createWorkbenchHost(options) {
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
    const getter = createForgeaxWorkbenchHostGetter(dependencies);
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
    const getter = createForgeaxWorkbenchHostGetter({
      extensions: [{ id: 'extension.test', version: '1.0.0' }],
      packageExtension: () => ({ kind: 'package', specifier: 'extension.test' }),
      scanExtensionSource: async () => ({ manifest: { id: 'other.test', version: '1.0.0' } }) as never,
      createRuntimeRegistry: () => ({ register: () => ({ runtimeId: 'runtime-test' }) }) as never,
      createAdapters: async () => ({} as never),
      createWorkbenchHost: () => ({}) as never,
    });

    await expect(getter({
      projectRoot: '/project',
      mediaService: {} as never,
      modelRouter: {} as never,
    })).rejects.toThrow('Expected extension.test@1.0.0');
  });
});
