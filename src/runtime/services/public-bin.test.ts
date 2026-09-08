import { describe, expect, it } from 'bun:test';

describe('forgeax-server public process', () => {
  it('serves a real JSON lifecycle health contract', async () => {
    const process = Bun.spawn(['bun', 'bin/forgeax-server'], { env: { ...Bun.env, FORGEAX_SERVER_PORT: '19032' }, stdout: 'pipe', stderr: 'pipe' });
    try {
      for (let i = 0; i < 20; i += 1) {
        try {
          const response = await fetch('http://127.0.0.1:19032/health');
          const payload = await response.json();
          expect(response.status).toBe(200);
          expect(payload).toMatchObject({ status: 'ready', service: 'forgeax-server', lifecycle: 'public' });
          return;
        } catch { await Bun.sleep(50); }
      }
      throw new Error('SERVER_PUBLIC_HEALTH_NOT_READY');
    } finally { process.kill(); }
  });
});
