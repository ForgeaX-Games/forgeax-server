// Shared scope helper: the game slug a chat tab's session is bound to.
//
// Both ClaudeCodeProvider and CodexProvider need "which game does this tab
// scope to" so ambiguous edits ("把背景改成蓝色") target the right
// .forgeax/games/<slug>/ instead of the workspace-global active game. The
// logic was originally private to claude-code.ts; extracted verbatim so the
// two providers can't drift.

import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { defaultProjectRoot } from '../../api/lib/safe-path';
import { getSessionManager } from '../../core/session-manager';

/** Best-effort: the game slug a chat tab's session is bound to, or undefined.
 *  Peek-only (never hydrates a session); ignores the 'default' sentinel and any
 *  slug whose .forgeax/games/<slug>/ dir no longer exists, so callers fall back
 *  to the workspace-level active game. */
export function sessionDefaultDir(sid: string | undefined): string | undefined {
  if (!sid) return undefined;
  try {
    const slug = getSessionManager().peek(sid)?.config.defaultDir;
    if (!slug || slug === 'default') return undefined;
    const dir = resolvePath(defaultProjectRoot(), '.forgeax/games', slug);
    return existsSync(dir) ? slug : undefined;
  } catch {
    return undefined;
  }
}
