import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as composition from '../src/composition';
import { getExtensionSnapshot, reloadExtensions } from '@forgeax/orchestrator/extensions';

test('product configuration and server readers share the extension registry across reloads', async () => {
  expect(composition.configureNpmExtensionDirs).toBeFunction();
  const root = mkdtempSync(join(tmpdir(), 'server-product-registry-'));
  const options = {
    roots: { builtin: null, user: null, project: null },
    devRegistrationFile: null,
  };
  try {
    writeFileSync(join(root, 'forgeax-extension.json'), JSON.stringify({
      schemaVersion: 2,
      id: '@forgeax-extension/registry-fixture',
      version: '0.1.0',
      displayName: { en: 'Registry fixture' },
      contributes: {},
    }));
    composition.configureNpmExtensionDirs([root]);
    for (let reload = 0; reload < 2; reload++) {
      await reloadExtensions(options);
      expect(getExtensionSnapshot().manifests.map(({ manifest }) => manifest.id))
        .toEqual(['@forgeax-extension/registry-fixture']);
    }
  } finally {
    composition.configureNpmExtensionDirs([]);
    await reloadExtensions(options);
    rmSync(root, { recursive: true, force: true });
  }
});
