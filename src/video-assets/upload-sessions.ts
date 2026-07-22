import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { VideoAssetProviderKind } from './contracts';
import { KinoApiError } from './kino-api';

export const MAX_VIDEO_UPLOAD_BYTES = 104_857_600;
export const VIDEO_UPLOAD_MIME = 'video/mp4' as const;

export interface UploadSession {
  token: string;
  gameId: string;
  identity: string;
  fileName: string;
  mimeType: typeof VIDEO_UPLOAD_MIME;
  bytes: number;
  createdAt: number;
  expiresAt: number;
  providerKind: VideoAssetProviderKind;
  providerState: Record<string, unknown>;
  resourceId?: string;
  replaceExisting?: boolean;
  replaceExpectedFingerprint?: string;
  completedResourceId?: string;
}

export interface CreateUploadSessionInput {
  gameId: string;
  identity: string;
  fileName: string;
  mimeType: typeof VIDEO_UPLOAD_MIME;
  bytes: number;
  providerKind: VideoAssetProviderKind;
  providerState: Record<string, unknown>;
  ttlMs?: number;
}

export interface ValidateUploadSessionInput {
  gameId: string;
  identity: string;
  providerKind: VideoAssetProviderKind;
  mimeType: typeof VIDEO_UPLOAD_MIME;
  bytes: number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const FORBIDDEN_PROVIDER_STATE_KEYS = new Set(['authorization', 'cookie', 'auth', 'set-cookie']);
const PROVIDER_KINDS: readonly VideoAssetProviderKind[] = ['local', 's3', 'cos', 'kino'];
const UPLOAD_TOKEN_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface UploadSessionFileOperations {
  readText(path: string): string;
  makeDirectory(path: string): void;
  writePrivateText(path: string, contents: string): void;
  rename(source: string, destination: string): void;
  remove(path: string): void;
}

const DEFAULT_FILE_OPERATIONS: UploadSessionFileOperations = {
  readText: (path) => readFileSync(path, 'utf-8'),
  makeDirectory: (path) => mkdirSync(path, { recursive: true }),
  writePrivateText: (path, contents) =>
    writeFileSync(path, contents, { encoding: 'utf-8', mode: 0o600 }),
  rename: renameSync,
  remove: (path) => rmSync(path),
};

function invalidSession(message = 'Invalid upload session'): KinoApiError {
  return new KinoApiError(message, 400, 'invalid_upload_session');
}

function uploadsDir(assetsDir: string): string {
  return resolve(assetsDir, '.uploads');
}

function sessionPath(assetsDir: string, token: string): string {
  if (!UPLOAD_TOKEN_RE.test(token)) {
    throw new KinoApiError('Invalid upload token', 400, 'invalid_upload_token');
  }
  return resolve(uploadsDir(assetsDir), `${token}.json`);
}

function assertProviderState(state: unknown): asserts state is Record<string, unknown> {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw invalidSession();
  }

  const visited = new WeakSet<object>();
  const scan = (value: unknown): void => {
    if (!value || typeof value !== 'object') {
      return;
    }
    if (visited.has(value)) {
      return;
    }
    visited.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        scan(item);
      }
      return;
    }

    for (const [key, nested] of Object.entries(value)) {
      if (FORBIDDEN_PROVIDER_STATE_KEYS.has(key.trim().toLowerCase())) {
        throw invalidSession('Upload session must not store auth credentials');
      }
      scan(nested);
    }
  };
  scan(state);

  try {
    JSON.stringify(state);
  } catch {
    throw invalidSession('Upload provider state must be JSON serializable');
  }
}

