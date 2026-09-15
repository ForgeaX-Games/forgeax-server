/** Asset sourcing for hosts that own their Engine and import lifecycle.
 * This surface deliberately produces checked source files, never Engine GUIDs.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Worker, isMainThread } from 'node:worker_threads';
import { existsSync, lstatSync, readFileSync, realpathSync, readdirSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { BUNDLED_ASSET3D_PROVIDERS, ASSET3D_PROVIDER_COMMIT, sha256 } from './constants';
import { resolveAssetLibrarySelection, checkAssetLibraryProviderAccess, type AssetLibraryId } from './aw-access';
import { defaultAwCredentialFile, readAwCredential } from './credentials';
import { packagedAsset3dProvider, prepareAsset3dProvider, defaultLibraryAssetsRoot } from './provider';
import { canonicalizeOrigins } from './origins';
import { atomicWrite, ensurePrivateDir } from './fs';
import { parseProviderResult, type ProviderSuccess } from './schema';

export interface LibrarySourceOptions {
  projectRoot: string;
  queries: readonly string[];
  library?: AssetLibraryId;
  /** Packaged resource root supplied by a host's installer. */
  assetsRoot?: string;
  /** A compiled host stages this worker alongside the immutable provider assets. */
  workerPath?: string;
}

export function validateLibrarySources(root: string, items: readonly ProviderSuccess[]): void {
  const canonical = realpathSync(root);
  const declared = new Set<string>();
  for (const item of items) for (const file of item.manifest) {
    const path = resolve(root, file.path);
    const rel = relative(canonical, realpathSync(path));
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('asset_source_escape');
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes || sha256(readFileSync(path)) !== file.sha256) {
      throw new Error('asset_source_digest_mismatch');
    }
    if (declared.has(file.path)) throw new Error('asset_source_collision');
    declared.add(file.path);
  }
  function walk(dir: string): void {
    for (const name of readdirSync(dir)) {
      const path = resolve(dir, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error('asset_source_symlink');
      if (info.isDirectory()) walk(path);
      else if (!info.isFile() || !declared.delete(relative(root, path).split(sep).join('/'))) throw new Error('asset_source_undeclared');
    }
  }
  walk(root);
  if (declared.size) throw new Error('asset_source_missing');
}

/** One bounded MCP transaction. No shell, user config mutation or global MCP registration. */
async function search(command: string, env: NodeJS.ProcessEnv, args: Record<string, unknown>): Promise<string> {
  const child = spawn(command, [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  // Provider diagnostics may contain URLs/credentials; surface structured tool errors only.
  child.stderr.resume();
  try {
    return await new Promise<string>((done, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('asset_library_search_timeout')), 195_000);
      const fail = (error: Error) => { clearTimeout(timer); reject(error); };
      child.on('error', () => fail(new Error('asset_library_provider_start_failed')));
      child.stdin.on('error', () => fail(new Error('asset_library_provider_write_failed')));
      child.on('exit', () => fail(new Error('asset_library_provider_exited')));
      const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
      child.stdout.on('data', (data: Buffer) => {
        buffer += data.toString('utf8');
        if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) return fail(new Error('asset_library_response_too_large'));
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (!line.trim()) continue;
          try {
            const message = JSON.parse(line);
            if (message.error) return fail(new Error('asset_library_provider_protocol_error'));
            if (message.id === 1) {
              send({ jsonrpc: '2.0', method: 'notifications/initialized' });
              send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_asset', arguments: args } });
            } else if (message.id === 2) {
              const texts = message.result?.content?.filter((v: { type?: string }) => v.type === 'text');
              if (message.result?.isError || texts?.length !== 1 || typeof texts[0].text !== 'string') return fail(new Error('asset_library_provider_result_invalid'));
              clearTimeout(timer); done(texts[0].text);
            }
          } catch { return fail(new Error('asset_library_provider_protocol_error')); }
        }
      });
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'forgeax-host-assets', version: '1.0.0' } } });
    });
  } finally {
    child.stdin.end(); child.kill('SIGTERM');
    const kill = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2_000);
    kill.unref(); child.once('exit', () => clearTimeout(kill));
  }
}

