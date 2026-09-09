import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  installProjectSkills,
  PROJECT_SKILL_MOUNT_ROOTS,
  verifyProjectSkills,
} from './project-skill-install';

const roots: string[] = [];

async function projectFixture(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-skill-install-'));
  roots.push(root);
  for (const id of ['forgeax-engine-app', 'forgeax-engine-assets']) {
    await mkdir(resolve(root, 'skills', id), { recursive: true });
    await writeFile(resolve(root, 'skills', id, 'SKILL.md'), `# ${id}\n`);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('project-local skill installation', () => {
  it('mounts one regular skill source into every supported agent discovery root', async () => {
    const root = await projectFixture();

    const installed = await installProjectSkills(root, {
      sdkVersion: '0.0.0-test',
      engineCommit: '0123456789012345678901234567890123456789',
    });

    expect(installed.skills).toEqual(['forgeax-engine-app', 'forgeax-engine-assets']);
    expect(PROJECT_SKILL_MOUNT_ROOTS).not.toContain('.claude-internal/skills');
    for (const mountRoot of PROJECT_SKILL_MOUNT_ROOTS) {
      for (const id of installed.skills) {
        expect((await lstat(resolve(root, mountRoot, id))).isSymbolicLink()).toBe(true);
      }
      const ignore = await readFile(resolve(root, mountRoot, '.gitignore'), 'utf8');
      expect(ignore).toContain('/forgeax-engine-app');
      expect(ignore).toContain('/forgeax-engine-assets');
    }
    await expect(verifyProjectSkills(root)).resolves.toEqual(installed);
  });

  it('repairs a missing managed link and rejects foreign content at a mount path', async () => {
    const root = await projectFixture();
    await installProjectSkills(root);
    const missing = resolve(root, '.agents/skills/forgeax-engine-app');
    await rm(missing);

    await expect(verifyProjectSkills(root)).rejects.toThrow('skill-mount-drift');
    await installProjectSkills(root);
    await expect(verifyProjectSkills(root)).resolves.toMatchObject({ root });

    const conflict = resolve(root, '.cursor/skills/forgeax-engine-assets');
    await rm(conflict);
    await mkdir(conflict);
    await expect(installProjectSkills(root)).rejects.toThrow('skill-mount-conflict');
  });

  it('removes only stale links declared by the prior install manifest', async () => {
    const root = await projectFixture();
    await installProjectSkills(root);
    await rm(resolve(root, 'skills/forgeax-engine-assets'), { recursive: true });
    const foreign = resolve(root, '.agents/skills/user-skill');
    await symlink(
      process.platform === 'win32' ? resolve(root, 'skills/forgeax-engine-app') : relative(resolve(root, '.agents/skills'), resolve(root, 'skills/forgeax-engine-app')),
      foreign,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await installProjectSkills(root);

    await expect(
      lstat(resolve(root, '.agents/skills/forgeax-engine-assets')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await lstat(foreign)).isSymbolicLink()).toBe(true);
    await expect(verifyProjectSkills(root)).resolves.toMatchObject({
      skills: ['forgeax-engine-app'],
    });
  });

  it.each([
    false,
    true,
  ])('retires the legacy Claude-internal mount while preserving foreign content: %s', async (withForeignContent) => {
    const root = await projectFixture();
    const installed = await installProjectSkills(root);
    const legacyMount = '.claude-internal/skills';
    const legacyRoot = resolve(root, legacyMount);
    await mkdir(legacyRoot, { recursive: true });
    for (const id of installed.skills) {
      await symlink(
        process.platform === 'win32' ? resolve(root, 'skills', id) : relative(legacyRoot, resolve(root, 'skills', id)),
        resolve(legacyRoot, id),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    }
    await writeFile(
      resolve(legacyRoot, '.gitignore'),
      '# BEGIN FORGEAX MANAGED SKILLS\n/forgeax-engine-app\n/forgeax-engine-assets\n# END FORGEAX MANAGED SKILLS\n',
    );
    if (withForeignContent) {
      await writeFile(resolve(root, '.claude-internal/settings.json'), '{}\n');
    }
    const manifestPath = resolve(root, '.forgeax/skill-install-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.mounts.push({ root: legacyMount, skills: installed.skills });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(verifyProjectSkills(root)).rejects.toThrow('skill-install-manifest-drift');
    await installProjectSkills(root);

    await expect(lstat(legacyRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    if (withForeignContent) {
      await expect(readFile(resolve(root, '.claude-internal/settings.json'), 'utf8')).resolves.toBe(
        '{}\n',
      );
    } else {
      await expect(lstat(resolve(root, '.claude-internal'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
    await expect(verifyProjectSkills(root)).resolves.toMatchObject({ root });
  });
});
