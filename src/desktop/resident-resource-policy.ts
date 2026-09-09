import { isAbsolute, win32 } from 'node:path';
import type { ResidentResourcePolicy } from '@forgeax/orchestrator/seams';

/** Studio owns these historical packaging layouts, not Orchestrator.
 * Compare the complete resource identity, including package and nested path;
 * never use an agent name or filename alone to recover a missing resource.
 */
function installedResourceIdentity(path: string): string | undefined {
  if (!isAbsolute(path) && !win32.isAbsolute(path)) return;
  const normalized = path.replaceAll('\\', '/');
  if (normalized.split('/').some(part => part === '.' || part === '..')) return;
  const app = normalized.match(/\/[^/]+\.app\/Contents\/Resources\/(.+)$/);
  const resource = app?.[1] ?? normalized.match(/\/(resources\/brand\/.+|(?:resources\/)?product\/node_modules\/.+)$/)?.[1];
  if (resource && /^(resources\/brand\/|(?:resources\/)?product\/node_modules\/)/.test(resource)) return resource;
}

/** Studio opts into frozen, session-local resources. Existing sessions retain
 * their copied instructions across upgrades; new sessions use current assets.
 * This does not authorize a permission change or replacement of custom files.
 */
export const studioResidentResourcePolicy: ResidentResourcePolicy = {
  persistence: 'snapshot',
  acceptsSource: source => source.kind === 'brand' || source.origin === 'builtin',
  matchesLegacyPath(configuredPath, currentPath) {
    const identity = installedResourceIdentity(configuredPath);
    return identity !== undefined && identity === installedResourceIdentity(currentPath);
  },
};
