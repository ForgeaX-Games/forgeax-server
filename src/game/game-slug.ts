/** Canonical game slug grammar for every server-side game boundary. */
export const GAME_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function isGameSlug(value: unknown): value is string {
  return typeof value === 'string' && GAME_SLUG_RE.test(value);
}
