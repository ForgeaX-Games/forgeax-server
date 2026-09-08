import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const packageRoot = join(import.meta.dir, '..');
const allowedHostImports = new Set([
  '@forgeax/extension-host/contracts',
  '@forgeax/extension-host/node',
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx|js|mjs)$/.test(name) ? [path] : [];
  });
}

describe('extension host dependency boundary', () => {
  test('does not statically import product extension implementations', () => {
    const violations = sourceFiles(join(packageRoot, 'src')).flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return [...source.matchAll(/from\s+['"](@forgeax-extension\/(?:video-game|asset-canvas|kino-video-provider)[^'"]*)['"]/g)]
        .map((match) => `${file}: ${match[1]}`);
    });
    expect(violations).toEqual([]);
  });

  test('serves extension assets only from the runtime registry snapshot', () => {
    const source = readFileSync(join(packageRoot, 'src/main.ts'), 'utf8');
    expect(source).not.toContain("import { mp,");
    expect(source).not.toContain('Fallback: reconstruct the legacy builtin marketplace path');
    expect(source).not.toContain('mp(id');
  });

  test('pins one compatible local extension and host release set without package-local overrides', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    for (const [packageName, version] of [
      ['@forgeax/extension-host', '0.3.0'],
    ] as const) {
      expect(manifest.dependencies?.[packageName]).toBe(version);
      expect(manifest.overrides?.[packageName]).toBeUndefined();
    }
  });

  test('imports only contracts and node subpaths', () => {
    const violations = sourceFiles(join(packageRoot, 'src')).flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return [...source.matchAll(/(?:from\s+|import\s*\(\s*)['"](@forgeax\/extension-host[^'"]*)['"]/g)]
        .map((match) => match[1])
        .filter((specifier) => !allowedHostImports.has(specifier))
        .map((specifier) => `${file}: ${specifier}`);
    });
    expect(violations).toEqual([]);
  });

  test('does not retain the historical patched host dependency or runtime export', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    expect(manifest.patchedDependencies?.['@forgeax/extension-host@0.2.6']).toBeUndefined();
    expect(manifest.exports?.['./extension/runtime']).toBeUndefined();
  });
});
