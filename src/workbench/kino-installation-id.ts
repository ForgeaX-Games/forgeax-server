import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const INSTALLATION_ID_RELATIVE_PATH = join('.forgeax', 'host', 'installation-id');

function installationIdPath(projectRoot: string): string {
  return join(projectRoot, INSTALLATION_ID_RELATIVE_PATH);
}

function validateInstallationId(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_-]{16,256}$/u.test(normalized)) {
    throw new Error('ForgeaX Kino installation id is invalid');
  }
  return normalized;
}

async function readInstallationId(path: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const value = await readFile(path, 'utf8');
    if (value.trim().length > 0) return validateInstallationId(value);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('ForgeaX Kino installation id is invalid');
}

/**
 * Returns the stable id for one ForgeaX installation, creating it once under
 * the project root when the installation has not been initialized yet.
 *
 * The id is deliberately independent of a game id. It is later combined with
 * the local game id by the service binding's HMAC scope function.
 */
export async function getOrCreateKinoInstallationId(projectRoot: string): Promise<string> {
  const path = installationIdPath(projectRoot);
  try {
    return await readInstallationId(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const created = `${randomUUID()}${randomUUID().replaceAll('-', '')}`;
  try {
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(created, 'utf8');
    } finally {
      await handle.close();
    }
    return created;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return await readInstallationId(path);
  }
}

export const KINO_INSTALLATION_ID_RELATIVE_PATH = INSTALLATION_ID_RELATIVE_PATH;
