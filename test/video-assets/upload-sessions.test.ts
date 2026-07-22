import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { KinoApiError } from '../../src/video-assets/kino-api';
import {
  MAX_VIDEO_UPLOAD_BYTES,
  UploadSessionStore,
  type UploadSession,
} from '../../src/video-assets/upload-sessions';

let assetsDir: string;
let store: UploadSessionStore;

const baseInput = {
  gameId: 'demo',
  identity: 'user-1',
  fileName: 'clip.mp4',
  mimeType: 'video/mp4' as const,
  bytes: 1024,
  providerKind: 'local' as const,
  providerState: { path: '/tmp/part' },
};

async function expectKinoError(
  action: Promise<unknown> | (() => unknown),
  status: number,
  errorCode: string,
): Promise<void> {
  try {
    if (typeof action === 'function') {
      action();
    } else {
      await action;
    }
    throw new Error('expected KinoApiError');
  } catch (error) {
    expect(error).toBeInstanceOf(KinoApiError);
    expect((error as KinoApiError).status).toBe(status);
    expect((error as KinoApiError).errorCode).toBe(errorCode);
  }
}

function sessionFile(token: string): string {
  return resolve(assetsDir, '.uploads', `${token}.json`);
}

beforeEach(() => {
  assetsDir = mkdtempSync(join(tmpdir(), 'video-assets-uploads-'));
  store = new UploadSessionStore(assetsDir);
});

afterEach(() => {
  rmSync(assetsDir, { recursive: true, force: true });
});

