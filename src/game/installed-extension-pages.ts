import { getExtensionSnapshot, type ExtensionSnapshot } from '@forgeax/orchestrator/extensions';

export interface InstalledExtensionPage {
  extensionId: string;
  pageId: string;
  label: string;
}

function displayName(manifest: ExtensionSnapshot['manifests'][number]['manifest']): string {
  if (typeof manifest.displayName === 'string') return manifest.displayName;
  if (manifest.displayName && typeof manifest.displayName === 'object') {
    const names = Object.values(manifest.displayName).filter((value): value is string => typeof value === 'string');
    if (names.length > 0) return names.join(' / ');
  }
  return manifest.id;
}

/** Extension UI moved from a dedicated KindRegistry slice to page contributions. */
export function installedExtensionPages(
  snapshot: ExtensionSnapshot = getExtensionSnapshot(),
): InstalledExtensionPage[] {
  const pages: InstalledExtensionPage[] = [];
  for (const extension of snapshot.manifests) {
    const label = displayName(extension.manifest);
    for (const page of extension.normalizedManifest.contributes.pages ?? []) {
      pages.push({
        extensionId: extension.manifest.id,
        pageId: page.id,
        label,
      });
    }
  }
  return pages;
}
