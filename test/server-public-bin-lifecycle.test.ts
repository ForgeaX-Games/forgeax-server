import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function invoke(args: string[], env: Record<string, string>) {
  const child = Bun.spawn(['bun', 'bin/forgeax-server', ...args], {
    env: { ...Bun.env, ...env }, stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe('forgeax-server public bin lifecycle', () => {
  it('owns start/status/diagnostics/stop with real process health', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-server-contract-'));
    roots.push(root);
    const env = { FORGEAX_SERVER_PORT: '29042', FORGEAX_SERVER_STATE_FILE: join(root, 'state.json') };

    const started = await invoke(['start', '--json'], env);
    expect(started.exitCode).toBe(0);
    expect(JSON.parse(started.stdout)).toMatchObject({ status: 'ready', phase: 'start' });

    const status = await invoke(['status', '--json'], env);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ status: 'ready', phase: 'status' });

    const diagnostics = await invoke(['diagnostics', '--json'], env);
    expect(diagnostics.exitCode).toBe(0);
    expect(JSON.parse(diagnostics.stdout)).toMatchObject({ component: 'forgeax-server', retryable: false });

    expect((await invoke(['stop', '--json'], env)).exitCode).toBe(0);
    const repeatedStop = await invoke(['stop', '--json'], env);
    expect(repeatedStop.exitCode).toBe(0);
    expect(JSON.parse(repeatedStop.stdout)).toMatchObject({ status: 'stopped', alreadyStopped: true });
  });

  it('fails status with structured recovery when stopped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-server-contract-'));
    roots.push(root);
    const result = await invoke(['status', '--json'], {
      FORGEAX_SERVER_PORT: '29043', FORGEAX_SERVER_STATE_FILE: join(root, 'state.json'),
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      code: 'SERVER_PUBLIC_NOT_READY', recoveryActions: ['forgeax-server start --json'],
    });
  });
});
