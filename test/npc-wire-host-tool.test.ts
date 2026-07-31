import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gameHostTools } from '../src/game/host-tools';

function npcWireTool() {
  const tool = gameHostTools().find((item) => item.name === 'npc_wire');
  if (!tool?.run) throw new Error('npc_wire host tool not registered');
  return tool;
}

const affordances = [
  { action: 'walk_to', params: { waypoint: { type: 'enum', source: 'waypoint' } } },
  { action: 'speak', params: { topic: { type: 'enum', source: 'literal', values: ['greeting'] } } },
];

describe('npc_wire host tool', () => {
  test('creates one NPC folder and is idempotent', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'fx-npc-wire-'));
    try {
      mkdirSync(join(projectRoot, '.forgeax', 'games', 'village'), { recursive: true });
      const args = { game: 'village', npcId: 'guide.01', soulId: 'village.guide.01', affordances };
      const tool = npcWireTool();
      const first = await tool.run!(args, { projectRoot, agentId: 'forge' }) as Record<string, unknown>;
      const second = await tool.run!(args, { projectRoot, agentId: 'forge' }) as Record<string, unknown>;
      const npcPath = '.forgeax/games/village/src/npcs/guide.01/index.ts';
      const registryPath = '.forgeax/games/village/src/npcs/index.ts';
      const adapterPath = '.forgeax/games/village/src/npc-brain.ts';
      const source = readFileSync(join(projectRoot, npcPath), 'utf8');
      const registry = readFileSync(join(projectRoot, registryPath), 'utf8');
      const adapter = readFileSync(join(projectRoot, adapterPath), 'utf8');

      expect(first).toEqual({
        ok: true,
        created: true,
        changedPaths: [
          '.forgeax/games/village/package.json',
          '.forgeax/games/village/forge.json',
          npcPath,
          registryPath,
          adapterPath,
        ],
        path: npcPath,
        registryPath,
        adapterPath,
      });
      expect(second).toEqual({
        ok: true,
        created: false,
        changedPaths: [],
        path: npcPath,
        registryPath,
        adapterPath,
      });
      expect(source).toContain('soulId: "village.guide.01"');
      expect(source).toContain('affordances: [');
      expect(registry).toContain("from './guide.01'");
      expect(adapter).toContain("from '@forgeax/npc-client'");
      expect(adapter).toContain('export interface NpcBodyExecutor');
      expect(adapter).toContain('export function installNpcBrainSystem');
      expect(adapter).toContain("world.addSystem(Update");
      expect(adapter).toContain("callbacks.onFallback(npcId, 'NPC intent expired')");
      expect(JSON.parse(readFileSync(join(projectRoot, '.forgeax/games/village/package.json'), 'utf8')))
        .toMatchObject({ dependencies: { '@forgeax/npc-client': 'workspace:*' } });
      expect(JSON.parse(readFileSync(join(projectRoot, '.forgeax/games/village/forge.json'), 'utf8')))
        .toMatchObject({ id: 'village', npc: { enabled: true, entry: 'src/npc-brain.ts' } });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('updates only one NPC marker region and preserves its game-owned hooks', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'fx-npc-wire-update-'));
    try {
      mkdirSync(join(projectRoot, '.forgeax', 'games', 'village'), { recursive: true });
      const tool = npcWireTool();
      await tool.run!(
        { game: 'village', npcId: 'guide', soulId: 'village.guide', affordances },
        { projectRoot, agentId: 'forge' },
      );
      const file = join(projectRoot, '.forgeax', 'games', 'village', 'src', 'npcs', 'guide', 'index.ts');
      writeFileSync(file, `${readFileSync(file, 'utf8')}\nexport const userHook = 'keep';\n`);

      const result = await tool.run!(
        { game: 'village', npcId: 'guide', soulId: 'village.elder', affordances: [{ action: 'wave' }] },
        { projectRoot, agentId: 'forge' },
      ) as Record<string, unknown>;
      const source = readFileSync(file, 'utf8');

      expect(result.changedPaths).toEqual(['.forgeax/games/village/src/npcs/guide/index.ts']);
      expect(source).toContain("export const userHook = 'keep'");
      expect(source).toContain('soulId: "village.elder"');
      expect(source).not.toContain('soulId: "village.guide"');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('adding another NPC keeps the first definition and updates only the registry', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'fx-npc-wire-add-'));
    try {
      mkdirSync(join(projectRoot, '.forgeax', 'games', 'village'), { recursive: true });
      const tool = npcWireTool();
      await tool.run!(
        { game: 'village', npcId: 'guide', soulId: 'village.guide', affordances },
        { projectRoot, agentId: 'forge' },
      );
      const firstFile = join(projectRoot, '.forgeax', 'games', 'village', 'src', 'npcs', 'guide', 'index.ts');
      const firstSource = readFileSync(firstFile, 'utf8');
      const adapterFile = join(projectRoot, '.forgeax', 'games', 'village', 'src', 'npc-brain.ts');
      const adapterSource = readFileSync(adapterFile, 'utf8');
      const result = await tool.run!(
        { game: 'village', npcId: 'merchant', soulId: 'village.merchant', affordances: [{ action: 'wave' }] },
        { projectRoot, agentId: 'forge' },
      ) as Record<string, unknown>;
      const registry = readFileSync(
        join(projectRoot, '.forgeax', 'games', 'village', 'src', 'npcs', 'index.ts'),
        'utf8',
      );

      expect(readFileSync(firstFile, 'utf8')).toBe(firstSource);
      expect(readFileSync(adapterFile, 'utf8')).toBe(adapterSource);
      expect(result.changedPaths).toEqual([
        '.forgeax/games/village/src/npcs/merchant/index.ts',
        '.forgeax/games/village/src/npcs/index.ts',
      ]);
      expect(registry).toContain("from './guide'");
      expect(registry).toContain("from './merchant'");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('uses a relative file dependency when the workspace NPC SDK exists', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'fx-npc-wire-dep-'));
    try {
      mkdirSync(join(projectRoot, 'packages', 'npc-client'), { recursive: true });
      writeFileSync(join(projectRoot, 'packages', 'npc-client', 'package.json'), '{}');
      mkdirSync(join(projectRoot, '.forgeax', 'games', 'village'), { recursive: true });
      await npcWireTool().run!(
        { game: 'village', npcId: 'guide', soulId: 'village.guide', affordances },
        { projectRoot, agentId: 'forge' },
      );
      const pkg = JSON.parse(readFileSync(join(projectRoot, '.forgeax', 'games', 'village', 'package.json'), 'utf8'));
      expect(pkg.dependencies['@forgeax/npc-client']).toBe('file:../../../packages/npc-client');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('rejects malformed package or forge config before writing generated source', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'fx-npc-wire-json-'));
    try {
      const gameDir = join(projectRoot, '.forgeax', 'games', 'village');
      mkdirSync(gameDir, { recursive: true });
      writeFileSync(join(gameDir, 'package.json'), '{bad');
      const result = await npcWireTool().run!(
        { game: 'village', npcId: 'guide', soulId: 'village.guide', affordances },
        { projectRoot, agentId: 'forge' },
      ) as Record<string, unknown>;
      expect(result).toMatchObject({ ok: false, changedPaths: [] });
      expect(() => readFileSync(join(gameDir, 'src', 'npcs', 'guide', 'index.ts'), 'utf8')).toThrow();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('refuses traversal, unsafe NPC directory names, invalid affordances, and unmanaged adapter overwrite', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'fx-npc-wire-safe-'));
    try {
      const tool = npcWireTool();
      expect(await tool.run!(
        { game: '../outside', npcId: 'guide', soulId: 'village.guide', affordances: [{ action: 'wave' }] },
        { projectRoot, agentId: 'forge' },
      )).toMatchObject({ ok: false });

      mkdirSync(join(projectRoot, '.forgeax', 'games', 'village', 'src'), { recursive: true });
      expect(await tool.run!(
        { game: 'village', npcId: 'guide', soulId: 'village.guide', affordances: [{ action: '../bad' }] },
        { projectRoot, agentId: 'forge' },
      )).toMatchObject({ ok: false });
      expect(await tool.run!(
        { game: 'village', npcId: 'guide:../../outside', soulId: 'village.guide', affordances: [{ action: 'wave' }] },
        { projectRoot, agentId: 'forge' },
      )).toMatchObject({ ok: false });

      const file = join(projectRoot, '.forgeax', 'games', 'village', 'src', 'npc-brain.ts');
      writeFileSync(file, 'export const userOwned = true;\n');
      const result = await tool.run!(
        { game: 'village', npcId: 'guide', soulId: 'village.guide', affordances: [{ action: 'wave' }] },
        { projectRoot, agentId: 'forge' },
      ) as Record<string, unknown>;
      expect(result).toMatchObject({ ok: false, changedPaths: [] });
      expect(readFileSync(file, 'utf8')).toBe('export const userOwned = true;\n');
      expect(() => readFileSync(
        join(projectRoot, '.forgeax', 'games', 'village', 'src', 'npcs', 'guide', 'index.ts'),
        'utf8',
      )).toThrow();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('injects markers into an existing @forgeax/npc-client adapter without wiping Body code', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'fx-npc-wire-inject-'));
    try {
      mkdirSync(join(projectRoot, '.forgeax', 'games', 'village', 'src'), { recursive: true });
      const file = join(projectRoot, '.forgeax', 'games', 'village', 'src', 'npc-brain.ts');
      writeFileSync(
        file,
        [
          "import { NpcClient } from '@forgeax/npc-client';",
          '',
          'export class VillageBody {',
          "  run() { return 'keep-body'; }",
          '}',
          '',
        ].join('\n'),
      );
      const tool = npcWireTool();
      const first = await tool.run!(
        { game: 'village', npcId: 'guide', soulId: 'village.guide', affordances },
        { projectRoot, agentId: 'forge' },
      ) as Record<string, unknown>;
      const afterInject = readFileSync(file, 'utf8');
      const second = await tool.run!(
        { game: 'village', npcId: 'guide', soulId: 'village.elder', affordances: [{ action: 'wave' }] },
        { projectRoot, agentId: 'forge' },
      ) as Record<string, unknown>;
      const afterUpsert = readFileSync(file, 'utf8');

      expect(first).toMatchObject({
        ok: true,
        created: true,
        changedPaths: [
          '.forgeax/games/village/package.json',
          '.forgeax/games/village/forge.json',
          '.forgeax/games/village/src/npcs/guide/index.ts',
          '.forgeax/games/village/src/npcs/index.ts',
          '.forgeax/games/village/src/npc-brain.ts',
        ],
      });
      expect(afterInject).toContain('// <forgeax:npc-brain-config>');
      expect(afterInject).toContain("export class VillageBody");
      expect(afterInject).toContain("return 'keep-body'");
      expect(afterInject).toContain("from './npcs'");
      expect(afterInject).toContain('npcs: npcDefinitions');
      expect(second).toMatchObject({ ok: true, created: false });
      expect(afterUpsert).toContain("export class VillageBody");
      expect(afterUpsert).toContain('npcs: npcDefinitions');
      expect(afterUpsert).not.toContain('soulId:');
      const npcSource = readFileSync(
        join(projectRoot, '.forgeax', 'games', 'village', 'src', 'npcs', 'guide', 'index.ts'),
        'utf8',
      );
      expect(npcSource).toContain('soulId: "village.elder"');
      expect(npcSource).not.toContain('soulId: "village.guide"');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
