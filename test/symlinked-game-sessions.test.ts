import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GameSessionLayout } from '../src/studio-session-layout';

// Regression: shared games are seeded into .forgeax/games/<slug> as SYMLINKS to
// packages/games/<slug> (run.sh / .app). A withFileTypes entry for a symlink
// reports isDirectory()===false, so the old dirsUnder() filter silently dropped
// every symlinked game — and with it every session under it. Result: a user
// working on a shared game (e.g. spin-cube) had /api/sessions return an empty
// per-game list → the UI minted a fresh empty session on each refresh and "lost"
// history. The fix admits symlinks whose resolved target is a directory.

const tmps: string[] = [];
afterEach(() => { for (const d of tmps.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

describe('GameSessionLayout enumerates SYMLINKED (shared) games', () => {
  test('a session under a symlinked game appears in listSessionIds + resolves correctly', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'symlink-game-proj-'));
    const sharedStore = mkdtempSync(join(tmpdir(), 'shared-games-'));
    tmps.push(projectRoot, sharedStore);

    // Real shared game with one session, living outside the project.
    const realGame = join(sharedStore, 'spin-cube');
    const sid = 'sid-shared-1';
    mkdirSync(join(realGame, 'sessions', sid), { recursive: true });
    writeFileSync(join(realGame, 'sessions', sid, 'session.json'), JSON.stringify({ autoStart: true }) + '\n');

    // Seed it into the project's games dir AS A SYMLINK (how run.sh seeds shared games).
    mkdirSync(join(projectRoot, '.forgeax', 'games'), { recursive: true });
    symlinkSync(realGame, join(projectRoot, '.forgeax', 'games', 'spin-cube'));

    const layout = new GameSessionLayout(projectRoot, () => 'spin-cube');

    // Before the fix this was []. Now the symlinked game's session is enumerated.
    expect(layout.listSessionIds()).toContain(sid);
    // And it resolves to the project-nested path (via the symlink).
    expect(layout.sessionRoot(sid)).toContain(join('games', 'spin-cube', 'sessions', sid));
  });

  test('real (non-symlink) games still enumerate alongside symlinked ones', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'symlink-game-proj-'));
    const sharedStore = mkdtempSync(join(tmpdir(), 'shared-games-'));
    tmps.push(projectRoot, sharedStore);
    const gamesDir = join(projectRoot, '.forgeax', 'games');

    // real game
    mkdirSync(join(gamesDir, 'my-game', 'sessions', 'sid-real'), { recursive: true });
    writeFileSync(join(gamesDir, 'my-game', 'sessions', 'sid-real', 'session.json'), '{"autoStart":true}\n');
    // symlinked shared game
    const realShared = join(sharedStore, 'spin-cube');
    mkdirSync(join(realShared, 'sessions', 'sid-link'), { recursive: true });
    writeFileSync(join(realShared, 'sessions', 'sid-link', 'session.json'), '{"autoStart":true}\n');
    symlinkSync(realShared, join(gamesDir, 'spin-cube'));

    const ids = new GameSessionLayout(projectRoot, () => 'my-game').listSessionIds();
    expect(ids).toContain('sid-real');
    expect(ids).toContain('sid-link');
  });
});
