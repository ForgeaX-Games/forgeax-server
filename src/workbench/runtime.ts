import type { Hono } from 'hono';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createWorkbenchHost,
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
import { createForgeaxWorkbenchCapabilityResolver } from './capability-adapter';
import { createForgeaxMediaCapability } from './media-adapter';
import { createForgeaxModelGateway } from './model-gateway-adapter';

const requireFromServer = createRequire(import.meta.url);

export interface WorkbenchExtensionSpec {
  readonly id: string;
  readonly version: string;
}

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
  readonly extensions: readonly WorkbenchExtensionSpec[];
  createAdapters(
    options: ForgeaxWorkbenchHostOptions,
    runtimeId: string,
  ): ForgeaxWorkbenchHostAdapters | Promise<ForgeaxWorkbenchHostAdapters>;
  createWorkbenchHost(options: WorkbenchHostOptions): WorkbenchHost;
  createRuntimeRegistry(): RuntimeRegistry;
  packageExtension(specifier: string): ExtensionSource | Promise<ExtensionSource>;
  scanExtensionSource: typeof scanExtensionSource;
}

/** Resolve any installed package without importing a product implementation. */
export async function resolveInstalledWorkbenchPackage(
  specifier: string,
  options: { readonly resolvePackage?: (specifier: string) => string } = {},
): Promise<ExtensionSource> {
  const packageName = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0]!;
  let resolvedSpecifier: string;
  try {
    resolvedSpecifier = (options.resolvePackage ?? requireFromServer.resolve)(specifier);
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
      const metadata = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { name?: unknown };
      if (metadata.name === packageName) return { kind: 'directory', path: cursor };
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

export async function createForgeaxWorkbenchAdapters(
  options: ForgeaxWorkbenchHostOptions,
  runtimeId: string,
): Promise<ForgeaxWorkbenchHostAdapters> {
  const media = createForgeaxMediaCapability(options.mediaService, {
    runtimeId,
    projectRoot: options.projectRoot,
  });
  return {
    workspace: createForgeaxWorkspaceAdapter({ projectRoot: options.projectRoot }),
    versioning: createForgeaxVersionAdapter(),
    media,
    capabilities: createForgeaxWorkbenchCapabilityResolver({ projectRoot: options.projectRoot }),
    models: createForgeaxModelGateway(
      createForgeaxCeModelProvider(options.modelRouter),
      media,
    ),
  };
}

export function createForgeaxWorkbenchHostDependencies(options: {
  extensions: readonly WorkbenchExtensionSpec[];
  createAdapters?: ForgeaxWorkbenchHostDependencies['createAdapters'];
  packageExtension?: ForgeaxWorkbenchHostDependencies['packageExtension'];
  scanExtensionSource?: typeof scanExtensionSource;
}): ForgeaxWorkbenchHostDependencies {
  return {
    extensions: options.extensions,
    createAdapters: options.createAdapters ?? createForgeaxWorkbenchAdapters,
    createWorkbenchHost,
    createRuntimeRegistry: () => new RuntimeRegistry(),
    packageExtension: options.packageExtension ?? resolveInstalledWorkbenchPackage,
    scanExtensionSource: options.scanExtensionSource ?? scanExtensionSource,
  };
}

function assertExtensionIdentity(source: ScannedExtension, expected: WorkbenchExtensionSpec): void {
  if (source.manifest.id !== expected.id || source.manifest.version !== expected.version) {
    throw new Error(
      `Expected ${expected.id}@${expected.version}, received ${source.manifest.id}@${source.manifest.version}`,
    );
  }
}

async function createHost(
  options: ForgeaxWorkbenchHostOptions,
  dependencies: ForgeaxWorkbenchHostDependencies,
): Promise<WorkbenchHost> {
  const extensions = await Promise.all(dependencies.extensions.map(async (expected) => {
    const source = await dependencies.packageExtension(expected.id);
    const extension = await dependencies.scanExtensionSource(source);
    assertExtensionIdentity(extension, expected);
    return extension;
  }));
  const registry = dependencies.createRuntimeRegistry();
  const first = extensions[0];
  if (!first) throw new Error('ForgeaX Workbench extensions are not configured');
  const descriptor = registry.register(first);
  for (const extension of extensions.slice(1)) registry.register(extension);
  const adapters = await dependencies.createAdapters(options, descriptor.runtimeId);
  const trusted = new Set(dependencies.extensions.map(({ id, version }) => `${id}@${version}`));
  return dependencies.createWorkbenchHost({
    ...adapters,
    registry,
    isExtensionTrusted: (candidate) => trusted.has(
      `${candidate.manifest.id}@${candidate.manifest.version}`,
    ),
  });
}

export type ForgeaxWorkbenchHostGetter = (
  options: ForgeaxWorkbenchHostOptions,
) => Promise<WorkbenchHost>;

export function createForgeaxWorkbenchHostGetter(
  dependencies: ForgeaxWorkbenchHostDependencies,
): ForgeaxWorkbenchHostGetter {
  let hostPromise: Promise<WorkbenchHost> | undefined;
  return (options) => (hostPromise ??= createHost(options, dependencies));
}
