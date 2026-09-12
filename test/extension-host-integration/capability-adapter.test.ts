import { describe, expect, test } from 'bun:test';
import type { ExtensionCapabilityInvocationContext } from '@forgeax/orchestrator';
import { createForgeaxExtensionCapabilityResolver } from '../../src/extension-host-integration/capability-adapter';

describe('createForgeaxExtensionCapabilityResolver', () => {
  test('binds each Extension invocation to the requested game and shared registry', async () => {
    let observedContext: ExtensionCapabilityInvocationContext | undefined;
    const invocations: unknown[][] = [];
    const resolver = createForgeaxExtensionCapabilityResolver({
      projectRoot: '/project',
      createScopedCapabilities(context) {
        observedContext = context;
        return {
          has: () => true,
          async invoke(...args) {
            invocations.push(args);
            return { ok: true };
          },
        };
      },
    });

    await expect(resolver.forGame('game-1').invoke(
      'media.video.generate',
      1,
      { prompt: 'test' },
      { requestId: 'request-1' },
    )).resolves.toEqual({ ok: true });

    expect(observedContext).toEqual({
      caller: { kind: 'extension', extensionId: '@forgeax/extension-host', instanceId: 'game:game-1' },
      toolId: 'extension-host',
      env: {},
      cwd: '/project',
      projectRoot: '/project',
      game: 'game-1',
    });
    expect(invocations).toEqual([[
      'media.video.generate',
      1,
      { prompt: 'test' },
      { requestId: 'request-1' },
    ]]);
  });
});
