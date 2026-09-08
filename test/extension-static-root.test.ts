import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveDeclaredExtensionStaticRoot,
  resolveExtensionRuntimeStaticRoot,
  resolveNativeExtensionPackageRoot,
} from '../src/extension-static-root';

describe('declared extension frontend static root', () => {
  test('serves a validated native artifact from its package root', () => {
    const extensionDir = mkdtempSync(join(tmpdir(), 'forgeax-native-extension-'));
    mkdirSync(join(extensionDir, 'dist'));
    writeFileSync(join(extensionDir, 'dist', 'extension.js'), 'export const extension = { apply() {} };');
    writeFileSync(join(extensionDir, 'forgeax-extension.json'), JSON.stringify({
      schemaVersion: 2,
      id: '@forgeax-extension/counter',
      version: '1.0.0',
      displayName: 'Counter',
      entry: { extension: { source: './src/extension.ts', module: './dist/extension.js' } },
      capabilities: { required: [], optional: [] },
      compatibility: { extensionApi: '^1.0.0' },
      contributes: {},
    }));
    writeFileSync(join(extensionDir, 'package.json'), JSON.stringify({
      name: '@forgeax-extension/counter',
      version: '1.0.0',
      type: 'module',
      exports: { '.': './dist/extension.js', './manifest': './forgeax-extension.json', './package.json': './package.json' },
      forgeaxExtension: { schemaVersion: 1, manifest: 'forgeax-extension.json' },
    }));
    expect(resolveNativeExtensionPackageRoot(extensionDir)).toBe(realpathSync(extensionDir));
  });

  test('rejects a native package whose module is missing', () => {
    const extensionDir = mkdtempSync(join(tmpdir(), 'forgeax-native-extension-'));
    writeFileSync(join(extensionDir, 'forgeax-extension.json'), JSON.stringify({
      schemaVersion: 2,
      id: '@forgeax-extension/counter',
      version: '1.0.0',
      displayName: 'Counter',
      entry: { extension: { source: './src/extension.ts', module: './dist/extension.js' } },
      capabilities: { required: [], optional: [] },
      compatibility: { extensionApi: '^1.0.0' },
      contributes: {},
    }));
    writeFileSync(join(extensionDir, 'package.json'), JSON.stringify({
      name: '@forgeax-extension/counter', version: '1.0.0', type: 'module',
      exports: { '.': './dist/extension.js', './manifest': './forgeax-extension.json', './package.json': './package.json' },
      forgeaxExtension: { schemaVersion: 1, manifest: 'forgeax-extension.json' },
    }));
    expect(resolveNativeExtensionPackageRoot(extensionDir)).toBeNull();
  });
  test('does not fall back to source index.html when declared dist is missing', () => {
    const extensionDir = mkdtempSync(join(tmpdir(), 'forgeax-extension-static-'));
    writeFileSync(join(extensionDir, 'index.html'), '<script type="module" src="/src/main.ts"></script>');
    expect(resolveDeclaredExtensionStaticRoot(extensionDir, './dist/index.html')).toBeNull();
  });

  test('serves the directory containing the declared built entry', () => {
    const extensionDir = mkdtempSync(join(tmpdir(), 'forgeax-extension-static-'));
    const dist = join(extensionDir, 'dist');
    mkdirSync(dist);
    writeFileSync(join(dist, 'index.html'), '<script src="./assets/app.js"></script>');
    expect(resolveDeclaredExtensionStaticRoot(extensionDir, './dist/index.html')).toBe(realpathSync(dist));
  });

  test('rejects a manifest-declared source HTML shell that points at /src', () => {
    const extensionDir = mkdtempSync(join(tmpdir(), 'forgeax-extension-static-'));
    writeFileSync(join(extensionDir, 'index.html'), '<script type="module" src="/src/main.ts"></script>');
    expect(resolveDeclaredExtensionStaticRoot(extensionDir, './index.html')).toBeNull();
  });

  test('rejects declared entries outside the extension directory', () => {
    const parent = mkdtempSync(join(tmpdir(), 'forgeax-extension-static-'));
    const extensionDir = join(parent, 'extension');
    mkdirSync(extensionDir);
    writeFileSync(join(parent, 'index.html'), '<main>outside</main>');
    expect(resolveDeclaredExtensionStaticRoot(extensionDir, '../index.html')).toBeNull();
  });

  test('does not treat a host-loaded frontend module as an iframe static root', () => {
    const extensionDir = mkdtempSync(join(tmpdir(), 'forgeax-extension-static-'));
    mkdirSync(join(extensionDir, 'src'));
    writeFileSync(join(extensionDir, 'src/panel.tsx'), 'export default function Panel() {}');
    expect(resolveDeclaredExtensionStaticRoot(extensionDir, './src/panel.tsx')).toBeNull();
  });

  test('maps a host-loaded frontend module to its conventional built iframe artifact', () => {
    const extensionDir = mkdtempSync(join(tmpdir(), 'forgeax-extension-static-'));
    const dist = join(extensionDir, 'dist');
    mkdirSync(dist);
    writeFileSync(join(dist, 'index.html'), '<script src="./assets/app.js"></script>');
    expect(resolveExtensionRuntimeStaticRoot(extensionDir, './src/panel.tsx')).toBe(realpathSync(dist));
  });

  test('keeps a host-loaded frontend module unavailable until its iframe artifact exists', () => {
    const extensionDir = mkdtempSync(join(tmpdir(), 'forgeax-extension-static-'));
    mkdirSync(join(extensionDir, 'src'));
    writeFileSync(join(extensionDir, 'src/panel.tsx'), 'export default function Panel() {}');
    expect(resolveExtensionRuntimeStaticRoot(extensionDir, './src/panel.tsx')).toBeNull();
  });

  test('rejects a declared entry that escapes through a symlink', () => {
    const extensionDir = mkdtempSync(join(tmpdir(), 'forgeax-extension-static-'));
    const outside = mkdtempSync(join(tmpdir(), 'forgeax-extension-outside-'));
    writeFileSync(join(outside, 'index.html'), '<main>outside</main>');
    symlinkSync(outside, join(extensionDir, 'linked'));
    expect(resolveDeclaredExtensionStaticRoot(extensionDir, './linked/index.html')).toBeNull();
  });
});
