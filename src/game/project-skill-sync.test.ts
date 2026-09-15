import { mkdir, mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { syncEngineProjectSkills, verifyProjectSkills } from './project-skill-install';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), '技能 project ')); roots.push(root);
  const source = join(root, 'source'); const project = join(root, 'game');
  await mkdir(join(source, 'engine-app'), { recursive: true });
  await mkdir(project);
  const skill = join(source, 'engine-app/SKILL.md');
  await writeFile(skill, '# v1');
  return { source, project, skill };
}
test('installs, repairs existing project, is idempotent and syncs only owned content', async () => {
  const { source, project, skill } = await fixture();
  await mkdir(join(project, 'skills/custom'), { recursive: true });
  await writeFile(join(project, 'skills/custom/SKILL.md'), '# Mine');
  await syncEngineProjectSkills(project, source, { engineCommit: 'v1' });
  const manifest = join(project, '.forgeax/skill-install-manifest.json');
  const first = await readFile(manifest, 'utf8');
  await syncEngineProjectSkills(project, source, { engineCommit: 'v1' });
  expect(await readFile(manifest, 'utf8')).toBe(first);
  await writeFile(skill, '# v2');
  await syncEngineProjectSkills(project, source, { engineCommit: 'v2' });
  expect(await readFile(join(project, '.agents/skills/engine-app/SKILL.md'), 'utf8')).toBe('# v2');
  expect(await readFile(join(project, 'skills/custom/SKILL.md'), 'utf8')).toBe('# Mine');
  await expect(verifyProjectSkills(project)).resolves.toBeDefined();
  await writeFile(join(project, 'skills/engine-app/SKILL.md'), '# customized');
  await writeFile(skill, '# v3');
  await expect(syncEngineProjectSkills(project, source, { engineCommit: 'v3' })).rejects.toThrow('project-skill-source-conflict');
  expect(await readFile(join(project, 'skills/engine-app/SKILL.md'), 'utf8')).toBe('# customized');
});
test('rejects same-name user skills and linked source roots without mutation', async () => {
  const { source, project } = await fixture();
  await mkdir(join(project, 'skills/engine-app'), { recursive: true });
  await writeFile(join(project, 'skills/engine-app/SKILL.md'), '# Mine');
  await expect(syncEngineProjectSkills(project, source, { engineCommit: 'v1' })).rejects.toThrow('conflict');
  const link = join(project, 'linked');
  await symlink(source, link, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(syncEngineProjectSkills(project, link, { engineCommit: 'v1' })).rejects.toThrow('source-invalid');
});
test('restores old skill content when a native mount conflicts during an upgrade', async () => {
  const { source, project, skill } = await fixture();
  await syncEngineProjectSkills(project, source, { engineCommit: 'v1' });
  const manifest = await readFile(join(project, '.forgeax/skill-install-manifest.json'), 'utf8');
  await rm(join(project, '.agents/skills/engine-app'));
  await mkdir(join(project, '.agents/skills/engine-app'));
  await writeFile(skill, '# v2');
  await expect(syncEngineProjectSkills(project, source, { engineCommit: 'v2' })).rejects.toThrow('skill-mount-conflict');
  expect(await readFile(join(project, 'skills/engine-app/SKILL.md'), 'utf8')).toBe('# v1');
  expect(await readFile(join(project, '.forgeax/skill-install-manifest.json'), 'utf8')).toBe(manifest);
});

test("concurrent requests cannot remove one another's installed skills", async () => {
  const { source, project } = await fixture();
  const results = await Promise.allSettled([
    syncEngineProjectSkills(project, source, { engineCommit: 'v1' }),
    syncEngineProjectSkills(project, source, { engineCommit: 'v1' }),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(await readFile(join(project, 'skills/engine-app/SKILL.md'), 'utf8')).toBe('# v1');
  await expect(verifyProjectSkills(project)).resolves.toBeDefined();
});

test('installed skill links resolve to the matching Engine reference files', async () => {
  const { source, project, skill } = await fixture();
  const schema = join(source, '../packages/app/schema.json');
  await mkdir(join(source, '../packages/app'), { recursive: true });
  await writeFile(schema, '{}');
  await writeFile(skill, '[Schema](../../packages/app/schema.json)');
  await syncEngineProjectSkills(project, source, { engineCommit: 'v1' });
  const installed = await readFile(join(project, 'skills/engine-app/SKILL.md'), 'utf8');
  expect(installed).toContain(schema.replaceAll('\\', '/').replace('/source/..', ''));
});


test('product guidance shares native mounts but keeps independent ownership and user edits', async () => {
  const { source, project, skill } = await fixture();
  await syncEngineProjectSkills(project, source, { engineCommit: 'v1' });
  const id = 'forgeax-studio-game-authoring';
  const manifest = JSON.parse(await readFile(join(project, '.forgeax/skill-install-manifest.json'), 'utf8'));
  expect(manifest.productSkills[id]).toBeString();
  expect(manifest.engineSkills[id]).toBeUndefined();
  expect(await readFile(join(project, '.agents/skills', id, 'SKILL.md'), 'utf8'))
    .toBe(await readFile(join(project, 'skills', id, 'SKILL.md'), 'utf8'));
  await writeFile(join(project, 'skills', id, 'SKILL.md'), '# My edited authoring instructions');
  await writeFile(skill, '# v2');
  await expect(syncEngineProjectSkills(project, source, { engineCommit: 'v2' })).rejects.toThrow('project-skill-source-conflict');
  expect(await readFile(join(project, 'skills/engine-app/SKILL.md'), 'utf8')).toBe('# v1');
  expect(await readFile(join(project, 'skills', id, 'SKILL.md'), 'utf8')).toBe('# My edited authoring instructions');
});

test('Studio installs the asset skill by default without the standalone connector', async () => {
  const { source, project } = await fixture();
  await syncEngineProjectSkills(project, source, { engineCommit: 'v1' });
  const installed = await readFile(join(project, '.agents/skills/forgeax-studio-asset-library/SKILL.md'), 'utf8');
  expect(installed).toContain('search_game_assets');
  expect(installed).toContain('editor.importAsset');
  expect(installed).toContain('defaults\nto EA');
  expect(installed).not.toContain('@forgeax/game');
});
