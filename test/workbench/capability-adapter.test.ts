import { describe, expect, test } from 'bun:test';
import type { ExtensionCapabilityInvocationContext } from '@forgeax/orchestrator';
import { createForgeaxWorkbenchCapabilityResolver } from '../../src/workbench/capability-adapter';

describe('createForgeaxWorkbenchCapabilityResolver', () => {
  test('binds each Workbench invocation to the requested game and shared registry', async () => {
    let observedContext: ExtensionCapabilityInvocationContext | undefined;
    const invocations: unknown[][] = [];
    const resolver = createForgeaxWorkbenchCapabilityResolver({
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
      caller: { kind: 'workbench' },
      toolId: 'workbench-host',
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
