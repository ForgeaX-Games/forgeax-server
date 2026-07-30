import type { Hono } from 'hono';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  createWorkbenchHost,
  directoryExtension,
  RuntimeRegistry,
  scanExtensionSource,
  type ExtensionSource,
  type ScannedExtension,
  type WorkbenchHost,
  type WorkbenchHostOptions,
} from '@forgeax/workbench-host/node';
import {
  createForgeaxVersionAdapter,
  createForgeaxWorkspaceAdapter,
} from '@forgeax/platform-io';
import type { VideoAssetService } from '../video-assets/service';
import { createForgeaxCeModelProvider } from './ce-model-provider';
import { createForgeaxMediaCapability } from './media-adapter';
import { createForgeaxModelGateway } from './model-gateway-adapter';

const VIDEO_EXTENSION_ID = '@forgeax/wb-game-video';
const VIDEO_EXTENSION_VERSION = '0.2.0';

export interface ForgeaxWorkbenchHostOptions {
  readonly projectRoot: string;
  readonly mediaService: VideoAssetService;
  readonly modelRouter: Hono;
}

export type ForgeaxWorkbenchHostAdapters = Omit<
  WorkbenchHostOptions,
  'registry' | 'isExtensionTrusted'
>;

export interface ForgeaxWorkbenchHostDependencies {
  createAdapters(
    options: ForgeaxWorkbenchHostOptions,
    runtimeId: string,
  ): ForgeaxWorkbenchHostAdapters | Promise<ForgeaxWorkbenchHostAdapters>;
  createWorkbenchHost(options: WorkbenchHostOptions): WorkbenchHost;
  createRuntimeRegistry(): RuntimeRegistry;
  packageExtension(specifier: string): ExtensionSource | Promise<ExtensionSource>;
  scanExtensionSource: typeof scanExtensionSource;
}

const requireFromServer = createRequire(import.meta.url);

export async function resolveInstalledWorkbenchPackage(
  specifier: string,
): Promise<ExtensionSource> {
  const packageName = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0]!;
  let cursor = dirname(await realpath(requireFromServer.resolve(specifier)));
  while (true) {
    const packageJsonPath = join(cursor, 'package.json');
    try {
      const metadata = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
        name?: unknown;
      };
      if (metadata.name === packageName) return directoryExtension(cursor);
    } catch {
      // Continue walking to the package boundary.
    }
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw new Error(`Could not resolve installed workbench package: ${packageName}`);
    }
    cursor = parent;
  }
}

const defaultDependencies: ForgeaxWorkbenchHostDependencies = {
  createAdapters(options, runtimeId) {
    const media = createForgeaxMediaCapability(options.mediaService, { runtimeId });
    return {
      workspace: createForgeaxWorkspaceAdapter({ projectRoot: options.projectRoot }),
      versioning: createForgeaxVersionAdapter(),
      media,
      models: createForgeaxModelGateway(
        createForgeaxCeModelProvider(options.modelRouter),
        media,
      ),
    };
  },
  createWorkbenchHost,
  createRuntimeRegistry: () => new RuntimeRegistry(),
  packageExtension: resolveInstalledWorkbenchPackage,
  scanExtensionSource,
};

function assertVideoExtensionIdentity(source: ScannedExtension): void {
  if (
    source.manifest.id !== VIDEO_EXTENSION_ID
    || source.manifest.version !== VIDEO_EXTENSION_VERSION
  ) {
    throw new Error(
      `Expected ${VIDEO_EXTENSION_ID}@${VIDEO_EXTENSION_VERSION}, received ${source.manifest.id}@${source.manifest.version}`,
    );
  }
}

async function createHost(
  options: ForgeaxWorkbenchHostOptions,
  dependencies: ForgeaxWorkbenchHostDependencies,
): Promise<WorkbenchHost> {
  const packageSource = await dependencies.packageExtension(VIDEO_EXTENSION_ID);
  const extension = await dependencies.scanExtensionSource(packageSource);
  assertVideoExtensionIdentity(extension);

  const registry = dependencies.createRuntimeRegistry();
  const descriptor = registry.register(extension);
  const adapters = await dependencies.createAdapters(options, descriptor.runtimeId);
  return dependencies.createWorkbenchHost({
    ...adapters,
    registry,
    isExtensionTrusted: (candidate) => (
      candidate.manifest.id === VIDEO_EXTENSION_ID
      && candidate.manifest.version === VIDEO_EXTENSION_VERSION
    ),
  });
}

export type ForgeaxWorkbenchHostGetter = (
  options: ForgeaxWorkbenchHostOptions,
) => Promise<WorkbenchHost>;

export function createForgeaxWorkbenchHostGetter(
  overrides: Partial<ForgeaxWorkbenchHostDependencies> = {},
): ForgeaxWorkbenchHostGetter {
  const dependencies = { ...defaultDependencies, ...overrides };
  let hostPromise: Promise<WorkbenchHost> | undefined;
  return (options) => (hostPromise ??= createHost(options, dependencies));
}

export const getForgeaxWorkbenchHost = createForgeaxWorkbenchHostGetter();
