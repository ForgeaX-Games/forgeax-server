import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ensureGameProjectDependencies,
  engineDependencyScopePath,
  isLegacyEngineScopeTarget,
  projectDependencyManifestPath,
  ProjectDependencyError,
} from './project-dependencies';

const roots: string[] = [];

function fixture(options: { dependencies?: Record<string, string> } = {}): {
  root: string;
  game: string;
  engine: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-project-dependencies-'));
  roots.push(root);
  const game = join(root, 'game');
  const engine = join(root, 'engine');
  mkdirSync(game, { recursive: true });
  writeFileSync(
    join(game, 'package.json'),
    JSON.stringify({ name: 'game', private: true, dependencies: options.dependencies ?? { '@forgeax/engine': 'workspace:*' } }),
  );
  return { root, game, engine };
}

function materializeEngine(engine: string, packages = ['@forgeax/engine']): string {
  const scope = engineDependencyScopePath(engine);
  for (const name of packages) {
    const packageDir = join(scope, name.slice('@forgeax/'.length));
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name }));
  }
  return scope;
}

function managedLinkTarget(game: string): string {
  return resolve(game, 'node_modules', '@forgeax');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('product-managed Engine dependency links', () => {
  test('links the current Engine scope and records ownership/provenance', async () => {
    const { game, engine } = fixture({
      dependencies: {
        '@forgeax/engine': 'workspace:*',
        '@forgeax/editor-game-plugins': 'workspace:*',
      },
    });
    const target = materializeEngine(engine, ['@forgeax/engine', '@forgeax/editor-game-plugins']);

    const report = await ensureGameProjectDependencies(game, { engineRoot: engine });

    expect(report.status).toBe('linked');
    expect(readlinkSync(managedLinkTarget(game))).toBe(target);
    expect(realpathSafe(join(game, 'node_modules', '@forgeax', 'engine', 'package.json'))).toBe(
      realpathSafe(join(target, 'engine', 'package.json')),
    );
    expect(JSON.parse(readFileSync(projectDependencyManifestPath(game), 'utf8'))).toEqual({
      schemaVersion: '1.0.0',
      links: [{
        path: 'node_modules/@forgeax',
        target,
        packages: ['@forgeax/editor-game-plugins', '@forgeax/engine'],
      }],
    });
  });

  test('repoints a legacy absolute link after the Studio App moves', async () => {
    const { game, root, engine } = fixture();
    const oldEngine = join(root, 'old-app', 'resources', 'engine');
    const oldTarget = materializeEngine(oldEngine);
    const newTarget = materializeEngine(engine);
    mkdirSync(join(game, 'node_modules'), { recursive: true });
    symlinkSync(oldTarget, managedLinkTarget(game), 'dir');

    const report = await ensureGameProjectDependencies(game, { engineRoot: engine });

    expect(report.status).toBe('relinked');
    expect(readlinkSync(managedLinkTarget(game))).toBe(newTarget);
    expect(readlinkSync(managedLinkTarget(game))).not.toBe(oldTarget);
  });

  test('does not destroy an old link when the current Engine source disappeared', async () => {
    const { game, root, engine } = fixture();
    const oldEngine = join(root, 'old-app', 'resources', 'engine');
    const oldTarget = materializeEngine(oldEngine);
    mkdirSync(join(game, 'node_modules'), { recursive: true });
    symlinkSync(oldTarget, managedLinkTarget(game), 'dir');
    rmSync(engine, { recursive: true, force: true });

    await expect(ensureGameProjectDependencies(game, { engineRoot: engine })).rejects.toMatchObject({
      code: 'project-dependency-source-unavailable',
      status: 503,
    });
    expect(readlinkSync(managedLinkTarget(game))).toBe(oldTarget);
    expect(existsSync(projectDependencyManifestPath(game))).toBe(false);
  });

  test('leaves a real user directory occupying the scope untouched', async () => {
    const { game, engine } = fixture();
    const target = materializeEngine(engine);
    const link = managedLinkTarget(game);
    mkdirSync(link, { recursive: true });
    writeFileSync(join(link, 'keep-me.txt'), 'user dependency');

    await expect(ensureGameProjectDependencies(game, { engineRoot: engine })).rejects.toMatchObject({
      code: 'project-dependency-conflict',
      status: 409,
    });
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(link, 'keep-me.txt'), 'utf8')).toBe('user dependency');
    expect(target).toBe(engineDependencyScopePath(engine));
  });

  test('leaves an unrecognized custom symlink untouched', async () => {
    const { game, root, engine } = fixture();
    const target = materializeEngine(engine);
    const customTarget = join(root, 'custom-dependency-scope', '@forgeax');
    mkdirSync(customTarget, { recursive: true });
    mkdirSync(join(game, 'node_modules'), { recursive: true });
    symlinkSync(customTarget, managedLinkTarget(game), 'dir');

    await expect(ensureGameProjectDependencies(game, { engineRoot: engine })).rejects.toMatchObject({
      code: 'project-dependency-conflict',
      status: 409,
      details: { target: customTarget },
    });
    expect(readlinkSync(managedLinkTarget(game))).toBe(customTarget);
    expect(target).toBe(engineDependencyScopePath(engine));
  });

  test('coalesces concurrent opens and remains idempotent', async () => {
    const { game, engine } = fixture();
    const target = materializeEngine(engine);

    const reports = await Promise.all([
      ensureGameProjectDependencies(game, { engineRoot: engine }),
      ensureGameProjectDependencies(game, { engineRoot: engine }),
      ensureGameProjectDependencies(game, { engineRoot: engine }),
    ]);
    const second = await ensureGameProjectDependencies(game, { engineRoot: engine });

    expect(reports.map((report) => report.status)).toEqual(['linked', 'linked', 'linked']);
    expect(second.status).toBe('current');
    expect(readlinkSync(managedLinkTarget(game))).toBe(target);
  });

  test('does not manage registry/file dependency declarations', async () => {
    const { game, engine } = fixture({ dependencies: { '@forgeax/engine': '^0.0.0' } });
    materializeEngine(engine);

    const report = await ensureGameProjectDependencies(game, { engineRoot: engine });

    expect(report.status).toBe('skipped');
    expect(report.reason).toBe('package-manager-owned');
    expect(existsSync(join(game, 'node_modules'))).toBe(false);
    expect(existsSync(projectDependencyManifestPath(game))).toBe(false);
  });

  test('recognizes only Engine-shaped legacy paths, including Windows drive/UNC forms', () => {
    expect(isLegacyEngineScopeTarget('/Applications/ForgeaX/engine/node_modules/@forgeax', 'darwin')).toBe(true);
    expect(isLegacyEngineScopeTarget('C:\\Program Files\\ForgeaX\\engine\\node_modules\\@forgeax', 'win32')).toBe(true);
    expect(isLegacyEngineScopeTarget('\\\\server\\share\\ForgeaX\\engine\\node_modules\\@forgeax', 'win32')).toBe(true);
    expect(isLegacyEngineScopeTarget('C:\\projects\\custom\\node_modules\\@forgeax', 'win32')).toBe(false);
  });

  test('reports a stale lock instead of deleting or taking another process lock', async () => {
    const { game, engine } = fixture();
    materializeEngine(engine);
    mkdirSync(join(game, '.forgeax'), { recursive: true });
    writeFileSync(join(game, '.forgeax/project-dependency-links.lock'), 'held by another process');

    const error = await ensureGameProjectDependencies(game, { engineRoot: engine, lockWaitMs: 0 }).catch((cause) => cause);

    expect(error).toBeInstanceOf(ProjectDependencyError);
    expect((error as ProjectDependencyError).code).toBe('project-dependency-lock-timeout');
    expect(readFileSync(join(game, '.forgeax/project-dependency-links.lock'), 'utf8')).toBe('held by another process');
  });
});

function realpathSafe(path: string): string {
  return realpathSync(path);
}