describe('UploadSessionStore persistence', () => {
  test('writes session files with mode 0600', async () => {
    const session = await store.create(baseInput);
    const mode = statSync(resolve(assetsDir, '.uploads', `${session.token}.json`)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('survives restart by reading persisted json', async () => {
    const created = await store.create(baseInput);
    const reloaded = new UploadSessionStore(assetsDir);
    await expect(reloaded.read(created.token)).resolves.toEqual(created);
  });

  test('writes atomically without leaving temp files', async () => {
    const session = await store.create(baseInput);
    expect(JSON.parse(readFileSync(sessionFile(session.token), 'utf-8'))).toEqual(session);
    expect(readdirSync(resolve(assetsDir, '.uploads')).filter((name) => name.includes('.tmp-'))).toEqual(
      [],
    );
  });

  test('cleans the temp file when atomic rename fails', async () => {
    const failingStore = new UploadSessionStore(assetsDir, {
      rename: () => {
        throw Object.assign(new Error('rename failed'), { code: 'EIO' });
      },
    });

    await expectKinoError(
      failingStore.create(baseInput),
      500,
      'upload_session_storage_error',
    );
    expect(readdirSync(resolve(assetsDir, '.uploads')).filter((name) => name.includes('.tmp-'))).toEqual(
      [],
    );
  });

  test('rejects malformed sessions and token mismatches fail closed', async () => {
    const created = await store.create(baseInput);
    const valid = JSON.parse(readFileSync(sessionFile(created.token), 'utf-8')) as UploadSession;
    const corruptions: Array<[string, unknown]> = [
      ['token', 'not-a-token'],
      ['gameId', ''],
      ['identity', ''],
      ['fileName', ''],
      ['mimeType', 'video/webm'],
      ['bytes', null],
      ['createdAt', null],
      ['expiresAt', null],
      ['providerKind', 'ftp'],
      ['providerState', []],
      ['resourceId', 42],
      ['completedResourceId', 42],
    ];

    for (const [field, value] of corruptions) {
      writeFileSync(sessionFile(created.token), JSON.stringify({ ...valid, [field]: value }), 'utf-8');
      await expectKinoError(store.read(created.token), 400, 'invalid_upload_session');
    }

    const otherToken = randomUUID();
    writeFileSync(sessionFile(created.token), JSON.stringify({ ...valid, token: otherToken }), 'utf-8');
    await expectKinoError(store.read(created.token), 400, 'invalid_upload_session');

    writeFileSync(
      sessionFile(created.token),
      JSON.stringify({
        ...valid,
        resourceId: 'reserved',
        completedResourceId: 'different',
      }),
      'utf-8',
    );
    await expectKinoError(store.read(created.token), 400, 'invalid_upload_session');
  });

  test('rejects non-finite session numbers', async () => {
    const session = await store.create(baseInput);
    await expectKinoError(
      store.write({ ...session, bytes: Number.POSITIVE_INFINITY }),
      400,
      'invalid_upload_session',
    );
    await expectKinoError(
      store.write({ ...session, createdAt: Number.NaN }),
      400,
      'invalid_upload_session',
    );
    await expectKinoError(
      store.write({ ...session, expiresAt: Number.NEGATIVE_INFINITY }),
      400,
      'invalid_upload_session',
    );
  });

  test('requires a replacement expectation fingerprint for replacement sessions', async () => {
    const session = await store.create(baseInput);
    session.resourceId = 'res-1';
    session.replaceExisting = true;
    await expectKinoError(
      store.write(session),
      400,
      'invalid_upload_session',
    );
  });

  test('rejects unsafe tokens on write', async () => {
    const session = await store.create(baseInput);
    await expectKinoError(
      store.write({ ...session, token: '../escape' }),
      400,
      'invalid_upload_token',
    );
  });

  test('distinguishes malformed JSON from unexpected read I/O', async () => {
    const session = await store.create(baseInput);
    writeFileSync(sessionFile(session.token), '{bad json', 'utf-8');
    await expectKinoError(store.read(session.token), 400, 'invalid_upload_session');

    const ioStore = new UploadSessionStore(assetsDir, {
      readText: () => {
        throw Object.assign(new Error('read failed'), { code: 'EIO' });
      },
    });
    await expectKinoError(ioStore.read(session.token), 500, 'upload_session_storage_error');
  });
});

describe('UploadSessionStore.validate', () => {
  test('accepts a matching live session', async () => {
    const session = await store.create(baseInput);
    expect(() =>
      store.validate(session, {
        gameId: 'demo',
        identity: 'user-1',
        providerKind: 'local',
        mimeType: 'video/mp4',
        bytes: 1024,
      }),
    ).not.toThrow();
  });

  test('rejects wrong game, identity, or provider kind', async () => {
    const session = await store.create(baseInput);

    await expectKinoError(
      () =>
        store.validate(session, {
          gameId: 'other',
          identity: 'user-1',
          providerKind: 'local',
          mimeType: 'video/mp4',
          bytes: 1024,
        }),
      400,
      'upload_session_game_mismatch',
    );

    await expectKinoError(
      () =>
        store.validate(session, {
          gameId: 'demo',
          identity: 'user-2',
          providerKind: 'local',
          mimeType: 'video/mp4',
          bytes: 1024,
        }),
      403,
      'upload_session_identity_mismatch',
    );

    await expectKinoError(
      () =>
        store.validate(session, {
          gameId: 'demo',
          identity: 'user-1',
          providerKind: 's3',
          mimeType: 'video/mp4',
          bytes: 1024,
        }),
      409,
      'upload_session_provider_mismatch',
    );
  });

  test('rejects expired sessions and invalid mime or size', async () => {
    const session = await store.create(baseInput);
    const expired: UploadSession = { ...session, expiresAt: Date.now() - 1 };

    await expectKinoError(
      () =>
        store.validate(expired, {
          gameId: 'demo',
          identity: 'user-1',
          providerKind: 'local',
          mimeType: 'video/mp4',
          bytes: 1024,
        }),
      410,
      'kino_upload_expired',
    );

    await expectKinoError(
      () =>
        store.validate(session, {
          gameId: 'demo',
          identity: 'user-1',
          providerKind: 'local',
          mimeType: 'video/webm' as 'video/mp4',
          bytes: 1024,
        }),
      400,
      'invalid_media_type',
    );

    await expectKinoError(
      () =>
        store.validate(session, {
          gameId: 'demo',
          identity: 'user-1',
          providerKind: 'local',
          mimeType: 'video/mp4',
          bytes: 0,
        }),
      400,
      'invalid_upload_size',
    );

    await expectKinoError(
      () =>
        store.validate(session, {
          gameId: 'demo',
          identity: 'user-1',
          providerKind: 'local',
          mimeType: 'video/mp4',
          bytes: MAX_VIDEO_UPLOAD_BYTES + 1,
        }),
      400,
      'invalid_upload_size',
    );
  });

  test('uses the injected clock for expiry checks', async () => {
    const session = await store.create(baseInput);
    const beforeExpiry = session.expiresAt - 1;
    const atExpiry = session.expiresAt;
    const validation = {
      gameId: 'demo',
      identity: 'user-1',
      providerKind: 'local' as const,
      mimeType: 'video/mp4' as const,
      bytes: 1024,
    };

    expect(() => store.validate(session, validation, beforeExpiry)).not.toThrow();
    await expectKinoError(
      () => store.validate(session, validation, atExpiry),
      410,
      'kino_upload_expired',
    );
  });

  test('deletes the persisted session immediately when validation finds it expired', async () => {
    const session = await store.create(baseInput);
    const validation = {
      gameId: 'demo',
      identity: 'user-1',
      providerKind: 'local' as const,
      mimeType: 'video/mp4' as const,
      bytes: 1024,
    };

    expect(statSync(sessionFile(session.token)).isFile()).toBe(true);
    await expectKinoError(
      () => store.validate(session, validation, session.expiresAt),
      410,
      'kino_upload_expired',
    );
    await expect(store.read(session.token)).resolves.toBeNull();
  });

  test('keeps a completed credential-free tombstone readable after its original expiry', async () => {
    const session = await store.create(baseInput);
    const completed = await store.complete(session.token, 'res-1');

    expect(() =>
      store.validate(
        completed,
        {
          gameId: 'demo',
          identity: 'user-1',
          providerKind: 'local',
          mimeType: 'video/mp4',
          bytes: 1024,
        },
        session.expiresAt + 1,
      ),
    ).not.toThrow();
    await expect(store.read(session.token)).resolves.toEqual(completed);
  });

  for (const [key, providerState] of [
    ['authorization', { AUTHORIZATION: 'Bearer secret' }],
    ['cookie', { nested: { Cookie: 'session=secret' } }],
    ['auth', { values: [{ Auth: 'secret' }] }],
    ['set-cookie', { headers: [{ 'Set-Cookie': 'session=secret' }] }],
  ] satisfies Array<[string, Record<string, unknown>]>) {
    test(`rejects nested ${key}`, async () => {
      await expectKinoError(
        store.create({ ...baseInput, providerState }),
        400,
        'invalid_upload_session',
      );
    });
  }

  test('sensitive-key scan is cycle safe', async () => {
    const providerState: Record<string, unknown> = {};
    providerState.self = providerState;
    providerState.values = [{ Auth: 'secret' }];
    await expectKinoError(
      store.create({ ...baseInput, providerState }),
      400,
      'invalid_upload_session',
    );
  });
});

describe('UploadSessionStore.complete', () => {
  test('records completed resource id idempotently', async () => {
    const session = await store.create(baseInput);
    const first = await store.complete(session.token, 'res-1');
    expect(first.completedResourceId).toBe('res-1');

    const second = await store.complete(session.token, 'res-1');
    expect(second.completedResourceId).toBe('res-1');

    const reread = await store.read(session.token);
    expect(reread?.completedResourceId).toBe('res-1');
  });

  test('scrubs the migration replacement marker on completion', async () => {
    const session = await store.create(baseInput);
    session.resourceId = 'res-1';
    session.replaceExisting = true;
    session.replaceExpectedFingerprint = 'a'.repeat(64);
    await store.write(session);

    const completed = await store.complete(session.token, 'res-1');
    expect(completed.replaceExisting).toBeUndefined();
    expect(completed.replaceExpectedFingerprint).toBeUndefined();
    expect((await store.read(session.token))?.replaceExisting).toBeUndefined();
  });

  test('atomically replaces provider credentials with an idempotent tombstone', async () => {
    const tmpSecretKey = 'private-sts-secret-value';
    const sessionToken = 'private-session-token-value';
    const session = await store.create({
      ...baseInput,
      providerKind: 'kino',
      providerState: {
        ref: 'https://bucket.example.test/object.mp4',
        nested: {
          tmp_secret_id: 'AKIDTEMP',
          tmp_secret_key: tmpSecretKey,
          session_token: sessionToken,
        },
      },
    });

    const first = await store.complete(session.token, 'res-1');
    expect(first.providerState).toEqual({});
    expect(first.completedResourceId).toBe('res-1');

    const serialized = readFileSync(sessionFile(session.token), 'utf-8');
    expect(serialized).not.toContain('tmp_secret_id');
    expect(serialized).not.toContain('tmp_secret_key');
    expect(serialized).not.toContain('session_token');
    expect(serialized).not.toContain(tmpSecretKey);
    expect(serialized).not.toContain(sessionToken);
    expect(readdirSync(resolve(assetsDir, '.uploads')).filter((name) => name.includes('.tmp-'))).toEqual(
      [],
    );

    const second = await store.complete(session.token, 'res-1');
    expect(second.providerState).toEqual({});
    expect(second.completedResourceId).toBe('res-1');
    await expect(store.read(session.token)).resolves.toEqual(second);
  });

  test('rejects a conflicting completed resource id', async () => {
    const session = await store.create(baseInput);
    await store.complete(session.token, 'res-1');
    await expectKinoError(
      store.complete(session.token, 'res-2'),
      409,
      'upload_session_completion_conflict',
    );
  });
});

describe('UploadSessionStore.reserve', () => {
  test('persists one stable resource id idempotently', async () => {
    const session = await store.create(baseInput);

    const first = await store.reserve(session.token, 'res-1');
    const second = await store.reserve(session.token, 'res-1');

    expect(first.resourceId).toBe('res-1');
    expect(second.resourceId).toBe('res-1');
    expect((await store.read(session.token))?.resourceId).toBe('res-1');
  });

  test('rejects a conflicting reservation', async () => {
    const session = await store.create(baseInput);
    await store.reserve(session.token, 'res-1');

    await expectKinoError(
      store.reserve(session.token, 'res-2'),
      409,
      'upload_session_reservation_conflict',
    );
  });
});

describe('UploadSessionStore.delete', () => {
  test('removes persisted session files', async () => {
    const session = await store.create(baseInput);
    await store.delete(session.token);
    await expect(store.read(session.token)).resolves.toBeNull();
  });

  test('maps unexpected delete I/O to typed 500', async () => {
    const session = await store.create(baseInput);
    const ioStore = new UploadSessionStore(assetsDir, {
      remove: () => {
        throw Object.assign(new Error('delete failed'), { code: 'EIO' });
      },
    });
    await expectKinoError(
      ioStore.delete(session.token),
      500,
      'upload_session_storage_error',
    );
  });
});
