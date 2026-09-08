import type { Hono } from 'hono';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createExtensionHost,
  RuntimeRegistry,
  scanExtensionSource,
  type ExtensionSource,
  type ScannedExtension,
  type ExtensionHost,
  type ExtensionHostOptions,
} from '@forgeax/extension-host/node';
import {
  createForgeaxVersionAdapter,
  createForgeaxWorkspaceAdapter,
} from '@forgeax/platform-io';
import type { VideoAssetService } from '../video-assets/service';
import { createForgeaxCeModelProvider } from './ce-model-provider';
import { createForgeaxExtensionCapabilityResolver } from './capability-adapter';
import { createForgeaxMediaCapability } from './media-adapter';
import { createForgeaxModelGateway } from './model-gateway-adapter';

const requireFromServer = createRequire(import.meta.url);

export interface HostedExtensionSpec {
  readonly id: string;
  readonly version: string;
  readonly required?: boolean;
}

export interface ForgeaxExtensionHostOptions {
  readonly projectRoot: string;
  readonly mediaService: VideoAssetService;
  readonly modelRouter: Hono;
}

export type ForgeaxExtensionHostAdapters = Omit<
  ExtensionHostOptions,
  'registry' | 'isExtensionTrusted'
>;

export interface ForgeaxExtensionHostDependencies {
  readonly extensions: readonly HostedExtensionSpec[];
  createAdapters(
    options: ForgeaxExtensionHostOptions,
    runtimeId: string,
  ): ForgeaxExtensionHostAdapters | Promise<ForgeaxExtensionHostAdapters>;
  createExtensionHost(options: ExtensionHostOptions): ExtensionHost;
  createRuntimeRegistry(): RuntimeRegistry;
  packageExtension(specifier: string): ExtensionSource | Promise<ExtensionSource>;
  scanExtensionSource: typeof scanExtensionSource;
  onOptionalExtensionRejected?(extension: HostedExtensionSpec, error: unknown): void;
}

/** Resolve any installed package without importing a product implementation. */
export async function resolveInstalledExtensionPackage(
  specifier: string,
  options: { readonly resolvePackage?: (specifier: string) => string } = {},
): Promise<ExtensionSource> {
  const packageName = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0]!;
  const packageMetadataSpecifier = `${packageName}/package.json`;
  let resolvedSpecifier: string;
  try {
    resolvedSpecifier = (options.resolvePackage ?? requireFromServer.resolve)(packageMetadataSpecifier);
  } catch {
    const resolvedUrl = await import.meta.resolve(packageMetadataSpecifier);
    if (!resolvedUrl.startsWith('file:')) {
      throw new Error(`Could not resolve installed extension package: ${packageName}`);
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
      throw new Error(`Could not resolve installed extension package: ${packageName}`);
    }
    cursor = parent;
  }
}

export async function createForgeaxExtensionAdapters(
  options: ForgeaxExtensionHostOptions,
  runtimeId: string,
): Promise<ForgeaxExtensionHostAdapters> {
  const media = createForgeaxMediaCapability(options.mediaService, {
    runtimeId,
    projectRoot: options.projectRoot,
  });
  return {
    workspace: createForgeaxWorkspaceAdapter({ projectRoot: options.projectRoot }),
    versioning: createForgeaxVersionAdapter(),
    media,
    capabilities: createForgeaxExtensionCapabilityResolver({ projectRoot: options.projectRoot }),
    models: createForgeaxModelGateway(
      createForgeaxCeModelProvider(options.modelRouter),
      media,
    ),
  };
}

export function createForgeaxExtensionHostDependencies(options: {
  extensions: readonly HostedExtensionSpec[];
  createAdapters?: ForgeaxExtensionHostDependencies['createAdapters'];
  packageExtension?: ForgeaxExtensionHostDependencies['packageExtension'];
  scanExtensionSource?: typeof scanExtensionSource;
  onOptionalExtensionRejected?: ForgeaxExtensionHostDependencies['onOptionalExtensionRejected'];
}): ForgeaxExtensionHostDependencies {
  return {
    extensions: options.extensions,
    createAdapters: options.createAdapters ?? createForgeaxExtensionAdapters,
    createExtensionHost,
    createRuntimeRegistry: () => new RuntimeRegistry(),
    packageExtension: options.packageExtension ?? resolveInstalledExtensionPackage,
    scanExtensionSource: options.scanExtensionSource ?? scanExtensionSource,
    onOptionalExtensionRejected: options.onOptionalExtensionRejected ?? ((extension, error) => {
      console.warn(
        `[extensions/product] optional extension rejected: ${extension.id}@${extension.version}: ${String(error)}`,
      );
    }),
  };
}

function assertExtensionIdentity(source: ScannedExtension, expected: HostedExtensionSpec): void {
  if (source.manifest.id !== expected.id || source.manifest.version !== expected.version) {
    throw new Error(
      `Expected ${expected.id}@${expected.version}, received ${source.manifest.id}@${source.manifest.version}`,
    );
  }
}

function assertUniqueToolIds(source: ScannedExtension): void {
  const ids = new Set<string>();
  for (const tool of source.manifest.tools ?? []) {
    if (ids.has(tool.id)) {
      throw new Error(
        `Extension ${source.manifest.id}@${source.manifest.version} declares duplicate tool id: ${tool.id}`,
      );
    }
    ids.add(tool.id);
  }
}

async function createHost(
  options: ForgeaxExtensionHostOptions,
  dependencies: ForgeaxExtensionHostDependencies,
): Promise<ExtensionHost> {
  const scanned = await Promise.all(dependencies.extensions.map(async (expected) => {
    try {
      const source = await dependencies.packageExtension(expected.id);
      const extension = await dependencies.scanExtensionSource(source);
      assertExtensionIdentity(extension, expected);
      assertUniqueToolIds(extension);
      return extension;
    } catch (error) {
      if (expected.required !== false) throw error;
      dependencies.onOptionalExtensionRejected?.(expected, error);
      return undefined;
    }
  }));
  const extensions = scanned.filter((extension): extension is ScannedExtension => extension !== undefined);
  const registry = dependencies.createRuntimeRegistry();
  const first = extensions[0];
  if (!first) throw new Error('ForgeaX extensions are not configured');
  const descriptor = registry.register(first);
  for (const extension of extensions.slice(1)) registry.register(extension);
  const adapters = await dependencies.createAdapters(options, descriptor.runtimeId);
  const trusted = new Set(extensions.map(({ manifest }) => `${manifest.id}@${manifest.version}`));
  return dependencies.createExtensionHost({
    ...adapters,
    registry,
    isExtensionTrusted: (candidate) => trusted.has(
      `${candidate.manifest.id}@${candidate.manifest.version}`,
    ),
  });
}

export type ForgeaxExtensionHostGetter = (
  options: ForgeaxExtensionHostOptions,
) => Promise<ExtensionHost>;

export function createForgeaxExtensionHostGetter(
  dependencies: ForgeaxExtensionHostDependencies,
): ForgeaxExtensionHostGetter {
  let hostPromise: Promise<ExtensionHost> | undefined;
  return (options) => (hostPromise ??= createHost(options, dependencies));
}
