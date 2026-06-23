import { describe, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { $ } from 'bun';

// t4a — scaffold template tsc test (red->green TDD)
//
// Writes the workbench.ts scaffold `main` template to a temp dir,
// creates a minimal tsconfig that can resolve @forgeax/engine-* packages,
// and runs `tsc --noEmit`. Currently RED — the scaffold still emits
// THREE.js `import * as THREE from 'three'`. Turns GREEN after t4b
// rewrites the template to ECS code.

// Layout reference:
//   <worktreeRoot>/                                    ← worktree root
//   <worktreeRoot>/packages/server/test/<this-file>    ← import.meta.dir
//   <worktreeRoot>/packages/server/src/api/workbench.ts
//   <worktreeRoot>/packages/engine/packages/<pkg>/dist/index.d.ts

const WORKTREE_ROOT = resolve(import.meta.dir, '..', '..', '..');
const ENGINE_PKGS = join(WORKTREE_ROOT, 'packages', 'engine', 'packages');

function engineDtsPath(pkg: string): string {
  return join(ENGINE_PKGS, pkg, 'dist', 'index.d.ts');
}

// Find tsc. Bun hoists TypeScript to root node_modules/.bun/typescript@*/...
function findTsc(): string {
  // Try hoisted bun typescript first
  const tsVersions = join(WORKTREE_ROOT, 'node_modules', '.bun');
  try {
    const { readdirSync } = require('node:fs');
    for (const entry of readdirSync(tsVersions)) {
      if (entry.startsWith('typescript@')) {
        const candidate = join(tsVersions, entry, 'node_modules', '.bin', 'tsc');
        try { require('node:fs').accessSync(candidate); return candidate; } catch { /* continue */ }
      }
    }
  } catch { /* .bun dir not found */ }

  // Try engine's tsc
  const engineTsc = join(ENGINE_PKGS, '..', 'node_modules', '.bin', 'tsc');
  return engineTsc;
}

function extractScaffoldSource(): string {
  const workbenchPath = resolve(import.meta.dir, '..', 'src', 'api', 'workbench.ts');
  const raw = require('node:fs').readFileSync(workbenchPath, 'utf-8');

  const marker = 'const main = `';
  const startIdx = raw.indexOf(marker);
  if (startIdx === -1) throw new Error('scaffold marker "const main = `" not found in workbench.ts');

  const contentStart = startIdx + marker.length;

  // Scan for the closing backtick.
  let endIdx = contentStart;
  for (let i = contentStart; i < raw.length; i++) {
    if (raw[i] === '`') { endIdx = i; break; }
  }

  if (endIdx === contentStart) throw new Error('scaffold closing backtick not found');
  return raw.slice(contentStart, endIdx);
}

describe('workbench scaffold — tsc --noEmit', () => {
  test('scaffold template passes tsc --noEmit (AC-07)', async () => {
    // 1. Extract scaffold source
    const scaffoldSrc = extractScaffoldSource();

    // 2. Write scaffold to temp dir as src/main.ts
    const tmpDir = mkdtempSync(join(tmpdir(), 'forgeax-scaffold-'));
    const srcDir = join(tmpDir, 'src');
    require('node:fs').mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, 'main.ts'), scaffoldSrc, 'utf-8');

    // 3. Write a minimal tsconfig that resolves engine packages
    const tsconfig = {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        isolatedModules: true,
        baseUrl: './src',
        paths: {
          '@forgeax/engine-runtime': [engineDtsPath('runtime')],
          '@forgeax/engine-ecs': [engineDtsPath('ecs')],
          '@forgeax/engine-types': [engineDtsPath('types')],
        },
      },
      include: ['src'],
    };

    writeFileSync(join(tmpDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2), 'utf-8');

    // 4. Run tsc --noEmit
    const tscBin = findTsc();
    let result;
    try {
      result = await $`${tscBin} --noEmit --project ${tmpDir} 2>&1`.quiet().nothrow();
    } catch {
      // Not expected — shell invocation of tsc should not throw in bun
      console.log('[t4a] tsc invocation threw unexpectedly');
    }

    if (!result) {
      // Shell-level failure: try bun x as last resort
      result = await $`cd ${tmpDir} && bun x tsc --noEmit 2>&1`.quiet().nothrow();
    }

    // 5. Output for debugging
    if (result!.exitCode !== 0) {
      const stderr = (result!.stderr?.toString() ?? '');
      const stdout = (result!.stdout?.toString() ?? '');
      console.log('[t4a RED] tsc errors:\n' + (stderr || stdout).slice(0, 3000));
    }

    // Cleanup
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }

    // RED phase: expect non-zero; GREEN phase (after t4b): expect 0
    expect(result!.exitCode).toBe(0);
  });
});