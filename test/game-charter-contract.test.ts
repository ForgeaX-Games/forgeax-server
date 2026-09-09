import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const charter = readFileSync(join(import.meta.dir, '../src/game/game-charter.md'), 'utf8');

test('minimal ECS examples use the decomposed Engine API and current component fields', () => {
  expect(charter).not.toContain("from '@forgeax/engine-runtime';");
  expect(charter).not.toContain("from '@forgeax/game-types';");
  expect(charter).toContain("from '@forgeax/engine-scene';");
  expect(charter).toContain("from '@forgeax/engine-render';");
  expect(charter).toContain("data: { pos: [0, 0.6, 5] }");
  expect(charter).toContain('data: { materials: [material] }');
  expect(charter).toContain('world.addSystem(Update');
  expect(charter).not.toContain('ctx.registerUpdate');
});

test('new games must keep their fixed startup scene visible after Stop', () => {
  expect(charter).toContain('reachable from the manifest-selected SceneAsset');
  expect(charter).toContain('Stop returns to the same initial scene');
  expect(charter).toContain('dirtyPolicy: "save-then-play"');
  expect(charter).toContain('`last-saved` is never a persistence check');
  expect(charter).toContain('A successful Play frame alone is not persistence evidence');
});
