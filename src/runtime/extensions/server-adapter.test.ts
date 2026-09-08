import { describe, expect, test } from 'bun:test';
import { createServerRuntimeAdapter } from './server-adapter';

describe('Server runtime adapter public boundary', () => {
  test('forwards the published lock and ServiceHealthV1 state without source paths', async () => {
    const adapter = createServerRuntimeAdapter({
      serviceLock: { serviceId: 'forgeax-runtime', version: '1.0.0', artifact: 'sha256:runtime' },
      health: { protocol: 'ServiceHealthV1', serviceId: 'forgeax-runtime', version: '1.0.0', status: 'ready' },
    });
    expect(adapter.lock().artifact).toBe('sha256:runtime');
    expect((await adapter.health()).protocol).toBe('ServiceHealthV1');
    expect(JSON.stringify(adapter)).not.toMatch(/src\/|node_modules/);
  });
});
