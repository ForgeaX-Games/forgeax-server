import { describe, expect, test } from 'bun:test';
import type { ExtensionSnapshot } from '@forgeax/orchestrator/extensions';
import { installedExtensionPages } from '../src/game/installed-extension-pages';

describe('installedExtensionPages', () => {
  test('derives extension entries from normalized page contributions', () => {
    const snapshot = {
      manifests: [
        {
          manifest: { id: '@forgeax-extension/character', displayName: { zh: '角色编辑', en: 'Character Editor' } },
          normalizedManifest: { contributes: { pages: [{ id: 'character' }] } },
        },
        {
          manifest: { id: '@forgeax-extension/tools', displayName: 'Tools' },
          normalizedManifest: { contributes: { pages: [{ id: 'tools-a' }, { id: 'tools-b' }] } },
        },
        {
          manifest: { id: '@forgeax-extension/headless', displayName: 'Headless' },
          normalizedManifest: { contributes: {} },
        },
      ],
    } as unknown as ExtensionSnapshot;

    expect(installedExtensionPages(snapshot)).toEqual([
      {
        extensionId: '@forgeax-extension/character',
        pageId: 'character',
        label: '角色编辑 / Character Editor',
      },
      { extensionId: '@forgeax-extension/tools', pageId: 'tools-a', label: 'Tools' },
      { extensionId: '@forgeax-extension/tools', pageId: 'tools-b', label: 'Tools' },
    ]);
  });
});
