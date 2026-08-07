import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const packageRoot = join(import.meta.dir, '..');
const allowedHostImports = new Set([
  '@forgeax/workbench-host/contracts',
  '@forgeax/workbench-host/node',
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx|js|mjs)$/.test(name) ? [path] : [];
  });
}

describe('workbench host dependency boundary', () => {
  test('pins one compatible local extension and host release set without package-local overrides', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    for (const [packageName, version] of [
      ['@forgeax/workbench-host', '0.2.6'],
      ['@forgeax-extension/wb-game-video', '0.3.2'],
      ['@forgeax-extension/wb-asset-canvas', '0.2.1'],
    ] as const) {
      expect(manifest.dependencies?.[packageName]).toBe(version);
      expect(manifest.overrides?.[packageName]).toBeUndefined();
    }
  });

  test('imports only contracts and node subpaths', () => {
    const violations = sourceFiles(join(packageRoot, 'src')).flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return [...source.matchAll(/(?:from\s+|import\s*\(\s*)['"](@forgeax\/workbench-host[^'"]*)['"]/g)]
        .map((match) => match[1])
        .filter((specifier) => !allowedHostImports.has(specifier))
        .map((specifier) => `${file}: ${specifier}`);
    });
    expect(violations).toEqual([]);
  });
});
