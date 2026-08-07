import type { Hono } from 'hono';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
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
import { providerExtension as arrivalKinoProvider } from '@forgeax-extension/kino-video-provider';
import {
  createForgeaxVersionAdapter,
  createForgeaxWorkspaceAdapter,
} from '@forgeax/platform-io';
import type { VideoAssetService } from '../video-assets/service';
import { createForgeaxCeModelProvider } from './ce-model-provider';
import { createForgeaxMediaCapability } from './media-adapter';
import { createForgeaxModelGateway } from './model-gateway-adapter';
import { createRemoteKinoBinding } from './remote-kino-binding';

export const WORKBENCH_EXTENSIONS = [
  { id: '@forgeax/wb-game-video', version: '0.2.1' },
  { id: '@forgeax-extension/wb-asset-canvas', version: '0.2.0' },
] as const;

export const FORGEAX_KINO_VIDEO_CAPABILITY = [{
  id: 'media.video.generate',
  version: 1,
  providerId: 'arrival-kino',
}] as const;

const ASSET_CANVAS_EXTENSION_SOURCE = '@forgeax-extension/wb-asset-canvas/kino-binding';
const trustedExtensions = new Set(
  WORKBENCH_EXTENSIONS.map(({ id, version }) => `${id}@${version}`),
);

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
  let resolvedSpecifier: string;
  try {
    resolvedSpecifier = requireFromServer.resolve(specifier);
  } catch {
    const resolvedUrl = await import.meta.resolve(specifier);
    if (!resolvedUrl.startsWith('file:')) {
      throw new Error(`Could not resolve installed workbench package: ${packageName}`);
    }
    resolvedSpecifier = fileURLToPath(resolvedUrl);
  }
  let cursor = dirname(await realpath(resolvedSpecifier));
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
  async createAdapters(options, runtimeId) {
    const media = createForgeaxMediaCapability(options.mediaService, { runtimeId });
    return {
      workspace: createForgeaxWorkspaceAdapter({ projectRoot: options.projectRoot }),
      versioning: createForgeaxVersionAdapter(),
      media,
      models: createForgeaxModelGateway(
        createForgeaxCeModelProvider(options.modelRouter),
        media,
      ),
      serviceBindings: [await createRemoteKinoBinding({ projectRoot: options.projectRoot })],
    };
  },
  createWorkbenchHost,
  createRuntimeRegistry: () => new RuntimeRegistry(),
  packageExtension: resolveInstalledWorkbenchPackage,
  scanExtensionSource,
};

function assertExtensionIdentity(
  source: ScannedExtension,
  expected: (typeof WORKBENCH_EXTENSIONS)[number],
): void {
  if (
    source.manifest.id !== expected.id
    || source.manifest.version !== expected.version
  ) {
    throw new Error(
      `Expected ${expected.id}@${expected.version}, received ${source.manifest.id}@${source.manifest.version}`,
    );
  }
}

function packageSourceFor(
  extension: (typeof WORKBENCH_EXTENSIONS)[number],
): string {
  return extension.id === '@forgeax-extension/wb-asset-canvas'
    ? ASSET_CANVAS_EXTENSION_SOURCE
    : extension.id;
}

async function createHost(
  options: ForgeaxWorkbenchHostOptions,
  dependencies: ForgeaxWorkbenchHostDependencies,
): Promise<WorkbenchHost> {
  const extensions = await Promise.all(WORKBENCH_EXTENSIONS.map(async (expected) => {
    const source = await dependencies.packageExtension(packageSourceFor(expected));
    const extension = await dependencies.scanExtensionSource(source);
    assertExtensionIdentity(extension, expected);
    return extension;
  }));

  const registry = dependencies.createRuntimeRegistry();
  const videoExtension = extensions[0];
  if (!videoExtension) throw new Error('ForgeaX Workbench extensions are not configured');
  const descriptor = registry.register(videoExtension);
  for (const extension of extensions.slice(1)) registry.register(extension);
  const adapters = await dependencies.createAdapters(options, descriptor.runtimeId);
  return dependencies.createWorkbenchHost({
    ...adapters,
    registry,
    providerExtensions: [arrivalKinoProvider],
    capabilitySelections: FORGEAX_KINO_VIDEO_CAPABILITY,
    isExtensionTrusted: (candidate) => trustedExtensions.has(
      `${candidate.manifest.id}@${candidate.manifest.version}`,
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
