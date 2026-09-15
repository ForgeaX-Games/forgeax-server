import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, lstatSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, platform, arch } from 'node:os';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSET3D_PROVIDER_COMMIT, sha256 } from './constants';

export function defaultLibraryAssetsRoot(): string {
  return process.env.FORGEAX_RESOURCE_ROOT
    ? resolve(process.env.FORGEAX_RESOURCE_ROOT, 'product/asset-library')
    : fileURLToPath(new URL('../../../assets/asset-library/', import.meta.url));
}
export function packagedAsset3dProvider(path: string, root = defaultLibraryAssetsRoot()): string {
  const canonical = realpathSync(root);
  const candidate = realpathSync(resolve(root, path));
  const rel = relative(canonical, candidate);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || !lstatSync(candidate).isFile()) throw new Error('asset_library_provider_resource_invalid');
  return candidate;
}
function run(command: string, args: string[], maxBuffer = 4 * 1024 * 1024): string {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, maxBuffer });
  if (result.status !== 0) throw new Error('asset_library_provider_verification_failed');
  return result.stdout;
}
export function prepareAsset3dProvider(options: { providerBundle: string; expectedSha256: string }): string {
  const { providerBundle: archive, expectedSha256: digest } = options;
  if (sha256(readFileSync(archive)) !== digest) throw new Error('asset_library_provider_digest_mismatch');
  const manifest = JSON.parse(run('tar', ['-xOzf', archive, 'bundle-manifest.json']));
  if (manifest.schema !== 'forgeax.asset3d-provider-bundle/1.0.0' || manifest.providerCommit !== ASSET3D_PROVIDER_COMMIT || manifest.target !== `${platform()}-${arch()}`) throw new Error('asset_library_provider_identity_mismatch');
  const python = ['python3.12', 'python3.11', 'python3'].find(command => {
    const result = spawnSync(command, ['-B', '-c', 'import sys;print("%d.%d"%sys.version_info[:2])'], { encoding: 'utf8' });
    return result.status === 0 && /^(3\.11|3\.12)\s*$/.test(result.stdout);
  });
  if (!python) throw new Error('asset_library_python_required: Python 3.11 or 3.12');
  const root = resolve(homedir(), '.forgeax/providers/asset3d-search');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const cache = resolve(root, digest);
  const stage = mkdtempSync(join(root, '.studio-verify-'));
  try {
    const verifier = resolve(stage, 'verify.py');
    // Only execute the verifier extracted from the digest-pinned official bundle.
    writeFileSync(verifier, run('tar', ['-xOzf', archive, 'verify/verify_asset3d_bundle.py']), { mode: 0o600 });
    if (existsSync(cache)) {
      run(python, ['-B', verifier, '--stage', cache, '--json']);
    } else {
      run(python, ['-B', verifier, '--archive', archive, '--sha256', digest, '--provision', cache, '--python', python, '--json']);
    }
    if (!existsSync(resolve(cache, 'bin/asset3d-search'))) throw new Error('asset_library_provider_missing');
    return realpathSync(cache);
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
