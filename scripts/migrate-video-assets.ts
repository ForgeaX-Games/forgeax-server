#!/usr/bin/env bun
import { resolve } from 'node:path';
import {
  VideoAssetMigrationError,
  migrateVideoAssetDirectory,
  type MigrationReport,
} from '../src/video-assets/migration';

export interface MigrateCliOptions {
  gameDir: string;
  dryRun: boolean;
  uploadToActiveProvider: boolean;
  serverUrl: string;
}

const DEFAULT_SERVER_URL = 'http://localhost:18900';
type UploadBody = NonNullable<RequestInit['body']>;

export function parseMigrateCliArgs(argv: string[]): MigrateCliOptions {
  let gameDir: string | undefined;
  let dryRun = false;
  let uploadToActiveProvider = false;
  let serverUrl = DEFAULT_SERVER_URL;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--upload-to-active-provider') {
      uploadToActiveProvider = true;
      continue;
    }
    if (arg === '--game-dir') {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) {
        throw new VideoAssetMigrationError('Missing value for --game-dir', 'invalid_cli_args');
      }
      gameDir = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--game-dir=')) {
      gameDir = arg.slice('--game-dir='.length);
      continue;
    }
    if (arg === '--server-url') {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) {
        throw new VideoAssetMigrationError('Missing value for --server-url', 'invalid_cli_args');
      }
      serverUrl = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--server-url=')) {
      serverUrl = arg.slice('--server-url='.length);
      continue;
    }
    throw new VideoAssetMigrationError(`Unknown argument: ${arg}`, 'invalid_cli_args');
  }

  if (!gameDir) {
    throw new VideoAssetMigrationError('--game-dir is required', 'invalid_cli_args');
  }

  return {
    gameDir: resolve(gameDir),
    dryRun,
    uploadToActiveProvider,
    serverUrl,
  };
}

function printHelp(): void {
  console.log(`Usage: bun scripts/migrate-video-assets.ts --game-dir <path> [options]

Options:
  --game-dir <path>               Game directory containing game-video/assets (required)
  --dry-run                       Validate and report without writing manifest.json
  --upload-to-active-provider     Upload local blobs through the active EA video API
  --server-url <url>              EA server base URL (default: ${DEFAULT_SERVER_URL})
  -h, --help                      Show this help text

Auth for --upload-to-active-provider is read from environment variables only:
  FORGEAX_MIGRATION_AUTHORIZATION
  FORGEAX_MIGRATION_COOKIE
`);
}

function logReport(report: MigrationReport): void {
  console.log(`manifest version target: 2`);
  console.log(`dry-run: ${report.dryRun}`);
  console.log(`wrote manifest: ${report.wroteManifest}`);
  if (report.backupPath) {
    console.log(`backup: ${report.backupPath}`);
  }
  if (report.legacyIgnored.graphSnapshots.length > 0) {
    console.log(
      `legacy ignored graph snapshots: ${report.legacyIgnored.graphSnapshots.join(', ')}`,
    );
  }
  console.log(
    `scenario refs: referenced=${report.scenarioReferences.referenced.length} missing=${report.scenarioReferences.missing.length}`,
  );
  if (report.missingBlobs.length > 0) {
    console.log('missing local blobs:');
    for (const item of report.missingBlobs) {
      console.log(`  - ${item.id} (${item.ref}) [${item.reason}]`);
    }
    console.log('metadata converted, physical gate blocked');
  }
}

function readMigrationAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const authorization = process.env.FORGEAX_MIGRATION_AUTHORIZATION?.trim();
  const cookie = process.env.FORGEAX_MIGRATION_COOKIE?.trim();
  if (authorization) {
    headers.authorization = authorization;
  }
  if (cookie) {
    headers.cookie = cookie;
  }
  return headers;
}

export interface UploadVideoAssetBatchOptions {
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  serverUrl: string;
  gameSlug: string;
  assets: Iterable<{
    assetId: string;
    body: UploadBody;
    size: number;
    fileName: string;
    durationMs?: number;
  }> | AsyncIterable<{
    assetId: string;
    body: UploadBody;
    size: number;
    fileName: string;
    durationMs?: number;
  }>;
  authorization?: string;
  cookie?: string;
}

