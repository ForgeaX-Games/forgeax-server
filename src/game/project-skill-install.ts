// Studio owns project installation and native agent mounts. Engine supplies
// immutable skill content only; no Engine devkit runtime code is loaded.
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  rename,
  readdir,
  readFile,
  readlink,
  rm,
  rmdir,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

export const PROJECT_SKILL_MOUNT_ROOTS = Object.freeze([
  '.codebuddy/skills',
  '.cursor/skills',
  '.agents/skills',
  '.claude/skills',
  '.workbuddy/skills',
  '.forgeax/skills',
]);
const RETIRED_PROJECT_SKILL_MOUNT_ROOTS = new Set(['.claude-internal/skills']);

const MANIFEST_PATH = '.forgeax/skill-install-manifest.json';
const GITIGNORE_BEGIN = '# BEGIN FORGEAX MANAGED SKILLS';
const GITIGNORE_END = '# END FORGEAX MANAGED SKILLS';

interface InstalledSkill {
  readonly id: string;
  readonly root: string;
  readonly fileCount: number;
  readonly byteCount: number;
}

interface SkillInstallManifest {
  readonly schemaVersion: '1.0.0';
  readonly sourceRoot: 'skills';
  readonly sdkVersion?: string;
  readonly engineCommit?: string;
  readonly skills: readonly InstalledSkill[];
  readonly engineSkills?: Readonly<Record<string, string>>;
  readonly mounts: readonly {
    readonly root: string;
    readonly skills: readonly string[];
  }[];
}

export interface SkillInstallReport {
  readonly root: string;
  readonly sourceRoot: string;
  readonly manifest: string;
  readonly skills: readonly string[];
  readonly mountRoots: readonly string[];
}

function slash(path: string): string {
  return path.split(sep).join('/');
}

function contained(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep);
}

async function pathKind(path: string): Promise<'missing' | 'directory' | 'file' | 'symlink'> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return 'symlink';
    if (info.isDirectory()) return 'directory';
    return 'file';
  } catch (cause) {
    if (cause !== null && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT') {
      return 'missing';
    }
    throw cause;
  }
}

async function filesUnder(root: string, directory = root): Promise<readonly string[]> {
  const files: string[] = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = resolve(directory, name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`skill-source-symlink: ${path}`);
    if (info.isDirectory()) files.push(...(await filesUnder(root, path)));
    else if (info.isFile()) files.push(path);
  }
  return files;
}

async function skillRow(sourceRoot: string, id: string): Promise<InstalledSkill> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`skill-id-invalid: ${id}`);
  const root = resolve(sourceRoot, id);
  if ((await pathKind(root)) !== 'directory') throw new Error(`skill-source-invalid: ${id}`);
  if ((await pathKind(resolve(root, 'SKILL.md'))) !== 'file') {
    throw new Error(`skill-entry-missing: ${id}/SKILL.md`);
  }
  const files = await filesUnder(root);
  return {
    id,
    root: `skills/${id}`,
    fileCount: files.length,
    byteCount: (
      await Promise.all(files.map(async (path) => (await readFile(path)).byteLength))
    ).reduce((sum, bytes) => sum + bytes, 0),
  };
}

async function discoverProjectSkills(root: string): Promise<readonly InstalledSkill[]> {
  const sourceRoot = resolve(root, 'skills');
  if ((await pathKind(sourceRoot)) !== 'directory') throw new Error('project-skills-missing');
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  const ids = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (ids.length === 0) throw new Error('project-skills-empty');
  return Promise.all(ids.map((id) => skillRow(sourceRoot, id)));
}

function expectedLinkTarget(projectRoot: string, mountRoot: string, id: string): string {
  const mountParent = resolve(projectRoot, mountRoot);
  const target = resolve(projectRoot, 'skills', id);
  return process.platform === 'win32' ? target : relative(mountParent, target);
}

async function linkMatches(path: string, target: string): Promise<boolean> {
  if ((await pathKind(path)) !== 'symlink') return false;
  const actual = await readlink(path);
  return resolve(dirname(path), actual) === resolve(dirname(path), target);
}

function updateManagedGitignore(previous: string, skillIds: readonly string[]): string {
  const block = `${GITIGNORE_BEGIN}\n${skillIds.map((id) => `/${id}`).join('\n')}\n${GITIGNORE_END}`;
  const begin = previous.indexOf(GITIGNORE_BEGIN);
  const end = previous.indexOf(GITIGNORE_END);
  if (begin >= 0 && end >= begin) {
    const after = end + GITIGNORE_END.length;
    return `${previous.slice(0, begin)}${block}${previous.slice(after)}`.replace(/^\n+/, '');
  }
  return previous.length === 0 ? `${block}\n` : `${previous.replace(/\s*$/, '')}\n\n${block}\n`;
}

