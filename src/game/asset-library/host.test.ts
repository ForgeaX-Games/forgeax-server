import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateLibrarySources, readLibrarySource } from './host';
import { sha256 } from './constants';
import type { ProviderSuccess } from './schema';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'host-source-')); roots.push(root);
  const bytes = Buffer.from('glTF'); writeFileSync(join(root, 'kart.glb'), bytes);
  const item: ProviderSuccess = { status: 'ok', queryIndex: 0, query: 'kart', provider: 'ea-3d', providerAssetId: 'kart', assetName: 'Kart', deliveredFormat: 'glb', sha256: 'unused', bytes: bytes.length, primaryModel: 'kart.glb', originSetDigest: 'unused', manifest: [{ path: 'kart.glb', role: 'primary-model', bytes: bytes.length, sha256: sha256(bytes) }] };
  return { root, item };
}
test('hosted sources validate without installing or resolving a standalone Engine', () => {
  const { root, item } = fixture();
  expect(() => validateLibrarySources(root, [item])).not.toThrow();
});
test('changed bytes and undeclared downloads fail before host import', () => {
  const { root, item } = fixture();
  writeFileSync(join(root, 'kart.glb'), 'oops');
  expect(() => validateLibrarySources(root, [item])).toThrow('asset_source_digest_mismatch');
  writeFileSync(join(root, 'kart.glb'), 'glTF'); writeFileSync(join(root, 'extra'), 'bad');
  expect(() => validateLibrarySources(root, [item])).toThrow('asset_source_undeclared');
});
test('symlink source and receipt path traversal are rejected', () => {
  const { root, item } = fixture(); const other = fixture();
  rmSync(join(root, 'kart.glb')); symlinkSync(join(other.root, 'kart.glb'), join(root, 'kart.glb'));
  expect(() => validateLibrarySources(root, [item])).toThrow('asset_source_escape');
  expect(() => readLibrarySource(root, '../../other', 'kart')).toThrow('asset_library_execution_invalid');
});
