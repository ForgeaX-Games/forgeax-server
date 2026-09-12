import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, posix, resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Product-managed Engine dependencies are deliberately a small, explicit
 * contract. A game declares these packages with the workspace protocol in its
 * own package.json; the Studio then exposes the packaged/source Engine scope
 * at game/node_modules/@forgeax. Declared standard development tools are also
 * exposed from the matching Engine installation with version and ownership
 * checks. The product does not run a package manager or
 * rewrite package.json, and it never claims arbitrary @forgeax packages.
 *
 * Packaged desktop assemble copies Editor-owned managed packages (for example
 * `@forgeax/editor-game-plugins`) into `engine/node_modules/@forgeax`. Source
 * Studio `bun install` hoists that same closure at the Editor workspace
 * (`packages/editor/node_modules/@forgeax`, two levels above nested
 * `packages/engine`) while the nested Engine install stays a partial subset.
 * Resolve the scope that actually contains every package the game declared;
 * do not invent a second dependency authority.
 */
const MANAGED_PACKAGE_SCOPE = '@forgeax/';
const MANAGED_PACKAGE_NAMES = Object.freeze(new Set([
  '@forgeax/editor-game-plugins',
]));
const MANAGED_PACKAGE_PREFIX = '@forgeax/engine';
const WORKSPACE_PROTOCOL = /^workspace:/iu;
const LINK_RELATIVE_PATH = 'node_modules/@forgeax';
const DEPENDENCY_MANIFEST_RELATIVE_PATH = '.forgeax/project-dependency-links.json';
const LOCK_RELATIVE_PATH = '.forgeax/project-dependency-links.lock';
const MANIFEST_SCHEMA_VERSION = '1.0.0' as const;
const DEFAULT_LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 25;

type DependencyLinkStatus = 'skipped' | 'current' | 'linked' | 'relinked';

export interface ProjectDependencyReport {
  readonly root: string;
  readonly status: DependencyLinkStatus;
  readonly linkPath: string;
  readonly targetPath?: string;
  readonly packages: readonly string[];
  readonly manifest: string;
  readonly reason?: 'no-product-managed-workspace-dependencies' | 'package-manager-owned';
}

export type ProjectDependencyErrorCode =
  | 'project-dependency-conflict'
  | 'project-dependency-source-unavailable'
  | 'project-dependency-manifest-invalid'
  | 'project-dependency-lock-timeout';

export interface ProjectDependencyErrorDetails {
  readonly path?: string;
  readonly target?: string;
  readonly packages?: readonly string[];
  readonly lockPath?: string;
}

/** An error safe for the product API to expose as an actionable response. */
export class ProjectDependencyError extends Error {
  readonly code: ProjectDependencyErrorCode;
  readonly status: 409 | 503;
  readonly details: ProjectDependencyErrorDetails;

  constructor(
    code: ProjectDependencyErrorCode,
    message: string,
    status: 409 | 503,
    details: ProjectDependencyErrorDetails = {},
  ) {
    super(message);
    this.name = 'ProjectDependencyError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface ProjectDependencyOptions {
  /** Test/release adapter override. Production resolves the current Engine. */
  readonly engineRoot?: string;
  /** Allows path-shape and junction behavior to be tested without faking OS state. */
  readonly platform?: NodeJS.Platform;
  /** Bounds cross-process serialization when another Studio request is active. */
  readonly lockWaitMs?: number;
}

interface ManagedDependencyLink {
  readonly path: typeof LINK_RELATIVE_PATH;
  readonly target: string;
  readonly packages: readonly string[];
}

interface DependencyLinkManifest {
  readonly schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  readonly links: readonly ManagedDependencyLink[];
}

interface ProjectDependencyContract {
  readonly packages: readonly string[];
}

interface LinkMutation {
  readonly previousTarget?: string;
}

const inFlight = new Map<string, Promise<ProjectDependencyReport>>();

function errorCode(cause: unknown): string | undefined {
  if (cause !== null && typeof cause === 'object' && 'code' in cause) {
    return String(cause.code);
  }
  return undefined;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function pathKind(path: string): Promise<'missing' | 'directory' | 'file' | 'symlink'> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return 'symlink';
    if (info.isDirectory()) return 'directory';
    return 'file';
  } catch (cause) {
    if (errorCode(cause) === 'ENOENT') return 'missing';
    throw cause;
  }
}

