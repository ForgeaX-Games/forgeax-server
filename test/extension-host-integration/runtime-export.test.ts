import { expect, test } from 'bun:test';

test('publishes the canonical extension-host runtime entrypoint', async () => {
  const runtime = await import('../../src/extension-host-integration/runtime');
  expect(typeof runtime.createForgeaxExtensionHostGetter).toBe('function');
  expect(typeof runtime.createForgeaxExtensionHostDependencies).toBe('function');
  expect(typeof runtime.resolveInstalledExtensionPackage).toBe('function');
});
