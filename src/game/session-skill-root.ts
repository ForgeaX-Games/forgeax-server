import { join } from 'node:path';
import { getSessionManager } from '@forgeax/orchestrator';
import { getPathManager } from '@forgeax/orchestrator/session-fs';
import type { SessionSkillRootProvider } from '@forgeax/orchestrator/seams';

/** Studio maps a caller session to its game; the orchestration layer only sees a directory. */
export const gameSessionSkillRootProvider: SessionSkillRootProvider = (sessionId) => {
  try {
    const game = getSessionManager().peek(sessionId)?.config.defaultDir;
    if (!game || game === 'default') return undefined;
    return join(getPathManager().user().gameDir(game), 'skills');
  } catch {
    // Product services may not have completed boot yet.
    return undefined;
  }
};