function isManagedPackage(name: string): boolean {
  return /^@forgeax\/[a-z0-9][a-z0-9._-]*$/u.test(name) && (name === MANAGED_PACKAGE_PREFIX
    || name.startsWith(`${MANAGED_PACKAGE_PREFIX}-`)
    || MANAGED_PACKAGE_NAMES.has(name));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function declaredDependencies(value: unknown): Map<string, string> {
  const packageJson = isRecord(value) ? value : {};
  const result = new Map<string, string>();
  // dependencies wins over the optional/dev/peer views if a malformed package
  // repeats a key. We only read this metadata; package.json is never rewritten.
  for (const field of ['dependencies', 'optionalDependencies', 'devDependencies', 'peerDependencies']) {
    const section = packageJson[field];
    if (!isRecord(section)) continue;
    for (const [name, spec] of Object.entries(section)) {
      if (typeof spec === 'string' && !result.has(name)) result.set(name, spec.trim());
    }
  }
  return result;
}

async function readProjectDependencyContract(root: string): Promise<ProjectDependencyContract | undefined> {
  const packageJsonPath = join(root, 'package.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(packageJsonPath, 'utf8')) as unknown;
  } catch (cause) {
    if (errorCode(cause) === 'ENOENT') return undefined;
    throw new ProjectDependencyError(
      'project-dependency-manifest-invalid',
      `Cannot read ${packageJsonPath}: ${errorMessage(cause)}`,
      409,
      { path: packageJsonPath },
    );
  }

  const declarations = [...declaredDependencies(parsed).entries()];
  const all = declarations
    .filter(([name]) => isManagedPackage(name));
  if (all.length === 0) return undefined;

  // A registry/file/git declaration belongs to the project's package manager.
  // Do not create a scope junction that could shadow a custom installation.
  const workspace = all.filter(([, spec]) => WORKSPACE_PROTOCOL.test(spec));
  if (workspace.length === 0) {
    return {
      packages: [],
    };
  }
  // A scope-wide link cannot coexist with project-owned packages in that scope.
  // Do not silently skip unresolved workspace dependencies or shadow custom ones.
  const custom = declarations.filter(([name, spec]) => name.startsWith(MANAGED_PACKAGE_SCOPE)
    && (!isManagedPackage(name) || !WORKSPACE_PROTOCOL.test(spec)));
  if (custom.length > 0) {
    throw dependencyConflict(
      `Cannot prepare a Studio Engine scope alongside project-owned packages: ${custom.map(([name]) => name).join(', ')}. Dependencies were left unchanged.`,
      packageJsonPath,
      undefined,
      workspace.map(([name]) => name),
    );
  }
  return {
    packages: workspace.map(([name]) => name).sort(),
  };
}

function pathApi(platform: NodeJS.Platform): typeof posix {
  // posix and win32 expose the same path API shape for the functions used in
  // this file. The explicit selector matters for Windows drive and UNC paths
  // in ownership checks, even though normal production calls use native paths.
  return platform === 'win32' ? win32 : posix;
}

function normalizePath(path: string, platform: NodeJS.Platform): string {
  const api = pathApi(platform);
  const normalized = api.normalize(path);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function resolveLinkTarget(linkPath: string, rawTarget: string, platform: NodeJS.Platform): string {
  const api = pathApi(platform);
  return api.resolve(api.dirname(linkPath), rawTarget);
}

function equivalentPath(left: string, right: string, platform: NodeJS.Platform): boolean {
  return normalizePath(left, platform) === normalizePath(right, platform);
}

/**
 * Return the nested Engine scope path. Exported so release tests can prove the
 * packaged-layout contract for both POSIX and Windows-style drive/UNC roots.
 * Callers that prepare a game must use `resolveEngineDependencyScope` so a
 * source Editor hoist can stand in when this nested directory is incomplete.
 */
export function engineDependencyScopePath(
  engineRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return pathApi(platform).resolve(engineRoot, 'node_modules', '@forgeax');
}

async function scopeContainsManagedPackages(
  scopePath: string,
  packages: readonly string[],
): Promise<boolean> {
  let scopeIsDirectory = false;
  try {
    scopeIsDirectory = (await stat(scopePath)).isDirectory();
  } catch {
    return false;
  }
  if (!scopeIsDirectory) return false;
  for (const name of packages) {
    const manifestPath = join(scopePath, name.slice(MANAGED_PACKAGE_SCOPE.length), 'package.json');
    try {
      const packageManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { name?: unknown };
      if (packageManifest.name !== name) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Pick the @forgeax scope a game should consume. Prefer the nested Engine
 * install (packaged assemble + tests). If that directory is missing any
 * declared managed package, walk one and two parents for an Editor workspace
 * hoist — covering both `editor/engine` fixtures and source
 * `editor/packages/engine`. This is the source-tree equivalent of assemble's
 * EDITOR_ROOT/node_modules fallback.
 */
export async function resolveEngineDependencyScope(
  engineRoot: string,
  packages: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const api = pathApi(platform);
  const nested = engineDependencyScopePath(engineRoot, platform);
  const candidates = [
    nested,
    api.resolve(engineRoot, '..', 'node_modules', '@forgeax'),
    api.resolve(engineRoot, '..', '..', 'node_modules', '@forgeax'),
  ];
  // Studio prepare owns integration links at its root; independent Editor
  // installs can leave both nested scopes partial. Only admit this known
  // product root, never an arbitrary ancestor's node_modules.
  const studioRoot = api.resolve(engineRoot, '../../../..');
  if (api.resolve(studioRoot, 'packages/editor/packages/engine') === api.resolve(engineRoot)) {
    try {
      const manifest = JSON.parse(await readFile(api.join(studioRoot, 'package.json'), 'utf8'));
      if (manifest.name === 'forgeax-studio') {
        candidates.push(api.join(studioRoot, 'node_modules', '@forgeax'));
      }
    } catch { /* A standalone Editor has no Studio integration root. */ }
  }
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = normalizePath(candidate, platform);
    if (seen.has(key)) continue;
    seen.add(key);
    if (await scopeContainsManagedPackages(candidate, packages)) return candidate;
  }
  return nested;
}

/**
 * Legacy links have no manifest because older Studio/App builds created the
 * scope symlink directly. Require the named product's packaged resource layout,
 * not just an arbitrary directory named engine. Unknown source layouts require
 * explicit ownership metadata and are left untouched.
 */
export function isLegacyEngineScopeTarget(
  target: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const api = pathApi(platform);
  const normalized = api.normalize(target);
  const parts = normalized.split(api.sep).filter(Boolean);
  const value = (platform === 'win32' ? parts.map((part) => part.toLowerCase()) : parts).join('/');
  if (platform === 'win32') {
    return /(?:^|\/)forgeax studio\/resources\/(?:editor\/packages\/)?engine\/node_modules\/@forgeax$/u.test(value);
  }
  return /(?:^|\/)ForgeaX Studio\.app\/Contents\/Resources\/(?:editor\/packages\/)?engine\/node_modules\/@forgeax$/u.test(value);
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  const kind = await pathKind(path);
  if (kind === 'missing') return undefined;
  if (kind !== 'file') {
    throw new ProjectDependencyError(
      'project-dependency-manifest-invalid',
      `Product dependency metadata must be a regular file: ${path}`,
      409,
      { path },
    );
  }
  return readFile(path, 'utf8');
}

function parseDependencyManifest(path: string, text: string): DependencyLinkManifest {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new ProjectDependencyError(
      'project-dependency-manifest-invalid',
      `Product dependency metadata is not valid JSON: ${path} (${errorMessage(cause)})`,
      409,
      { path },
    );
  }
  if (!isRecord(value) || value.schemaVersion !== MANIFEST_SCHEMA_VERSION || !Array.isArray(value.links)) {
    throw new ProjectDependencyError(
      'project-dependency-manifest-invalid',
      `Product dependency metadata has an unsupported schema: ${path}`,
      409,
      { path },
    );
  }

  const links: ManagedDependencyLink[] = [];
  for (const candidate of value.links) {
    if (!isRecord(candidate)
      || candidate.path !== LINK_RELATIVE_PATH
      || typeof candidate.target !== 'string'
      || !Array.isArray(candidate.packages)
      || !candidate.packages.every((name) => typeof name === 'string' && isManagedPackage(name))) {
      throw new ProjectDependencyError(
        'project-dependency-manifest-invalid',
        `Product dependency metadata contains an invalid link record: ${path}`,
        409,
        { path },
      );
    }
    links.push({
      path: LINK_RELATIVE_PATH,
      target: candidate.target,
      packages: [...candidate.packages].sort(),
    });
  }
  if (links.length !== new Set(links.map((link) => link.path)).size) {
    throw new ProjectDependencyError(
      'project-dependency-manifest-invalid',
      `Product dependency metadata contains duplicate link records: ${path}`,
      409,
      { path },
    );
  }
  return { schemaVersion: MANIFEST_SCHEMA_VERSION, links };
}

async function readDependencyManifest(root: string): Promise<DependencyLinkManifest | undefined> {
  const path = join(root, DEPENDENCY_MANIFEST_RELATIVE_PATH);
  const text = await readOptionalFile(path);
  return text === undefined ? undefined : parseDependencyManifest(path, text);
}

async function ensureMetadataDirectory(root: string): Promise<string> {
  const metadataRoot = join(root, '.forgeax');
  const kind = await pathKind(metadataRoot);
  if (kind === 'missing') {
    await mkdir(metadataRoot, { recursive: true });
  } else if (kind !== 'directory') {
    throw new ProjectDependencyError(
      'project-dependency-conflict',
      `Cannot store product dependency metadata because ${metadataRoot} is not a real directory; user state was left unchanged.`,
      409,
      { path: metadataRoot },
    );
  }
  return metadataRoot;
}

async function validateEngineSource(
  engineRoot: string,
  scopePath: string,
  packages: readonly string[],
): Promise<void> {
  let scopeIsDirectory = false;
  try {
    scopeIsDirectory = (await stat(scopePath)).isDirectory();
  } catch {
    scopeIsDirectory = false;
  }
  if (!scopeIsDirectory) {
    throw new ProjectDependencyError(
      'project-dependency-source-unavailable',
      `The current Studio Engine dependency source is unavailable at ${scopePath}. Move/reopen the current Studio App or repair its Engine resources, then reopen this project.`,
      503,
      { path: engineRoot, target: scopePath, packages },
    );
  }

  for (const name of packages) {
    const packagePath = join(scopePath, name.slice(MANAGED_PACKAGE_SCOPE.length));
    const manifestPath = join(packagePath, 'package.json');
    try {
      const packageManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { name?: unknown };
      if (packageManifest.name !== name) throw new Error(`package name is ${String(packageManifest.name)}`);
    } catch (cause) {
      throw new ProjectDependencyError(
        'project-dependency-source-unavailable',
        `The current Studio Engine is missing ${name} under ${scopePath}; reopen after the matching Engine resources are available. (${errorMessage(cause)})`,
        503,
        { path: manifestPath, target: scopePath, packages },
      );
    }
  }
}

async function resolvesTo(path: string, target: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const [actual, expected] = await Promise.all([realpath(path), realpath(target)]);
    return equivalentPath(actual, expected, platform);
  } catch {
    return false;
  }
}

function recordMatchesTarget(
  linkPath: string,
  rawTarget: string,
  record: ManagedDependencyLink | undefined,
  platform: NodeJS.Platform,
): boolean {
  if (record === undefined) return false;
  return equivalentPath(
    resolveLinkTarget(linkPath, rawTarget, platform),
    resolveLinkTarget(linkPath, record.target, platform),
    platform,
  );
}

function dependencyConflict(
  message: string,
  path: string,
  target?: string,
  packages?: readonly string[],
): ProjectDependencyError {
  return new ProjectDependencyError(
    'project-dependency-conflict',
    message,
    409,
    { path, ...(target === undefined ? {} : { target }), ...(packages === undefined ? {} : { packages }) },
  );
}

async function writeManifestAtomically(path: string, manifest: unknown): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function linkStillResolvesTo(
  linkPath: string,
  target: string,
  platform: NodeJS.Platform,
): Promise<boolean> {
  if ((await pathKind(linkPath)) !== 'symlink') return false;
  return resolvesTo(linkPath, target, platform);
}

async function restorePreviousLink(
  linkPath: string,
  previousTarget: string | undefined,
  desiredTarget: string,
  platform: NodeJS.Platform,
): Promise<void> {
  if (previousTarget === undefined) {
    if (await linkStillResolvesTo(linkPath, desiredTarget, platform)) await unlink(linkPath);
    return;
  }
  if (await linkStillResolvesTo(linkPath, desiredTarget, platform)) await unlink(linkPath);
  if ((await pathKind(linkPath)) === 'missing') {
    await symlink(previousTarget, linkPath, platform === 'win32' ? 'junction' : 'dir');
  }
}

async function mutateLink(
  linkPath: string,
  desiredTarget: string,
  existingKind: 'missing' | 'symlink',
  previousTarget: string | undefined,
  platform: NodeJS.Platform,
): Promise<LinkMutation> {
  if (existingKind === 'symlink') await unlink(linkPath);
  try {
    await symlink(desiredTarget, linkPath, platform === 'win32' ? 'junction' : 'dir');
  } catch (cause) {
    try {
      await restorePreviousLink(linkPath, previousTarget, desiredTarget, platform);
    } catch (restoreCause) {
      throw new Error(`${errorMessage(cause)}; restoring the previous dependency link also failed: ${errorMessage(restoreCause)}`);
    }
    throw cause;
  }
  return { previousTarget };
}

function manifestWithLink(
  prior: DependencyLinkManifest | undefined,
  target: string,
  packages: readonly string[],
): DependencyLinkManifest {
  const otherLinks = (prior?.links ?? []).filter((link) => link.path !== LINK_RELATIVE_PATH);
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    links: [
      ...otherLinks,
      { path: LINK_RELATIVE_PATH, target, packages: [...packages].sort() },
    ],
  };
}

function manifestNeedsWrite(
  prior: DependencyLinkManifest | undefined,
  target: string,
  packages: readonly string[],
  platform: NodeJS.Platform,
): boolean {
  const record = prior?.links.find((link) => link.path === LINK_RELATIVE_PATH);
  return record === undefined
    || !equivalentPath(record.target, target, platform)
    || JSON.stringify(record.packages) !== JSON.stringify([...packages].sort());
}

async function ensureLocked(
  root: string,
  contract: ProjectDependencyContract,
  options: ProjectDependencyOptions,
): Promise<ProjectDependencyReport> {
  const platform = options.platform ?? process.platform;
  const manifestPath = join(root, DEPENDENCY_MANIFEST_RELATIVE_PATH);
  const linkPath = join(root, LINK_RELATIVE_PATH);
  const engineRoot = options.engineRoot === undefined
    ? dirname((await import('./game-templates')).resolveEngineTemplatesRoot())
    : pathApi(platform).resolve(options.engineRoot);
  const targetPath = await resolveEngineDependencyScope(engineRoot, contract.packages, platform);

  await ensureMetadataDirectory(root);
  const priorManifest = await readDependencyManifest(root);
  await validateEngineSource(engineRoot, targetPath, contract.packages);

  const nodeModulesPath = join(root, 'node_modules');
  const nodeModulesKind = await pathKind(nodeModulesPath);
  if (nodeModulesKind === 'missing') await mkdir(nodeModulesPath, { recursive: true });
  else if (nodeModulesKind !== 'directory') {
    throw dependencyConflict(
      `Cannot prepare Engine dependencies because ${nodeModulesPath} is not a real directory; user dependencies were left unchanged.`,
      nodeModulesPath,
      targetPath,
      contract.packages,
    );
  }

  const existingKind = await pathKind(linkPath);
  let status: 'current' | 'linked' | 'relinked';
  let mutation: LinkMutation | undefined;
  if (existingKind === 'missing') {
    mutation = await mutateLink(linkPath, targetPath, 'missing', undefined, platform);
    status = 'linked';
  } else if (existingKind !== 'symlink') {
    throw dependencyConflict(
      `Cannot prepare Engine dependencies because ${linkPath} is occupied by a real ${existingKind}; the user dependency was left unchanged. Remove or move that directory only if it is no longer needed, then reopen the project.`,
      linkPath,
      targetPath,
      contract.packages,
    );
  } else {
    const rawTarget = await readlink(linkPath);
    const currentTarget = resolveLinkTarget(linkPath, rawTarget, platform);
    const sameTarget = await resolvesTo(linkPath, targetPath, platform);
    const record = priorManifest?.links.find((link) => link.path === LINK_RELATIVE_PATH);
    const ownedByManifest = recordMatchesTarget(linkPath, rawTarget, record, platform);
    // Once recorded, a changed target is a user edit, not a legacy migration.
    const ownedLegacy = priorManifest === undefined && isLegacyEngineScopeTarget(currentTarget, platform);
    if (!sameTarget && !ownedByManifest && !ownedLegacy) {
      throw dependencyConflict(
        `Cannot repair ${linkPath}: it is a custom link to ${currentTarget}, not a Studio-managed Engine link; it was left unchanged. Keep the project's package-manager dependency or remove the custom link explicitly before reopening.`,
        linkPath,
        currentTarget,
        contract.packages,
      );
    }
    if (sameTarget) {
      status = 'current';
    } else {
      mutation = await mutateLink(linkPath, targetPath, 'symlink', rawTarget, platform);
      status = 'relinked';
    }
  }

  const nextManifest = manifestWithLink(priorManifest, targetPath, contract.packages);
  try {
    if (mutation !== undefined || manifestNeedsWrite(priorManifest, targetPath, contract.packages, platform)) {
      // A product lock fences other Studio processes, but a user can still
      // edit the project manually. Never let a newly appearing metadata file
      // be replaced merely because our first read saw it as absent.
      if (priorManifest === undefined && (await pathKind(manifestPath)) !== 'missing') {
        throw dependencyConflict(
          `Cannot create product dependency metadata because ${manifestPath} appeared during preparation; user state was left unchanged.`,
          manifestPath,
        );
      }
      await writeManifestAtomically(manifestPath, nextManifest);
    }
  } catch (cause) {
    if (mutation !== undefined) {
      try {
        await restorePreviousLink(linkPath, mutation.previousTarget, targetPath, platform);
      } catch (restoreCause) {
        throw new Error(`${errorMessage(cause)}; restoring the dependency link also failed: ${errorMessage(restoreCause)}`);
      }
    }
    throw cause;
  }

  await ensureProjectToolchain(root, engineRoot, platform);

  return {
    root,
    status,
    linkPath,
    targetPath,
    packages: contract.packages,
    manifest: manifestPath,
  };
}

// Only standard authoring tools are managed. Versions remain project-owned;
// sources must satisfy them, and existing user installations are preserved.
const PROJECT_TOOLCHAIN = { typescript: ['tsc', 'tsserver'], vitest: ['vitest'], '@types/node': [] } as const;
type ToolchainLink = { path: string; target: string; kind: 'package' | 'bin' };

function toolchainRecordValid(value: unknown): value is ToolchainLink {
  if (!isRecord(value) || typeof value.target !== 'string') return false;
  return Object.entries(PROJECT_TOOLCHAIN).some(([name, bins]) =>
    (value.kind === 'package' && value.path === `node_modules/${name}`)
    || (value.kind === 'bin' && bins.some((bin) => value.path === `node_modules/.bin/${bin}`)));
}

function toolchainBinText(target: string): string {
  return `#!/usr/bin/env node\nimport(${JSON.stringify(pathToFileURL(target).href)});\n`;
}

function toolchainCmdText(path: string): string {
  return `@echo off\r\nnode "%~dp0${basename(path)}" %*\r\n`;
}

async function ensureToolchainDirectory(path: string): Promise<void> {
  const kind = await pathKind(path);
  if (kind === 'missing') await mkdir(path, { recursive: true });
  else if (kind !== 'directory') throw dependencyConflict(`Cannot prepare project tools in ${path}; it is not a real directory.`, path);
}

async function ownsToolchainLink(root: string, record: ToolchainLink, platform: NodeJS.Platform): Promise<boolean> {
  const path = join(root, record.path);
  if (record.kind === 'package') return linkStillResolvesTo(path, record.target, platform);
  return await readOptionalFile(path) === toolchainBinText(record.target)
    && await readOptionalFile(`${path}.cmd`) === toolchainCmdText(path);
}

async function ensureProjectToolchain(root: string, engineRoot: string, platform: NodeJS.Platform): Promise<void> {
  const manifestPath = join(root, '.forgeax/project-toolchain-links.json');
  const text = await readOptionalFile(manifestPath);
  const prior: ToolchainLink[] = [];
  if (text !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { /* Reject malformed metadata below. */ }
    if (!isRecord(parsed) || parsed.schemaVersion !== '1.0.0' || !Array.isArray(parsed.links)
      || !parsed.links.every(toolchainRecordValid)
      || new Set(parsed.links.map((link) => link.path)).size !== parsed.links.length) {
      throw new ProjectDependencyError('project-dependency-manifest-invalid', `Invalid toolchain ownership metadata: ${manifestPath}`, 409, { path: manifestPath });
    }
    prior.push(...parsed.links);
  }
  const declarations = declaredDependencies(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')));
  const desired: ToolchainLink[] = [];
  for (const [name, bins] of Object.entries(PROJECT_TOOLCHAIN)) {
    const spec = declarations.get(name);
    if (spec === undefined) continue;
    const path = `node_modules/${name}`;
    const destination = join(root, path);
    const record = prior.find((row) => row.path === path);
    const kind = await pathKind(destination);
    const managed = record !== undefined && await ownsToolchainLink(root, record, platform);
    if (record !== undefined && kind !== 'missing' && !managed) {
      throw dependencyConflict(`Project tool ${destination} was changed by the user; it was left unchanged.`, destination);
    }
    const target = kind !== 'missing' && !managed ? destination : join(engineRoot, 'node_modules', name);
    let installed: Record<string, unknown>;
    try { installed = JSON.parse(await readFile(join(target, 'package.json'), 'utf8')); }
    catch { throw new ProjectDependencyError('project-dependency-source-unavailable', `Project tool ${name} (${spec}) is unavailable at ${target}. Repair the matching Studio toolchain or install the project's dependencies.`, 503, { path: target }); }
    if (installed.name !== name || typeof installed.version !== 'string' || !Bun.semver.satisfies(installed.version, spec)) {
      throw new ProjectDependencyError('project-dependency-conflict', `Project tool ${name} requires ${spec}, but ${target} provides ${String(installed.version)}. No substitute version was installed.`, 409, { path: target });
    }
    if (target !== destination) desired.push({ path, target, kind: 'package' });
    const declaredBins = typeof installed.bin === 'string' ? { [name]: installed.bin } : installed.bin;
    for (const bin of bins) {
      if (!isRecord(declaredBins) || typeof declaredBins[bin] !== 'string') continue;
      const entry = resolve(target, declaredBins[bin]);
      if (!await stat(entry).then((info) => info.isFile()).catch(() => false)) {
        throw new ProjectDependencyError('project-dependency-source-unavailable', `Project tool entry is unavailable: ${entry}`, 503, { path: entry });
      }
      desired.push({ path: `node_modules/.bin/${bin}`, target: entry, kind: 'bin' });
    }
  }
  // Validate all destinations before changing any toolchain entry.
  const changes: ToolchainLink[] = [];
  for (const next of desired) {
    const path = join(root, next.path);
    const record = prior.find((row) => row.path === next.path);
    const kind = await pathKind(path);
    const matches = record !== undefined && await ownsToolchainLink(root, record, platform);
    if (kind !== 'missing' && !matches) {
      if (record === undefined && next.kind === 'bin') continue;
      throw dependencyConflict(`Cannot replace custom project tool ${path}.`, path);
    }
    if (next.kind === 'bin' && kind === 'missing' && await pathKind(`${path}.cmd`) !== 'missing') {
      throw dependencyConflict(`Cannot replace custom project tool ${path}.cmd.`, `${path}.cmd`);
    }
    await ensureToolchainDirectory(dirname(path));
    changes.push(next);
  }
  const records = [...prior];
  for (const next of changes) {
    const path = join(root, next.path);
    const record = records.find((row) => row.path === next.path);
    if (record?.target === next.target && await ownsToolchainLink(root, record, platform)) continue;
    if (next.kind === 'package') {
      const kind = await pathKind(path);
      const previousTarget = kind === 'symlink' ? await readlink(path) : undefined;
      await mutateLink(path, next.target, kind === 'symlink' ? 'symlink' : 'missing', previousTarget, platform);
    } else {
      await writeFile(path, toolchainBinText(next.target), { mode: 0o755 });
      await writeFile(`${path}.cmd`, toolchainCmdText(path));
    }
    const index = records.findIndex((row) => row.path === next.path);
    if (index === -1) records.push(next); else records[index] = next;
    await writeManifestAtomically(manifestPath, { schemaVersion: '1.0.0', links: records });
  }
}

async function acquireLock(lockPath: string, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      await mkdir(lockPath);
      try {
        await writeFile(
          join(lockPath, 'owner.json'),
          `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
          { flag: 'wx' },
        );
      } catch (cause) {
        await rm(lockPath, { recursive: true, force: true });
        throw cause;
      }
      return;
    } catch (cause) {
      if (errorCode(cause) !== 'EEXIST') throw cause;
      if (Date.now() >= deadline) {
        throw new ProjectDependencyError(
          'project-dependency-lock-timeout',
          `Another Studio process is preparing this project's Engine dependencies at ${lockPath}; it did not finish within ${waitMs}ms. Close the other project-open operation and retry.`,
          409,
          { lockPath },
        );
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, LOCK_POLL_MS));
    }
  }
}

