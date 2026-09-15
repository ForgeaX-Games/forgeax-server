import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

export const AW_CREDENTIAL_SCHEMA = 'forgeax.asset3d-credential/1.0.0';
export const AW_KEY_ENV = 'FORGEAX_ASSET3D_AW_SANDBOX_KEY';
const MAX_CREDENTIAL_BYTES = 4096;

interface CredentialRecord {
  readonly schemaVersion: typeof AW_CREDENTIAL_SCHEMA;
  readonly provider: 'aw';
  readonly sandboxKey: string;
}

function validateKey(value: string): string {
  if (!value || value.length > 2048 || [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  })) {
    throw new Error('asset3d_api_key_invalid: expected a non-empty printable key');
  }
  return value;
}

export function defaultAwCredentialFile(): string {
  const configured = process.env.FORGEAX_ASSET3D_CREDENTIAL_FILE;
  return resolve(configured || resolve(homedir(), '.forgeax', 'credentials', 'asset3d-aw.json'));
}

export function readAwCredential(pathInput: string): string | undefined {
  const path = resolve(pathInput);
  if (!isAbsolute(pathInput)) throw new Error('asset3d_credential_path_invalid: absolute path required');
  if (!existsSync(path)) return undefined;
  try {
    const metadata = lstatSync(path);
    const wrongOwner = typeof process.getuid === 'function' && metadata.uid !== process.getuid();
    if (!metadata.isFile() || metadata.isSymbolicLink() || wrongOwner) throw new Error();
    if ((metadata.mode & 0o077) !== 0 || metadata.size < 1 || metadata.size > MAX_CREDENTIAL_BYTES) throw new Error();
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CredentialRecord> & Record<string, unknown>;
    if (Object.keys(parsed).sort().join(',') !== 'provider,sandboxKey,schemaVersion') throw new Error();
    if (parsed.schemaVersion !== AW_CREDENTIAL_SCHEMA || parsed.provider !== 'aw' || typeof parsed.sandboxKey !== 'string') throw new Error();
    return validateKey(parsed.sandboxKey);
  } catch {
    throw new Error('asset3d_credential_invalid: credential file must be an owned 0600 regular file with the supported schema');
  }
}
