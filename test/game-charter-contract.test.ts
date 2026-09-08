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
