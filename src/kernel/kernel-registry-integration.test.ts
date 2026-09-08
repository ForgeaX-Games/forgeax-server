import { expect, test } from 'bun:test';
import { listAvailableKernels } from '@forgeax/orchestrator/kernel';
import { registerForgeaxCoreKernel } from './forgeax-core-adapter';

test('the product native kernel is visible to the chat kernel selector', () => {
  const registered = registerForgeaxCoreKernel();
  expect(listAvailableKernels().find(({ id }) => id === 'forgeax-core')).toBe(registered);
  expect(registerForgeaxCoreKernel()).toBe(registered);
});
