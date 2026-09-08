import { createVersionControlRouter } from '@forgeax/platform-io';
import { getActiveGame } from './active-game';
import { resolveInstanceGame } from './instance-game';

const VERSION_CONTROL_PREFIX = '/api/version-control';

export type AuthoritativeSaveState = 'dirty' | 'clean' | 'unknown';

export interface AuthoritativeSaveReader<T> {
  readonly realmId: string;
  readonly read: () => Promise<T>;
}

export interface AuthoritativeSaveVerification<T> {
  readonly requestId: string;
  readonly writerRealmId: string;
  readonly readerRealmId: string | null;
  readonly state: AuthoritativeSaveState;
  readonly authoritative: T | null;
  readonly observed: T | null;
  readonly error?: {
    readonly code: 'invalid-request' | 'save-failed' | 'reader-not-independent' | 'read-back-failed' | 'durability-mismatch';
    readonly hint: string;
    readonly retryable: boolean;
    readonly recoveryActions: readonly string[];
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
}

export async function verifyAuthoritativeSave<T>(input: {
  readonly requestId: string;
  readonly writerRealmId: string;
  readonly authoritative: T;
  readonly createFreshReader: () => Promise<AuthoritativeSaveReader<T>>;
}): Promise<AuthoritativeSaveVerification<T>> {
  const base = { requestId: input.requestId, writerRealmId: input.writerRealmId, authoritative: input.authoritative };
  const error = (code: NonNullable<AuthoritativeSaveVerification<T>['error']>['code'], hint: string, retryable: boolean, readerRealmId: string | null, observed: T | null): AuthoritativeSaveVerification<T> => ({
    ...base,
    state: code === 'durability-mismatch' ? 'dirty' : 'unknown',
    readerRealmId,
    observed,
    error: { code, hint, retryable, recoveryActions: ['persistence.inspect', 'persistence.retry'] },
  });
  if (!input.requestId.trim() || !input.writerRealmId.trim()) return error('invalid-request', 'A durable Save requires a requestId and writer realm.', false, null, null);
  let reader: AuthoritativeSaveReader<T>;
  try { reader = await input.createFreshReader(); } catch { return error('read-back-failed', 'The independent reader could not be created; durability is unknown.', true, null, null); }
  if (!reader.realmId.trim() || reader.realmId === input.writerRealmId) return error('reader-not-independent', 'The read-back realm must be newly created and distinct from the writer.', false, reader.realmId || null, null);
  let observed: T;
  try { observed = await reader.read(); } catch { return error('read-back-failed', 'The fresh reader failed; durability is unknown.', true, reader.realmId, null); }
  if (JSON.stringify(stableValue(input.authoritative)) !== JSON.stringify(stableValue(observed))) return error('durability-mismatch', 'Fresh read-back differs from the authoritative Save result.', true, reader.realmId, observed);
  return { ...base, state: 'clean', readerRealmId: reader.realmId, observed };
}

export async function saveAndVerifyAuthoritative<T>(input: {
  readonly requestId: string;
  readonly writerRealmId: string;
  readonly save: () => Promise<T>;
  readonly createFreshReader: () => Promise<AuthoritativeSaveReader<T>>;
}): Promise<AuthoritativeSaveVerification<T>> {
  if (!input.requestId.trim() || !input.writerRealmId.trim()) return {
    requestId: input.requestId,
    writerRealmId: input.writerRealmId,
    state: 'unknown',
    readerRealmId: null,
    authoritative: null,
    observed: null,
    error: { code: 'invalid-request', hint: 'Save requires a requestId and writer realm.', retryable: false, recoveryActions: ['persistence.inspect', 'persistence.retry'] },
  };
  let authoritative: T;
  try { authoritative = await input.save(); } catch {
    return {
      requestId: input.requestId,
      writerRealmId: input.writerRealmId,
      state: 'unknown',
      readerRealmId: null,
      authoritative: null,
      observed: null,
      error: { code: 'save-failed', hint: 'The authoritative Host save failed; durability is unknown.', retryable: true, recoveryActions: ['persistence.inspect', 'persistence.retry'] },
    };
  }
  return verifyAuthoritativeSave({ ...input, authoritative });
}

export interface ActiveGameVersionControlHandlerOptions {
  readonly projectRoot: string | (() => string);
}

/**
 * Bind the editor's version-control Host to Studio's server-owned active game.
 *
 * The editor browser surface never supplies a filesystem root. Resolving the
 * active slug here keeps the same authority boundary as the Extension routes,
 * while the platform router remains the sole owner of Git operations.
 */
export function createActiveGameVersionControlHandler(
  options: ActiveGameVersionControlHandlerOptions,
): (request: Request) => Promise<Response> {
  const routers = new Map<string, ReturnType<typeof createVersionControlRouter>>();

  return async (request: Request): Promise<Response> => {
    const projectRoot = typeof options.projectRoot === 'function' ? options.projectRoot() : options.projectRoot;
    const activeSlug = getActiveGame(projectRoot);
    const game = activeSlug === undefined ? undefined : resolveInstanceGame(projectRoot, activeSlug);
    if (game === undefined) {
      return Response.json({
        status: 'uninitialized',
        error: {
          code: 'version-control-unavailable',
          hint: 'Initialize the current game repository',
          recoveryActions: ['version-control.refresh'],
        },
      }, { status: 503 });
    }

    let router = routers.get(game.gameDir);
    if (router === undefined) {
      router = createVersionControlRouter({ gameRoot: game.gameDir });
      routers.set(game.gameDir, router);
    }

    const url = new URL(request.url);
    const path = url.pathname.startsWith(VERSION_CONTROL_PREFIX)
      ? url.pathname.slice(VERSION_CONTROL_PREFIX.length) || '/'
      : url.pathname;
    url.pathname = path;
    return router.fetch(new Request(url.toString(), request));
  };
}
