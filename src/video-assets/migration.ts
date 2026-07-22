import {
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { VideoAssetManifest } from './contracts';
import {
  validateAndCloneVideoAssetManifest,
  VideoAssetManifestSchemaError,
} from './manifest-schema';
import {
  convertVideoManifestV1,
  VideoAssetMigrationError,
  type VideoAssetManifestInput,
  type VideoAssetManifestV1,
  type VideoAssetManifestV1Asset,
} from './legacy-manifest';

export {
  convertVideoManifestV1,
  VideoAssetMigrationError,
  type VideoAssetManifestInput,
  type VideoAssetManifestV1,
  type VideoAssetManifestV1Asset,
};

const LEGACY_GRAPH_SNAPSHOTS = ['scenarios.graph_1.json', 'scenarios.graph_2.json'] as const;

export interface ScenarioReferenceReport {
  referenced: string[];
  missing: string[];
}

export interface MissingBlobReport {
  id: string;
  ref: string;
  reason: 'missing' | 'byte_mismatch' | 'invalid_extension';
}

export interface LegacyIgnoredReport {
  graphSnapshots: string[];
}

export interface MigrationReport {
  converted: VideoAssetManifest;
  scenarioReferences: ScenarioReferenceReport;
  legacyIgnored: LegacyIgnoredReport;
  missingBlobs: MissingBlobReport[];
  backupPath?: string;
  dryRun: boolean;
  wroteManifest: boolean;
  metadataOnly: boolean;
}

export interface MigrateVideoAssetDirectoryOptions {
  gameDir: string;
  dryRun?: boolean;
}

function mapV2SchemaError(error: unknown): never {
  if (error instanceof VideoAssetManifestSchemaError) {
    const code =
      error.code === 'duplicate_asset_id' || error.code === 'duplicate_provider_ref'
        ? error.code
        : error.code === 'unsupported_manifest_version'
          ? error.code
          : 'invalid_manifest_schema';
    throw new VideoAssetMigrationError(error.message, code);
  }
  throw error;
}

function collectScenarioMediaRefs(scenarioRoot: unknown): string[] {
  const refs = new Set<string>();

  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') {
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item);
      }
      return;
    }
    const record = node as Record<string, unknown>;
    if (record.kind === 'VIDEO' && typeof record.ref === 'string' && record.ref.length > 0) {
      refs.add(record.ref);
    }
    for (const value of Object.values(record)) {
      walk(value);
    }
  };

  walk(scenarioRoot);
  return [...refs].sort();
}

export function validateScenarioReferences(
  manifest: VideoAssetManifest,
  scenario: unknown,
): ScenarioReferenceReport {
  try {
    validateAndCloneVideoAssetManifest(manifest);
  } catch (error) {
    mapV2SchemaError(error);
  }
  const manifestIds = new Set(manifest.assets.map((asset) => asset.id));
  const referenced = collectScenarioMediaRefs(scenario);
  const missing = referenced.filter((ref) => !manifestIds.has(ref));
  return { referenced, missing };
}

function readScenarioFromGameDir(gameDir: string): unknown {
  const scenariosPath = resolve(gameDir, 'game-video', 'scenarios.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(scenariosPath, 'utf-8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new VideoAssetMigrationError('Missing scenarios.json', 'missing_scenarios', {
        path: scenariosPath,
      });
    }
    throw new VideoAssetMigrationError('Invalid scenarios.json', 'invalid_scenarios');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new VideoAssetMigrationError('Invalid scenarios.json', 'invalid_scenarios');
  }

  const activeId = (parsed as { activeId?: unknown }).activeId;
  const items = (parsed as { items?: unknown }).items;
  if (typeof activeId !== 'string' || !Array.isArray(items)) {
    throw new VideoAssetMigrationError('Invalid scenarios.json structure', 'invalid_scenarios');
  }

  const active = items.find(
    (item) =>
      item &&
      typeof item === 'object' &&
      (item as { id?: unknown }).id === activeId &&
      (item as { scenario?: unknown }).scenario,
  ) as { scenario?: unknown } | undefined;

  if (!active?.scenario) {
    throw new VideoAssetMigrationError(`Active scenario not found: ${activeId}`, 'invalid_scenarios');
  }

  return active.scenario;
}

function detectLegacyGraphSnapshots(gameDir: string): LegacyIgnoredReport {
  const gameVideoDir = resolve(gameDir, 'game-video');
  return {
    graphSnapshots: LEGACY_GRAPH_SNAPSHOTS.filter((name) =>
      existsSync(join(gameVideoDir, name)),
    ),
  };
}