function removeManagedGitignore(previous: string): string {
  const begin = previous.indexOf(GITIGNORE_BEGIN);
  const end = previous.indexOf(GITIGNORE_END);
  if (begin < 0 || end < begin) return previous;
  const before = previous.slice(0, begin).trimEnd();
  const after = previous.slice(end + GITIGNORE_END.length).trimStart();
  const retained = [before, after].filter((part) => part.length > 0).join('\n');
  return retained.length === 0 ? '' : `${retained}\n`;
}

async function removeEmptyDirectory(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (cause) {
    if (
      cause !== null &&
      typeof cause === 'object' &&
      'code' in cause &&
      (cause.code === 'ENOENT' || cause.code === 'ENOTEMPTY' || cause.code === 'EEXIST')
    ) {
      return;
    }
    throw cause;
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (cause) {
    if (cause !== null && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT') {
      return undefined;
    }
    throw cause;
  }
}

async function readInstallManifest(root: string): Promise<SkillInstallManifest | undefined> {
  const value = await readOptional(resolve(root, MANIFEST_PATH));
  return value === undefined ? undefined : (JSON.parse(value) as SkillInstallManifest);
}

export async function installProjectSkills(
  root: string,
  provenance?: { sdkVersion?: string; engineCommit?: string } & { engineSkills?: Readonly<Record<string, string>> },
): Promise<SkillInstallReport> {
  const projectRoot = resolve(root);
  const skills = await discoverProjectSkills(projectRoot);
  const ids = skills.map((skill) => skill.id);
  const priorManifest = await readInstallManifest(projectRoot);
  const desiredLinks = PROJECT_SKILL_MOUNT_ROOTS.flatMap((mountRoot) =>
    ids.map((id) => ({
      path: resolve(projectRoot, mountRoot, id),
      target: expectedLinkTarget(projectRoot, mountRoot, id),
    })),
  );
  const desiredPaths = new Set(desiredLinks.map((entry) => entry.path));
  const desiredMountRoots = new Set<string>(PROJECT_SKILL_MOUNT_ROOTS);
  const retiredMountRoots = (priorManifest?.mounts ?? [])
    .map((mount) => mount.root)
    .filter(
      (mountRoot) =>
        !desiredMountRoots.has(mountRoot) && RETIRED_PROJECT_SKILL_MOUNT_ROOTS.has(mountRoot),
    );
  const staleLinks = (priorManifest?.mounts ?? [])
    .flatMap((mount) =>
      mount.skills.map((id) => ({
        path: resolve(projectRoot, mount.root, id),
        target: expectedLinkTarget(projectRoot, mount.root, id),
      })),
    )
    .filter((entry) => !desiredPaths.has(entry.path));

  for (const entry of desiredLinks) {
    const kind = await pathKind(entry.path);
    if (kind !== 'missing' && !(await linkMatches(entry.path, entry.target))) {
      throw new Error(`skill-mount-conflict: ${slash(relative(projectRoot, entry.path))}`);
    }
  }
  for (const entry of staleLinks) {
    const kind = await pathKind(entry.path);
    if (kind !== 'missing' && !(await linkMatches(entry.path, entry.target))) {
      throw new Error(`skill-stale-mount-conflict: ${slash(relative(projectRoot, entry.path))}`);
    }
  }

  const ignoreSnapshots = new Map<string, string | undefined>();
  const createdLinks: string[] = [];
  const removedLinks: { path: string; target: string }[] = [];
  const manifestPath = resolve(projectRoot, MANIFEST_PATH);
  const priorManifestText = await readOptional(manifestPath);
  try {
    for (const entry of staleLinks) {
      if ((await pathKind(entry.path)) === 'symlink') {
        await rm(entry.path);
        removedLinks.push(entry);
      }
    }
    for (const mountRoot of retiredMountRoots) {
      const mountParent = resolve(projectRoot, mountRoot);
      const ignorePath = resolve(mountParent, '.gitignore');
      const previous = await readOptional(ignorePath);
      ignoreSnapshots.set(ignorePath, previous);
      if (previous !== undefined) {
        const retained = removeManagedGitignore(previous);
        if (retained.length === 0) await rm(ignorePath);
        else await writeFile(ignorePath, retained);
      }
      await removeEmptyDirectory(mountParent);
      await removeEmptyDirectory(dirname(mountParent));
    }
    for (const mountRoot of PROJECT_SKILL_MOUNT_ROOTS) {
      const mountParent = resolve(projectRoot, mountRoot);
      await mkdir(mountParent, { recursive: true });
      const ignorePath = resolve(mountParent, '.gitignore');
      const previous = await readOptional(ignorePath);
      ignoreSnapshots.set(ignorePath, previous);
      await writeFile(ignorePath, updateManagedGitignore(previous ?? '', ids));
      for (const id of ids) {
        const path = resolve(mountParent, id);
        if ((await pathKind(path)) === 'missing') {
          const target = expectedLinkTarget(projectRoot, mountRoot, id);
          await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');
          createdLinks.push(path);
        }
      }
    }
    const sdkVersion = provenance?.sdkVersion ?? priorManifest?.sdkVersion;
    const engineCommit = provenance?.engineCommit ?? priorManifest?.engineCommit;
    const engineSkills = provenance?.engineSkills ?? priorManifest?.engineSkills;
    const manifest: SkillInstallManifest = {
      schemaVersion: '1.0.0',
      sourceRoot: 'skills',
      ...(sdkVersion === undefined ? {} : { sdkVersion }),
      ...(engineCommit === undefined ? {} : { engineCommit }),
      skills,
      ...(engineSkills ? { engineSkills } : {}),
      mounts: PROJECT_SKILL_MOUNT_ROOTS.map((mountRoot) => ({ root: mountRoot, skills: ids })),
    };
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (cause) {
    await Promise.all(createdLinks.map((path) => rm(path, { force: true })));
    await Promise.all(
      removedLinks.map(async ({ path, target }) => {
        await mkdir(dirname(path), { recursive: true });
        await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');
      }),
    );
    await Promise.all(
      [...ignoreSnapshots].map(async ([path, value]) => {
        if (value === undefined) await rm(path, { force: true });
        else {
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, value);
        }
      }),
    );
    if (priorManifestText === undefined) await rm(manifestPath, { force: true });
    else await writeFile(manifestPath, priorManifestText);
    throw cause;
  }
  return {
    root: projectRoot,
    sourceRoot: resolve(projectRoot, 'skills'),
    manifest: manifestPath,
    skills: ids,
    mountRoots: PROJECT_SKILL_MOUNT_ROOTS,
  };
}

export async function verifyProjectSkills(root: string): Promise<SkillInstallReport> {
  const projectRoot = resolve(root);
  const skills = await discoverProjectSkills(projectRoot);
  const ids = skills.map((skill) => skill.id);
  const manifest = await readInstallManifest(projectRoot);
  if (manifest === undefined) throw new Error('skill-install-manifest-missing');
  if (
    manifest.schemaVersion !== '1.0.0' ||
    manifest.sourceRoot !== 'skills' ||
    JSON.stringify(manifest.skills) !== JSON.stringify(skills) ||
    JSON.stringify(manifest.mounts.map((mount) => mount.root)) !==
      JSON.stringify(PROJECT_SKILL_MOUNT_ROOTS)
  ) {
    throw new Error('skill-install-manifest-drift');
  }
  for (const mountRoot of PROJECT_SKILL_MOUNT_ROOTS) {
    const declared = manifest.mounts.find((mount) => mount.root === mountRoot);
    if (declared === undefined || JSON.stringify(declared.skills) !== JSON.stringify(ids)) {
      throw new Error(`skill-install-manifest-mount-drift: ${mountRoot}`);
    }
    const ignore = await readOptional(resolve(projectRoot, mountRoot, '.gitignore'));
    if (ignore === undefined || updateManagedGitignore(ignore, ids) !== ignore) {
      throw new Error(`skill-mount-gitignore-drift: ${mountRoot}`);
    }
    for (const id of ids) {
      const path = resolve(projectRoot, mountRoot, id);
      const target = expectedLinkTarget(projectRoot, mountRoot, id);
      if (!(await linkMatches(path, target))) {
        throw new Error(`skill-mount-drift: ${mountRoot}/${id}`);
      }
    }
  }
  return {
    root: projectRoot,
    sourceRoot: resolve(projectRoot, 'skills'),
    manifest: resolve(projectRoot, MANIFEST_PATH),
    skills: ids,
    mountRoots: PROJECT_SKILL_MOUNT_ROOTS,
  };
}

/** Keep repository-relative links valid after a skill is installed in a game. */
async function installedSkillBytes(file: string, sourceRoot: string): Promise<Buffer> {
  const bytes = await readFile(file);
  if (!file.endsWith('.md')) return bytes;
  const text = bytes.toString('utf8').replace(/\]\(([^)]+)\)/g, (match, href: string) => {
    if (!href.startsWith('../')) return match;
    const [path = '', anchor] = href.split('#');
    const target = resolve(dirname(file), path);
    if (contained(sourceRoot, target)) return match; // sibling project skills remain portable
    return `](<${slash(target)}${anchor ? `#${anchor}` : ''}>)`;
  });
  return Buffer.from(text);
}

