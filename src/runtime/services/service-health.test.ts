import { describe, expect, test } from 'bun:test';
import { ServiceHealthMonitor, type ServiceHealthV1 } from './service-health';

function report(overrides: Partial<ServiceHealthV1> = {}): ServiceHealthV1 {
  return {
    protocol: 'ServiceHealthV1',
    serviceId: 'forgeax-runtime',
    version: '1.0.0',
    status: 'ready',
    ...overrides,
  };
}

describe('ServiceHealthMonitor', () => {
  test('rejects an incompatible service version with recovery metadata', async () => {
    const monitor = new ServiceHealthMonitor({ expectedVersion: '1.0.0' });
    await expect(monitor.assertCompatible(report({ version: '2.0.0' }))).rejects.toMatchObject({
      code: 'SERVICE_VERSION_MISMATCH',
      expected: '1.0.0',
      actual: '2.0.0',
      retryable: false,
      recoveryActions: ['install-compatible-service'],
    });
  });

  test('waits for readiness and reports a bounded timeout', async () => {
    const states = [report({ status: 'starting' }), report({ status: 'starting' })];
    const monitor = new ServiceHealthMonitor({
      expectedVersion: '1.0.0',
      pollIntervalMs: 1,
    });
    await expect(monitor.waitUntilReady(async () => states.shift() ?? report({ status: 'starting' }), 2)).rejects.toMatchObject({
      code: 'SERVICE_READY_TIMEOUT',
      retryable: true,
      recoveryActions: ['restart-service', 'inspect-service-logs'],
    });
  });

  test('restarts at most the configured bound and shuts down once', async () => {
    let restarts = 0;
    let shutdowns = 0;
    const monitor = new ServiceHealthMonitor({ expectedVersion: '1.0.0', maxRestarts: 2 });
    await expect(monitor.restartUntilReady(async () => report({ status: 'failed' }), async () => { restarts += 1; }, 2)).rejects.toMatchObject({
      code: 'SERVICE_RESTART_EXHAUSTED',
      actual: 2,
      recoveryActions: ['inspect-service-logs', 'rollback-service-artifact'],
    });
    await monitor.shutdown(async () => { shutdowns += 1; });
    await monitor.shutdown(async () => { shutdowns += 1; });
    expect(restarts).toBe(2);
    expect(shutdowns).toBe(1);
  });
});