function assertSessionShape(session: unknown): asserts session is UploadSession {
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    throw invalidSession();
  }
  const candidate = session as UploadSession;
  if (typeof candidate.token !== 'string' || !UPLOAD_TOKEN_RE.test(candidate.token)) {
    throw invalidSession();
  }
  if (typeof candidate.gameId !== 'string' || candidate.gameId.length === 0) {
    throw invalidSession();
  }
  if (typeof candidate.identity !== 'string' || candidate.identity.length === 0) {
    throw invalidSession();
  }
  if (typeof candidate.fileName !== 'string' || candidate.fileName.length === 0) {
    throw invalidSession();
  }
  if (candidate.mimeType !== VIDEO_UPLOAD_MIME) {
    throw invalidSession();
  }
  if (
    typeof candidate.bytes !== 'number' ||
    !Number.isFinite(candidate.bytes) ||
    candidate.bytes <= 0 ||
    candidate.bytes > MAX_VIDEO_UPLOAD_BYTES
  ) {
    throw invalidSession();
  }
  if (
    typeof candidate.createdAt !== 'number' ||
    !Number.isFinite(candidate.createdAt) ||
    typeof candidate.expiresAt !== 'number' ||
    !Number.isFinite(candidate.expiresAt)
  ) {
    throw invalidSession();
  }
  if (!PROVIDER_KINDS.includes(candidate.providerKind)) {
    throw invalidSession();
  }
  assertProviderState(candidate.providerState);
  if (
    candidate.resourceId !== undefined &&
    (typeof candidate.resourceId !== 'string' || candidate.resourceId.length === 0)
  ) {
    throw invalidSession();
  }
  if (
    candidate.completedResourceId !== undefined &&
    (typeof candidate.completedResourceId !== 'string' ||
      candidate.completedResourceId.length === 0)
  ) {
    throw invalidSession();
  }
  if (
    candidate.resourceId !== undefined &&
    candidate.completedResourceId !== undefined &&
    candidate.resourceId !== candidate.completedResourceId
  ) {
    throw invalidSession('Upload session resource ids do not match');
  }
  if (
    candidate.replaceExisting !== undefined &&
    typeof candidate.replaceExisting !== 'boolean'
  ) {
    throw invalidSession();
  }
  if (
    candidate.replaceExisting === true &&
    (typeof candidate.replaceExpectedFingerprint !== 'string' ||
      !/^[0-9a-f]{64}$/.test(candidate.replaceExpectedFingerprint))
  ) {
    throw invalidSession('Replacement session is missing its expected fingerprint');
  }
  if (
    candidate.replaceExisting !== true &&
    candidate.replaceExpectedFingerprint !== undefined
  ) {
    throw invalidSession();
  }
}

export class UploadSessionStore {
  readonly #assetsDir: string;
  readonly #files: UploadSessionFileOperations;
  readonly #queues = new Map<string, Promise<void>>();

  constructor(
    assetsDir: string,
    fileOperations: Partial<UploadSessionFileOperations> = {},
  ) {
    this.#assetsDir = assetsDir;
    this.#files = { ...DEFAULT_FILE_OPERATIONS, ...fileOperations };
  }

  async create(input: CreateUploadSessionInput): Promise<UploadSession> {
    if (input.mimeType !== VIDEO_UPLOAD_MIME) {
      throw new KinoApiError('Invalid upload mime type', 400, 'invalid_media_type');
    }
    if (!Number.isFinite(input.bytes) || input.bytes <= 0 || input.bytes > MAX_VIDEO_UPLOAD_BYTES) {
      throw new KinoApiError('Invalid upload size', 400, 'invalid_upload_size');
    }

    const now = Date.now();
    const session: UploadSession = {
      token: randomUUID(),
      gameId: input.gameId,
      identity: input.identity,
      fileName: input.fileName,
      mimeType: input.mimeType,
      bytes: input.bytes,
      createdAt: now,
      expiresAt: now + (input.ttlMs ?? DEFAULT_TTL_MS),
      providerKind: input.providerKind,
      providerState: input.providerState,
    };
    assertSessionShape(session);
    await this.write(session);
    return session;
  }

  async read(token: string): Promise<UploadSession | null> {
    const path = sessionPath(this.#assetsDir, token);
    let raw: string;
    try {
      raw = this.#files.readText(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw new KinoApiError(
        'Failed to read upload session',
        500,
        'upload_session_storage_error',
      );
    }

    let session: unknown;
    try {
      session = JSON.parse(raw);
    } catch {
      throw invalidSession('Invalid upload session file');
    }
    assertSessionShape(session);
    if (session.token !== token) {
      throw invalidSession('Upload session token mismatch');
    }
    return session;
  }

