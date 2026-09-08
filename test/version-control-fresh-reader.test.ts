import { expect, test } from 'bun:test';
import { saveAndVerifyAuthoritative, verifyAuthoritativeSave } from '../src/game/version-control';

test('server durability helper rejects the writer realm as an independent reader', async () => {
  const result = await verifyAuthoritativeSave({
    requestId: 'save-server-1',
    writerRealmId: 'writer',
    authoritative: { version: 2 },
    createFreshReader: async () => ({ realmId: 'writer', read: async () => ({ version: 2 }) }),
  });

  expect(result).toMatchObject({ state: 'unknown', error: { code: 'reader-not-independent' } });
});

test('server durability helper returns clean only for an equal fresh value', async () => {
  const result = await verifyAuthoritativeSave({
    requestId: 'save-server-2',
    writerRealmId: 'writer',
    authoritative: { version: 2, nested: { b: 2, a: 1 } },
    createFreshReader: async () => ({ realmId: 'reader', read: async () => ({ nested: { a: 1, b: 2 }, version: 2 }) }),
  });

  expect(result).toMatchObject({ state: 'clean', readerRealmId: 'reader' });
});

test('server durability helper preserves unknown state when the Host write fails', async () => {
  const result = await saveAndVerifyAuthoritative({
    requestId: 'save-server-3',
    writerRealmId: 'writer',
    save: async () => { throw new Error('host unavailable'); },
    createFreshReader: async () => ({ realmId: 'reader', read: async () => ({ version: 2 }) }),
  });

  expect(result).toMatchObject({ state: 'unknown', error: { code: 'save-failed' } });
});