function manifestPathFor(gameDir: string): string {
  return resolve(gameDir, 'game-video', 'assets', 'manifest.json');
}

function backupPathFor(gameDir: string): string {
  return `${manifestPathFor(gameDir)}.v1.bak`;
}

function readRawManifest(gameDir: string): { raw: string; parsed: unknown } {
  const manifestPath = manifestPathFor(gameDir);
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new VideoAssetMigrationError('Missing manifest.json', 'missing_manifest', {
        path: manifestPath,
      });
    }
    throw new VideoAssetMigrationError('Failed to read manifest.json', 'manifest_read_error');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new VideoAssetMigrationError('Invalid manifest.json', 'invalid_manifest');
  }

  return { raw, parsed };
}

function validateLocalBlobs(
  gameDir: string,
  manifest: VideoAssetManifest,
): MissingBlobReport[] {
  const assetsDir = resolve(gameDir, 'game-video', 'assets');
  const missing: MissingBlobReport[] = [];

  for (const asset of manifest.assets) {
    if (asset.provider.kind !== 'local') {
      continue;
    }
    const ref = asset.provider.ref;
    if (!ref.endsWith('.mp4')) {
      missing.push({ id: asset.id, ref, reason: 'invalid_extension' });
      continue;
    }

    const blobPath = resolve(assetsDir, ref);
    if (!existsSync(blobPath)) {
      missing.push({ id: asset.id, ref, reason: 'missing' });
      continue;
    }

    const stat = statSync(blobPath);
    if (!stat.isFile() || stat.size !== asset.bytes) {
      missing.push({ id: asset.id, ref, reason: 'byte_mismatch' });
    }
  }

  return missing;
}

function writeManifestAtomic(gameDir: string, manifest: VideoAssetManifest): void {
  const manifestPath = manifestPathFor(gameDir);
  const assetsDir = resolve(gameDir, 'game-video', 'assets');
  const tempPath = `${manifestPath}.tmp-${randomUUID()}`;
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  try {
    renameSync(tempPath, manifestPath);
  } catch (error) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Preserve the primary rename failure.
    }
    throw error;
  }
}

function ensureV1Backup(gameDir: string, rawV1: string): string {
  const backupPath = backupPathFor(gameDir);
  if (existsSync(backupPath)) {
    const existing = readFileSync(backupPath, 'utf-8');
    if (existing !== rawV1) {
      throw new VideoAssetMigrationError(
        'Refusing to overwrite an existing manifest.json.v1.bak with different content',
        'backup_conflict',
        { path: backupPath },
      );
    }
    return backupPath;
  }

  writeFileSync(backupPath, rawV1, 'utf-8');
  return backupPath;
}

export function migrateVideoAssetDirectory(
  options: MigrateVideoAssetDirectoryOptions,
): MigrationReport {
  const gameDir = resolve(options.gameDir);
  const dryRun = options.dryRun ?? false;
  const { raw, parsed } = readRawManifest(gameDir);
  const sourceVersion = (parsed as { version?: unknown }).version;
  const converted = convertVideoManifestV1(parsed as VideoAssetManifestInput);
  const scenario = readScenarioFromGameDir(gameDir);
  const scenarioReferences = validateScenarioReferences(converted, scenario);
  const legacyIgnored = detectLegacyGraphSnapshots(gameDir);
  const missingBlobs = validateLocalBlobs(gameDir, converted);
  const metadataOnly = missingBlobs.length > 0;

  const report: MigrationReport = {
    converted,
    scenarioReferences,
    legacyIgnored,
    missingBlobs,
    dryRun,
    wroteManifest: false,
    metadataOnly,
  };

  if (missingBlobs.length > 0) {
    if (dryRun) {
      return report;
    }
    throw new VideoAssetMigrationError(
      'Local blob gate blocked migration',
      'missing_local_blobs',
      {
        missingBlobs,
        scenarioReferences,
        legacyIgnored,
        metadataOnly,
      },
    );
  }

  if (scenarioReferences.missing.length > 0) {
    throw new VideoAssetMigrationError(
      'Scenario references missing from manifest',
      'missing_scenario_references',
      { scenarioReferences },
    );
  }

  if (sourceVersion === 1) {
    if (!dryRun) {
      report.backupPath = ensureV1Backup(gameDir, raw);
      writeManifestAtomic(gameDir, converted);
      report.wroteManifest = true;
    }
    report.metadataOnly = false;
    return report;
  }

  if (sourceVersion !== 2) {
    throw new VideoAssetMigrationError('Unsupported manifest version', 'unsupported_manifest_version');
  }

  report.metadataOnly = false;
  return report;
}
