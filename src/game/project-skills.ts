import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveEngineTemplatesRoot } from './game-templates';
import { syncEngineProjectSkills } from './project-skill-install';

/** The same Engine root supplies templates and skill content; Studio installs it. */
export async function ensureGameProjectSkills(gameDir: string): Promise<void> {
  const engineRoot = dirname(resolveEngineTemplatesRoot());
  const versionFile = join(engineRoot, 'engine-skills-version.json');
  const engineCommit = existsSync(versionFile)
    ? JSON.parse(readFileSync(versionFile, 'utf8')).engineCommit
    : execFileSync('git', ['rev-parse', 'HEAD'], { cwd: engineRoot, encoding: 'utf8' }).trim();
  if (typeof engineCommit !== 'string' || !/^[a-f0-9]{40,64}$/.test(engineCommit)) {
    throw new Error('Engine skills version is missing or invalid');
  }
  await syncEngineProjectSkills(gameDir, join(engineRoot, 'skills'), { engineCommit });
}