/** Sync only unchanged Engine-owned trees. Unknown/custom content is never replaced. */
async function syncEngineProjectSkillsUnlocked(
  projectRoot: string,
  sourceRoot: string,
  provenance: { engineCommit: string; sdkVersion?: string },
): Promise<SkillInstallReport> {
  if ((await pathKind(sourceRoot)) !== 'directory') throw new Error('engine-skills-source-invalid');
  const destinationRoot = resolve(projectRoot, 'skills');
  const destinationKind = await pathKind(destinationRoot);
  if (destinationKind !== 'missing' && destinationKind !== 'directory') throw new Error('project-skills-source-invalid');
  const prior = await readInstallManifest(projectRoot);
  const hashes: Record<string, string> = {};
  const changes: { id: string; source: string; destination: string }[] = [];
  const digest = async (root: string, source = false) => {
    const hash = createHash('sha256');
    for (const file of await filesUnder(root)) {
      hash.update(slash(relative(root, file))).update('\0').update(source ? await installedSkillBytes(file, sourceRoot) : await readFile(file)).update('\0');
    }
    return hash.digest('hex');
  };
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    await skillRow(sourceRoot, entry.name);
    const source = resolve(sourceRoot, entry.name);
    const destination = resolve(projectRoot, 'skills', entry.name);
    const next = await digest(source, true);
    hashes[entry.name] = next;
    const kind = await pathKind(destination);
    if (kind !== 'missing') {
      if (kind !== 'directory') throw new Error(`project-skill-source-conflict: ${entry.name}`);
      const current = await digest(destination);
      if (current === next) continue;
      if (prior?.engineSkills?.[entry.name] !== current) {
        throw new Error(`project-skill-source-conflict: ${entry.name}; preserve or rename the customized skill before syncing`);
      }
    }
    changes.push({ id: entry.name, source, destination });
  }
  if (!Object.keys(hashes).length) throw new Error('engine-skills-empty');
  // Validate every collision before any replacement. Removed upstream skills
  // remain local and lose Engine ownership; this avoids deleting user references.
  await mkdir(destinationRoot, { recursive: true });
  const backup = await mkdtemp(resolve(projectRoot, '.engine-skills-sync-'));
  const moved: string[] = [];
  const created: string[] = [];
  let canRemoveBackup = false;
  try {
    for (const change of changes) {
      if ((await pathKind(change.destination)) !== 'missing') {
        await rename(change.destination, resolve(backup, change.id));
        moved.push(change.id);
      }
      created.push(change.id);
      await cp(change.source, change.destination, { recursive: true, force: false, errorOnExist: true });
      for (const file of await filesUnder(change.source)) {
        if (file.endsWith('.md')) await writeFile(resolve(change.destination, relative(change.source, file)), await installedSkillBytes(file, sourceRoot));
      }
    }
    const report = await installProjectSkills(projectRoot, { ...provenance, engineSkills: hashes });
    canRemoveBackup = true;
    return report;
  } catch (cause) {
    for (const id of created) await rm(resolve(destinationRoot, id), { recursive: true, force: true });
    for (const id of moved) await rename(resolve(backup, id), resolve(destinationRoot, id));
    canRemoveBackup = true;
    throw cause;
  } finally {
    if (canRemoveBackup) await rm(backup, { recursive: true, force: true });
  }
}

/** An exclusive filesystem lock also fences separate server/CLI processes. */
export async function syncEngineProjectSkills(
  projectRoot: string,
  sourceRoot: string,
  provenance: { engineCommit: string; sdkVersion?: string },
): Promise<SkillInstallReport> {
  const lock = resolve(projectRoot, '.engine-skills-sync.lock');
  try { await mkdir(lock); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`engine-skills-sync-in-progress: ${lock}; if the installer process has exited, inspect .engine-skills-sync-* backups before removing this lock directory`);
    throw cause;
  }
  try {
    await writeFile(resolve(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), projectRoot, sourceRoot }));
    return await syncEngineProjectSkillsUnlocked(projectRoot, sourceRoot, provenance);
  } finally {
    await rm(resolve(lock, 'owner.json'), { force: true });
    await rmdir(lock);
  }
}
