import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseExtensionPackageManifest } from '@forgeax/toolkit/contracts';

/** Resolve a standard extension package root after validating its public contract. */
export function resolveNativeExtensionPackageRoot(extensionDir: string): string | null {
  const root = resolve(extensionDir);
  const packagePath = join(root, 'package.json');
  const manifestPath = join(root, 'forgeax-extension.json');
  if (!existsSync(packagePath) || !existsSync(manifestPath)) return null;
  try {
    const extensionPackage = parseExtensionPackageManifest(
      JSON.parse(readFileSync(packagePath, 'utf8')),
      JSON.parse(readFileSync(manifestPath, 'utf8')),
    );
    const modulePath = resolve(root, extensionPackage.module);
    const relativeModule = relative(root, modulePath);
    if (relativeModule === '..' || relativeModule.startsWith(`..${sep}`) || isAbsolute(relativeModule)) return null;
    if (!existsSync(modulePath)) return null;
    const realRoot = realpathSync(root);
    const realModule = realpathSync(modulePath);
    const realRelativeModule = relative(realRoot, realModule);
    if (realRelativeModule === '..' || realRelativeModule.startsWith(`..${sep}`) || isAbsolute(realRelativeModule)) return null;
    return realRoot;
  } catch {
    return null;
  }
}

/**
 * Resolve only the directory containing a manifest-declared HTML frontend.
 * Missing build artifacts stay missing instead of falling back to Vite source.
 */
export function resolveDeclaredExtensionStaticRoot(
  extensionDir: string,
  frontendEntry: string,
): string | null {
  if (!frontendEntry.toLowerCase().endsWith('.html')) return null;
  const root = resolve(extensionDir);
  const entry = resolve(root, frontendEntry);
  const relativeEntry = relative(root, entry);
  if (relativeEntry === '..' || relativeEntry.startsWith(`..${sep}`) || isAbsolute(relativeEntry)) {
    return null;
  }
  if (!existsSync(entry)) return null;
  // A manifest-declared source shell is a dev-server entry, not an iframe
  // artifact. Serving it as static HTML produces a false-ready blank iframe.
  if (/\/(?:src|node_modules)\//.test(readFileSync(entry, 'utf8'))) return null;
  const realRoot = realpathSync(root);
  const realEntry = realpathSync(entry);
  const realRelativeEntry = relative(realRoot, realEntry);
  if (realRelativeEntry === '..' || realRelativeEntry.startsWith(`..${sep}`) || isAbsolute(realRelativeEntry)) {
    return null;
  }
  return dirname(realEntry);
}

/**
 * Resolve the iframe artifact for either a released HTML entry or a buildable
 * source-module entry. Source modules are host inputs, so they may only resolve
 * to the conventional built dist and are never served directly.
 */
export function resolveExtensionRuntimeStaticRoot(
  extensionDir: string,
  frontendEntry: string,
): string | null {
  if (frontendEntry.toLowerCase().endsWith('.html')) {
    return resolveDeclaredExtensionStaticRoot(extensionDir, frontendEntry);
  }
  return resolveDeclaredExtensionStaticRoot(extensionDir, './dist/index.html');
}
