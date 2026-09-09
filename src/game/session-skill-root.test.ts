import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
const sessions = new Map([['a', { config: { defaultDir: 'game-a' } }], ['b', { config: { defaultDir: 'game-b' } }], ['generic', { config: { defaultDir: 'default' } }]]);
mock.module('@forgeax/orchestrator', () => ({ getSessionManager: () => ({ peek: (sid: string) => sessions.get(sid) }) }));
mock.module('@forgeax/orchestrator/session-fs', () => ({ getPathManager: () => ({ user: () => ({ gameDir: (slug: string) => join('/project with spaces', '.forgeax/games', slug) }) }) }));
const { gameSessionSkillRootProvider } = await import('./session-skill-root');
test('Studio resolves the exact session game without active-game or cwd fallback', () => {
  expect(gameSessionSkillRootProvider('a')).toBe(join('/project with spaces/.forgeax/games/game-a', 'skills'));
  expect(gameSessionSkillRootProvider('b')).toBe(join('/project with spaces/.forgeax/games/game-b', 'skills'));
  expect(gameSessionSkillRootProvider('unknown')).toBeUndefined();
  expect(gameSessionSkillRootProvider('generic')).toBeUndefined();
  sessions.set('a', { config: { defaultDir: 'game-b' } });
  expect(gameSessionSkillRootProvider('a')).toBe(gameSessionSkillRootProvider('b'));
});