export async function searchLibrarySources(options: LibrarySourceOptions) {
  // Provisioning uses the official synchronous verifier. Keep it off the host's
  // event loop so chat, progress events and Editor traffic remain responsive.
  if (isMainThread) return new Promise<LibrarySourceReceipt>((done, reject) => {
    const worker = new Worker(options.workerPath ?? resolve(options.assetsRoot ?? defaultLibraryAssetsRoot(), 'worker.js'), { workerData: { ...options, assetsRoot: options.assetsRoot ?? defaultLibraryAssetsRoot() }, execArgv: process.execArgv.filter(arg => !arg.startsWith('--input-type')) });
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error('asset_library_timeout')); }, 300_000);
    worker.once('message', message => { clearTimeout(timer); void worker.terminate(); message.error ? reject(new Error(message.error)) : done(message.value); });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('exit', code => { clearTimeout(timer); reject(new Error(`asset_library_worker_exit:${code}`)); });
  });
  const root = realpathSync(options.projectRoot);
  if (!existsSync(resolve(root, 'forge.json'))) throw new Error('asset_library_game_required');
  if (!Array.isArray(options.queries) || options.queries.length < 1 || options.queries.length > 8 || options.queries.some(q => typeof q !== 'string' || !q.trim() || [...q].length > 200)) throw new Error('asset_library_queries_invalid');
  const selection = resolveAssetLibrarySelection({ library: options.library ?? process.env.FORGEAX_ASSET_LIBRARY ?? 'ea' });
  const target = `${platform()}-${arch()}` as keyof typeof BUNDLED_ASSET3D_PROVIDERS;
  const bundle = BUNDLED_ASSET3D_PROVIDERS[target];
  if (!bundle) throw new Error(`asset3d_provider_target_unreleased: ${target}`);
  const credentialFile = defaultAwCredentialFile();
  if (!readAwCredential(credentialFile)) throw new Error('asset3d_api_key_required: configure the official asset-library credential before searching');
  const cache = prepareAsset3dProvider({ providerBundle: packagedAsset3dProvider(bundle.relativePath, options.assetsRoot), expectedSha256: bundle.sha256 });
  const access = checkAssetLibraryProviderAccess({ providerCache: cache, depotName: selection.library, serviceRoot: selection.serviceRoot, credentialFile });
  const origins = canonicalizeOrigins(access.downloadOrigins);
  const execution = randomUUID();
  for (const directory of [resolve(root, '.forgeax'), resolve(root, '.forgeax', 'library-sources')]) {
    if (!existsSync(directory)) continue;
    const rel = relative(root, realpathSync(directory));
    if (lstatSync(directory).isSymbolicLink() || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('asset_library_source_escape');
  }
  const quarantine = resolve(root, '.forgeax', 'library-sources', execution);
  const sourceRoot = resolve(quarantine, 'workspace', 'asset3d');
  ensurePrivateDir(sourceRoot);
  const payload = await search(resolve(cache, 'bin', 'asset3d-search'), {
    ...process.env, ASSET3D_CATALOG_BASE_URL: '', AW_API_SANDBOX_KEY: '',
    AW_API_BASE_URL: selection.serviceRoot, AW_API_DEPOT_NAME: selection.library, AW_API_CREDENTIAL_FILE: credentialFile,
    AW_DOWNLOAD_ORIGINS: origins.compactJson, FBX2GLTF_BIN: resolve(cache, 'bin', 'FBX2glTF'),
    MCP_SHARED_PATH: resolve(quarantine, 'workspace'), MCP_WORKSPACE_ROOT: resolve(quarantine, 'workspace'), MCP_GAME_RUNTIME_ROOT: resolve(quarantine, 'game-runtime'),
  }, { queries: options.queries, output_dir: 'workspace/asset3d', output_format: 'glb' });
  const result = parseProviderResult(payload, ASSET3D_PROVIDER_COMMIT, origins.digest);
  if (result.total !== options.queries.length || result.results.some(item => item.query !== options.queries[item.queryIndex])) throw new Error('asset_library_query_identity_mismatch');
  validateLibrarySources(sourceRoot, result.results.filter((item): item is ProviderSuccess => item.status === 'ok'));
  const receipt: LibrarySourceReceipt = { schemaVersion: 'forgeax.host-library-sources/1.0.0', execution, library: selection.library, providerCommit: ASSET3D_PROVIDER_COMMIT, sourceRoot, result };
  atomicWrite(resolve(quarantine, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

export interface LibrarySourceReceipt {
  schemaVersion: 'forgeax.host-library-sources/1.0.0';
  execution: string;
  library: AssetLibraryId;
  providerCommit: string;
  sourceRoot: string;
  result: ReturnType<typeof parseProviderResult>;
}

/** Recheck bytes at import time. Callers accept an opaque receipt identity, never a path. */
export function readLibrarySource(projectRoot: string, execution: string, assetId: string) {
  if (!/^[a-f0-9-]{36}$/.test(execution)) throw new Error('asset_library_execution_invalid');
  const root = realpathSync(projectRoot);
  const quarantine = resolve(root, '.forgeax', 'library-sources', execution);
  const sourceRoot = resolve(quarantine, 'workspace', 'asset3d');
  const receipt = JSON.parse(readFileSync(resolve(quarantine, 'receipt.json'), 'utf8'));
  if (receipt.schemaVersion !== 'forgeax.host-library-sources/1.0.0' || receipt.execution !== execution || receipt.sourceRoot !== sourceRoot || !['ea', 'aw'].includes(receipt.library)) throw new Error('asset_library_receipt_invalid');
  const rel = relative(root, realpathSync(sourceRoot));
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('asset_library_source_escape');
  const result = parseProviderResult(JSON.stringify(receipt.result), ASSET3D_PROVIDER_COMMIT, receipt.result.receipt?.originSetDigest);
  const items = result.results.filter((item): item is ProviderSuccess => item.status === 'ok');
  validateLibrarySources(sourceRoot, items);
  const item = items.find(item => item.providerAssetId === assetId);
  if (!item) throw new Error('asset_library_asset_missing');
  return { library: receipt.library as AssetLibraryId, sourceRoot, item };
}
