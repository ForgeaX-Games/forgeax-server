import { afterAll, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const root = mkdtempSync(join(tmpdir(), 'studio skills 空间 '));
const engine = join(root, 'engine');
const project = join(root, 'game');
mkdirSync(join(engine, 'templates'), { recursive: true });
mkdirSync(join(engine, 'skills/engine-app'), { recursive: true });
mkdirSync(project);
mock.module('./game-templates', () => ({ resolveEngineTemplatesRoot: () => join(engine, 'templates') }));
const { ensureGameProjectSkills } = await import('./project-skills');
afterAll(() => rmSync(root, { recursive: true, force: true }));
test('packaged adapter installs skills and exact provenance without Engine installer code', async () => {
  writeFileSync(join(engine, 'engine-skills-version.json'), JSON.stringify({ engineCommit: 'a'.repeat(40) }));
  writeFileSync(join(engine, 'skills/engine-app/SKILL.md'), '# Current engine skill');
  await ensureGameProjectSkills(project);
  const manifest = JSON.parse(readFileSync(join(project, '.forgeax/skill-install-manifest.json'), 'utf8'));
  expect(manifest.engineCommit).toBe('a'.repeat(40));
  expect(manifest.mounts).toHaveLength(6);
  for (const mount of manifest.mounts) {
    expect(readFileSync(join(project, mount.root, 'engine-app/SKILL.md'), 'utf8')).toBe('# Current engine skill');
  }
});
