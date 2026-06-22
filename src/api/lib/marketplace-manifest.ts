// Locate marketplace/manifest.json across the supported deployment layouts.
//
// Probe order (first existing wins):
//   1. packages/marketplace under projectRoot (studio dev mode: projectRoot=studio root)
//   2. ../packages/marketplace (release mode: projectRoot=packages/<name>)
//   3. Legacy flat layouts (../marketplace, etc.) for older / non-submodule deploys.
//
// Centralized so /agents and /events/recent can't drift out of sync.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { friendlyPath } from './friendly-path';
import { assetRoot } from '../../lib/asset-root';

export function marketplaceManifestCandidates(projectRoot: string): string[] {
  return [
    // Host-bundled marketplace. assetRoot() = `packages/` in dev,
    // `<Resources>/resources/` in the packaged .app — covers both forms; the
    // projectRoot-relative probes below only matched the dev/repo layout.
    resolve(assetRoot(), 'marketplace/manifest.json'),
    resolve(projectRoot, 'packages/marketplace/manifest.json'),
    resolve(projectRoot, '../packages/marketplace/manifest.json'),
    resolve(projectRoot, '../../packages/marketplace/manifest.json'),
    resolve(projectRoot, 'marketplace/manifest.json'),
    resolve(projectRoot, '../marketplace/manifest.json'),
    resolve(projectRoot, '../../marketplace/manifest.json'),
  ];
}

export interface FoundManifest {
  path: string;
  triedFriendly: string[];
}

/**
 * Find the first existing marketplace/manifest.json among the supported
 * layouts. Returns `undefined` and the friendly-path list of probed
 * locations if none exist (caller decides how to surface the miss).
 */
export function findMarketplaceManifest(projectRoot: string): FoundManifest | { path: undefined; triedFriendly: string[] } {
  const candidates = marketplaceManifestCandidates(projectRoot);
  const path = candidates.find((p) => existsSync(p));
  if (path) return { path, triedFriendly: candidates.map((p) => friendlyPath(p)) };
  return { path: undefined, triedFriendly: candidates.map((p) => friendlyPath(p)) };
}
