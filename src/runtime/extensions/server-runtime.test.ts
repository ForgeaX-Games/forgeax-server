import { describe, expect, test } from 'bun:test';
import { createServerRuntimeAdapter } from './server-adapter';

describe('server runtime adapter contract', () => {
  test('exposes the public service lock and health lifecycle', async () => {
    const events: string[] = [];
    const adapter = createServerRuntimeAdapter({
      serviceLock: { serviceId: 'forgeax-runtime', version: '1.0.0', artifact: 'sha256:runtime' },
      health: {
        protocol: 'ServiceHealthV1',
        serviceId: 'forgeax-runtime',
        version: '1.0.0',
        status: 'ready',
      },
      onShutdown: async () => { events.push('shutdown'); },
    });
    expect(adapter.lock()).toEqual({ serviceId: 'forgeax-runtime', version: '1.0.0', artifact: 'sha256:runtime' });
    expect((await adapter.health()).status).toBe('ready');
    await adapter.shutdown();
    expect(events).toEqual(['shutdown']);
  });
});
