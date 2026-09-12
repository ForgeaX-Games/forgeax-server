import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('game host registration rejects missing evidence and projects scoped delivery status', () => {
  // Isolate optional-adapter mocks from the rest of the Server test suite.
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./host-tool-evidence.fixture.ts', import.meta.url))], { encoding: 'utf8' });
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
