import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  RuntimeRegistry,
  ToolExecutor,
} from '@forgeax/workbench-host/node';

describe('Workbench generic capability routing', () => {
  test('defers a declared video requirement to the generic resolver', async () => {
    const fixtureRoot = join(import.meta.dir, '../fixtures/workbench-generic-capability');
    const registry = new RuntimeRegistry();
    registry.register({
      packageRoot: fixtureRoot,
      backendEntry: 'host.mjs',
      frontendEntry: 'unused.html',
      manifestPath: join(fixtureRoot, 'forgeax-extension.json'),
      manifest: {
        id: '@forgeax-extension/test-generic-capability',
        version: '1.0.0',
        tools: [{
          id: 'fixture:generate',
          inputSchema: 'args.json',
          exposedToAI: true,
          requiresCapabilities: [{ id: 'media.video.generate', version: 1 }],
        }],
        provides: { workbench: {} },
      },
    } as never);

    let legacyBrokerCalls = 0;
    const capabilityCalls: unknown[][] = [];
    const executor = new ToolExecutor({
      registry,
      workspace: {
        withGameRoot: async (_gameId: string, _options: unknown, operation: (scope: unknown) => Promise<unknown>) => (
          operation({ gameRoot: '/project/.forgeax/games/game-1', files: {} })
        ),
      } as never,
      versioning: {} as never,
      isExtensionTrusted: () => true,
      capabilityResolver: {
        forGame: () => ({
          async invoke(...args) {
            capabilityCalls.push(args);
            return { provider: 'private-kino' };
          },
        }),
      },
      videoGeneration: async () => {
        legacyBrokerCalls += 1;
        throw new Error('legacy broker must not be resolved');
      },
    });

    await expect(executor.call({
      caller: 'ui',
      toolId: 'fixture:generate',
      gameId: 'game-1',
      args: {},
    })).resolves.toEqual({ ok: true, result: { provider: 'private-kino' } });
    expect(legacyBrokerCalls).toBe(0);
    expect(capabilityCalls).toEqual([[
      'media.video.generate',
      1,
      { prompt: 'fixture' },
      undefined,
    ]]);
  });
});