async function withProjectLock(
  root: string,
  contract: ProjectDependencyContract,
  options: ProjectDependencyOptions,
): Promise<ProjectDependencyReport> {
  const metadataRoot = await ensureMetadataDirectory(root);
  const lockPath = join(metadataRoot, basename(LOCK_RELATIVE_PATH));
  await acquireLock(lockPath, Math.max(0, options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS));
  try {
    return await ensureLocked(root, contract, options);
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function ensureProjectDependencies(
  root: string,
  options: ProjectDependencyOptions,
): Promise<ProjectDependencyReport> {
  const linkPath = join(root, LINK_RELATIVE_PATH);
  const manifestPath = join(root, DEPENDENCY_MANIFEST_RELATIVE_PATH);
  const contract = await readProjectDependencyContract(root);
  if (contract === undefined) {
    return {
      root,
      status: 'skipped',
      linkPath,
      packages: [],
      manifest: manifestPath,
      reason: 'no-product-managed-workspace-dependencies',
    };
  }
  if (contract.packages.length === 0) {
    return {
      root,
      status: 'skipped',
      linkPath,
      packages: [],
      manifest: manifestPath,
      reason: 'package-manager-owned',
    };
  }
  return withProjectLock(root, contract, options);
}

/**
 * Ensure the current Studio Engine scope is available to an Engine game.
 * Calls for the same project are coalesced in-process and serialized across
 * processes by a project-local lock. A failed source/ownership check never
 * removes a real user directory or an unrecognized custom link.
 */
export function ensureGameProjectDependencies(
  gameDir: string,
  options: ProjectDependencyOptions = {},
): Promise<ProjectDependencyReport> {
  const root = resolve(gameDir);
  const running = inFlight.get(root);
  if (running !== undefined) return running;

  const work = ensureProjectDependencies(root, options);
  const promise = work.finally(() => {
    if (inFlight.get(root) === promise) inFlight.delete(root);
  });
  inFlight.set(root, promise);
  return promise;
}

/** Test/support surface for callers that need the metadata file location. */
export function projectDependencyManifestPath(gameDir: string): string {
  return resolve(gameDir, DEPENDENCY_MANIFEST_RELATIVE_PATH);
}

/** Test/support surface for callers that need the managed link location. */
export function projectDependencyLinkPath(gameDir: string): string {
  return resolve(gameDir, LINK_RELATIVE_PATH);
}
