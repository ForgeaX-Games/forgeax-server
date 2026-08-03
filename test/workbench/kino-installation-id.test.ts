import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getOrCreateKinoInstallationId,
  KINO_INSTALLATION_ID_RELATIVE_PATH,
} from '../../src/workbench/kino-installation-id';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('getOrCreateKinoInstallationId', () => {
  test('creates the id once at the ForgeaX host path and reuses it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-kino-installation-'));
    roots.push(root);

    const first = await getOrCreateKinoInstallationId(root);
    const second = await getOrCreateKinoInstallationId(root);

    expect(first).toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]{16,256}$/u);
    expect(await readFile(join(root, KINO_INSTALLATION_ID_RELATIVE_PATH), 'utf8')).toBe(first);
  });

  test('concurrent first reads converge on one id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-kino-installation-race-'));
    roots.push(root);

    const values = await Promise.all(
      Array.from({ length: 8 }, () => getOrCreateKinoInstallationId(root)),
    );

    expect(new Set(values).size).toBe(1);
  });
});
