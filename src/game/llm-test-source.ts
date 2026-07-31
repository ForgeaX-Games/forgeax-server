const GAME_RUNTIME_PATHS = ['/preview/', '/game/', '/play/'] as const;
const GAME_RUNTIME_PORTS = new Set(['15173', '15273']);

/**
 * Classify Model Lab provenance from browser-owned navigation metadata at the
 * product-shell boundary. Client-defined source headers are intentionally
 * ignored; they cannot grant access or override a game-runtime classification.
 */
export function resolveLlmTestRequestSource(request: Request): 'studio-ui' | 'game-runtime' {
  const origin = request.headers.get('origin');
  if (origin) {
    try {
      if (GAME_RUNTIME_PORTS.has(new URL(origin).port)) return 'game-runtime';
    } catch {
      return 'game-runtime';
    }
  }
  const referrer = request.headers.get('referer');
  if (!referrer) return 'game-runtime';
  try {
    const url = new URL(referrer);
    return GAME_RUNTIME_PATHS.some((prefix) => url.pathname.startsWith(prefix))
      ? 'game-runtime'
      : 'studio-ui';
  } catch {
    return 'game-runtime';
  }
}