export async function uploadVideoAssetBatch(
  options: UploadVideoAssetBatchOptions,
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const authHeaders: Record<string, string> = {};
  if (options.authorization) {
    authHeaders.authorization = options.authorization;
  }
  if (options.cookie) {
    authHeaders.cookie = options.cookie;
  }
  const resources: Array<Record<string, unknown>> = [];
  const expectedIds: string[] = [];
  for await (const asset of options.assets) {
    expectedIds.push(asset.assetId);
    const prepareResponse = await fetchImpl(
      `${options.serverUrl}/api/v1/kino/image-assets/upload`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({
          game_id: options.gameSlug,
          mime_type: 'video/mp4',
          bytes: asset.size,
          file_name: asset.fileName,
          client_resource_id: asset.assetId,
          replace_existing: true,
        }),
      },
    );
    if (!prepareResponse.ok) {
      throw new VideoAssetMigrationError('Upload prepare failed', 'upload_prepare_failed');
    }

    const prepareBody = (await prepareResponse.json()) as {
      data?: { upload?: { url?: string; headers?: Record<string, string> }; object_url?: string };
    };
    const uploadUrl = prepareBody.data?.upload?.url;
    const objectUrl = prepareBody.data?.object_url;
    if (!uploadUrl || !objectUrl) {
      throw new VideoAssetMigrationError(
        'Upload prepare returned incomplete data',
        'upload_prepare_failed',
      );
    }

    const putResponse = await fetchImpl(uploadUrl, {
      method: 'PUT',
      headers: prepareBody.data?.upload?.headers ?? {},
      body: asset.body,
    });
    if (!putResponse.ok) {
      throw new VideoAssetMigrationError('Upload PUT failed', 'upload_put_failed');
    }

    resources.push({
      media_type: 'video',
      url: objectUrl,
      name: asset.fileName,
      type: 'UPLOAD',
      source: 'migration',
      source_meta: asset.durationMs === undefined
        ? {}
        : { duration_ms: asset.durationMs },
    });
  }

  // The batch POST is the only commit point after every provider PUT succeeds.
  const createResponse = await fetchImpl(`${options.serverUrl}/api/v1/kino/resources/batch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...authHeaders,
    },
    body: JSON.stringify({
      game_id: options.gameSlug,
      resources,
    }),
  });
  if (!createResponse.ok) {
    throw new VideoAssetMigrationError('Batch upload finalize failed', 'upload_finalize_failed');
  }
  const responseBody = (await createResponse.json()) as {
    data?: { items?: Array<{ resource_id?: unknown }> };
  };
  const returnedIds = responseBody.data?.items?.map((item) => item.resource_id);
  if (
    !returnedIds ||
    returnedIds.length !== expectedIds.length ||
    new Set(returnedIds).size !== expectedIds.length ||
    expectedIds.some((id) => !returnedIds.includes(id))
  ) {
    throw new VideoAssetMigrationError(
      'Batch response did not cover every stable resource id',
      'upload_finalize_incomplete',
    );
  }
}

function inferGameSlug(gameDir: string): string {
  return resolve(gameDir).split(/[/\\]/).pop() ?? gameDir;
}

export async function runMigrateCli(argv: string[]): Promise<number> {
  const options = parseMigrateCliArgs(argv);
  const report = migrateVideoAssetDirectory({
    gameDir: options.gameDir,
    dryRun: options.dryRun,
  });
  logReport(report);

  if (options.uploadToActiveProvider) {
    if (options.dryRun) {
      throw new VideoAssetMigrationError(
        '--upload-to-active-provider cannot be combined with --dry-run',
        'invalid_cli_args',
      );
    }
    if (report.missingBlobs.length > 0) {
      throw new VideoAssetMigrationError(
        'Upload blocked until local blob gate passes',
        'missing_local_blobs',
      );
    }

    const gameSlug = inferGameSlug(options.gameDir);
    const authHeaders = readMigrationAuthHeaders();
    const localAssets = report.converted.assets.filter(
      (asset) => asset.provider.kind === 'local',
    );
    async function* localUploadSources() {
      for (const asset of localAssets) {
        yield {
          assetId: asset.id,
          body: Bun.file(
            resolve(options.gameDir, 'game-video', 'assets', asset.provider.ref),
          ),
          size: asset.bytes,
          fileName: `${asset.name}.mp4`,
          durationMs: asset.durationMs,
        };
      }
    }
    await uploadVideoAssetBatch({
      serverUrl: options.serverUrl,
      gameSlug,
      assets: localUploadSources(),
      authorization: authHeaders.authorization,
      cookie: authHeaders.cookie,
    });
    console.log(`uploaded ${localAssets.length} assets in one batch`);
  }

  return report.missingBlobs.length > 0 ? 2 : 0;
}

if (import.meta.main) {
  runMigrateCli(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) {
        process.exitCode = code;
      }
    })
    .catch((error) => {
      if (error instanceof VideoAssetMigrationError) {
        console.error(error.message);
        if (error.details?.missingBlobs) {
          logReport({
            converted: (error.details.converted as MigrationReport['converted']) ?? {
              version: 2,
              assets: [],
            },
            scenarioReferences: (error.details.scenarioReferences as MigrationReport['scenarioReferences']) ?? {
              referenced: [],
              missing: [],
            },
            legacyIgnored: (error.details.legacyIgnored as MigrationReport['legacyIgnored']) ?? {
              graphSnapshots: [],
            },
            missingBlobs: error.details.missingBlobs as MigrationReport['missingBlobs'],
            dryRun: false,
            wroteManifest: false,
            metadataOnly: true,
          });
        }
        process.exitCode = 2;
        return;
      }
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