  async write(session: UploadSession): Promise<void> {
    sessionPath(this.#assetsDir, session.token);
    assertSessionShape(session);
    let contents: string;
    try {
      contents = `${JSON.stringify(session, null, 2)}\n`;
    } catch {
      throw invalidSession('Invalid upload session file');
    }

    const dir = uploadsDir(this.#assetsDir);
    const destination = sessionPath(this.#assetsDir, session.token);
    const tempPath = `${destination}.tmp-${randomUUID()}`;
    let removeTemp = false;
    try {
      this.#files.makeDirectory(dir);
      removeTemp = true;
      this.#files.writePrivateText(tempPath, contents);
      this.#files.rename(tempPath, destination);
      removeTemp = false;
    } catch {
      throw new KinoApiError(
        'Failed to write upload session',
        500,
        'upload_session_storage_error',
      );
    } finally {
      if (removeTemp) {
        try {
          this.#files.remove(tempPath);
        } catch {
          // Preserve the primary storage failure.
        }
      }
    }
  }

  #removeSessionFile(token: string): void {
    const path = sessionPath(this.#assetsDir, token);
    try {
      this.#files.remove(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new KinoApiError(
          'Failed to delete upload session',
          500,
          'upload_session_storage_error',
        );
      }
    }
  }

  validate(
    session: UploadSession,
    input: ValidateUploadSessionInput,
    now = Date.now(),
  ): void {
    assertSessionShape(session);

    if (session.gameId !== input.gameId) {
      throw new KinoApiError('Upload session game mismatch', 400, 'upload_session_game_mismatch');
    }
    if (session.identity !== input.identity) {
      throw new KinoApiError('Upload session identity mismatch', 403, 'upload_session_identity_mismatch');
    }
    if (session.providerKind !== input.providerKind) {
      throw new KinoApiError('Upload session provider mismatch', 409, 'upload_session_provider_mismatch');
    }
    if (!session.completedResourceId && now >= session.expiresAt) {
      this.#removeSessionFile(session.token);
      throw new KinoApiError('Upload session expired', 410, 'kino_upload_expired');
    }
    if (input.mimeType !== VIDEO_UPLOAD_MIME) {
      throw new KinoApiError('Invalid upload mime type', 400, 'invalid_media_type');
    }
    if (!Number.isFinite(input.bytes) || input.bytes <= 0 || input.bytes > MAX_VIDEO_UPLOAD_BYTES) {
      throw new KinoApiError('Invalid upload size', 400, 'invalid_upload_size');
    }
    if (session.mimeType !== input.mimeType) {
      throw new KinoApiError('Upload session mime mismatch', 400, 'invalid_media_type');
    }
    if (session.bytes !== input.bytes) {
      throw new KinoApiError('Upload session size mismatch', 400, 'invalid_upload_size');
    }
  }

  async #enqueue<T>(token: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(token) ?? Promise.resolve();
    let release!: () => void;
    const current = previous.then(
      () =>
        new Promise<void>((resolveQueue) => {
          release = resolveQueue;
        }),
    );
    this.#queues.set(token, current);

    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.#queues.get(token) === current) {
        this.#queues.delete(token);
      }
    }
  }

  async reserve(token: string, resourceId: string): Promise<UploadSession> {
    return this.#enqueue(token, async () => {
      const session = await this.read(token);
      if (!session) {
        throw new KinoApiError('Upload session not found', 404, 'upload_session_not_found');
      }
      if (session.resourceId === resourceId) {
        return session;
      }
      if (session.resourceId) {
        throw new KinoApiError(
          'Upload session already has another resource reservation',
          409,
          'upload_session_reservation_conflict',
        );
      }
      session.resourceId = resourceId;
      await this.write(session);
      return session;
    });
  }

  async complete(token: string, resourceId: string): Promise<UploadSession> {
    return this.#enqueue(token, async () => {
      const session = await this.read(token);
      if (!session) {
        throw new KinoApiError('Upload session not found', 404, 'upload_session_not_found');
      }
      if (session.completedResourceId === resourceId) {
        if (
          Object.keys(session.providerState).length > 0 ||
          session.replaceExisting !== undefined ||
          session.replaceExpectedFingerprint !== undefined
        ) {
          session.providerState = {};
          delete session.replaceExisting;
          delete session.replaceExpectedFingerprint;
          await this.write(session);
        }
        return session;
      }
      if (
        (session.resourceId && session.resourceId !== resourceId) ||
        session.completedResourceId
      ) {
        throw new KinoApiError(
          'Upload session is already completed with another resource',
          409,
          'upload_session_completion_conflict',
        );
      }
      session.resourceId ??= resourceId;
      session.completedResourceId = resourceId;
      session.providerState = {};
      delete session.replaceExisting;
      delete session.replaceExpectedFingerprint;
      await this.write(session);
      return session;
    });
  }

  async delete(token: string): Promise<void> {
    this.#removeSessionFile(token);
  }
}
