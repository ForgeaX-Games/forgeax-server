import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectEngineRoots, engineDevkitCliPath } from '../src/game/packager/engine-roots';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createEngineRoot(root: string, relativePath: string): void {
  const engineRoot = join(root, relativePath);
  mkdirSync(engineRoot, { recursive: true });
  writeFileSync(join(engineRoot, 'package.json'), '{"name":"@forgeax/engine"}\n');
  mkdirSync(join(engineRoot, 'packages', 'devkit', 'dist'), { recursive: true });
  writeFileSync(engineDevkitCliPath(engineRoot), '#!/usr/bin/env bun\n');
}

describe('detectEngineRoots', () => {
  test('accepts Engine workspaces that expose the DevKit CLI', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-engine-roots-'));
    tempRoots.push(root);
    createEngineRoot(root, 'packages/editor/packages/engine');
    createEngineRoot(root, 'packages/engine');

    expect(detectEngineRoots(root)).toEqual([
      {
        path: join(root, 'packages/editor/packages/engine'),
        label: 'engine (editor)',
        valid: true,
        recommended: true,
      },
      {
        path: join(root, 'packages/engine'),
        label: 'engine (standalone)',
        valid: true,
        recommended: false,
      },
    ]);
  });

  test('reports an incomplete Engine workspace without marking it usable', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-engine-roots-'));
    tempRoots.push(root);
    mkdirSync(join(root, 'packages/editor/packages/engine'), { recursive: true });

    expect(detectEngineRoots(root)).toEqual([
      {
        path: join(root, 'packages/editor/packages/engine'),
        label: 'engine (editor)',
        valid: false,
        recommended: false,
      },
    ]);
  });
});
