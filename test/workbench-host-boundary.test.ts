import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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
  test('pins shared host and game-video releases exactly to their vendored artifacts', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    for (const [packageName, artifactName] of [
      ['@forgeax/workbench-host', 'forgeax-workbench-host'],
      ['@forgeax/wb-game-video', 'forgeax-wb-game-video'],
    ] as const) {
      const version = manifest.dependencies?.[packageName];
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);

      const artifact = `vendor/${artifactName}-${version}.tgz`;
      expect(manifest.overrides?.[packageName]).toBe(`file:${artifact}`);
      expect(existsSync(join(packageRoot, artifact))).toBeTrue();
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
