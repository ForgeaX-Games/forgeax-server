import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initPathManager, getPathManager, resetPathManager } from 'forgeax-cli/fs/path-manager';
import { GameSessionLayout } from '../src/studio-session-layout';

// Regression: a workspace/project-root switch must NOT drop the studio
// GameSessionLayout. Before the fix, workspaces.ts re-inited the PathManager
// with a bare { projectRoot } (no layout), downgrading it to the flat default —
// so game-nested sessions (games/<slug>/sessions/<sid>) vanished from
// listSessionIds() → /api/sessions returned an empty per-game list → the UI
// minted a new empty session on every refresh and "lost" history.
//
// The fix threads a sessionLayoutFactory(root) through ProductContext →
// createWorkspacesRouter, so each re-init rebuilds the layout for the new root.
// This test pins the seam: factory re-init keeps nested sessions visible; a bare
// re-init (the old bug) loses them.

const roots: string[] = [];
afterEach(() => {
  resetPathManager();
  for (const r of roots.splice(0)) { try { rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ } }
});

function makeProjectWithNestedSession(slug: string, sid: string): string {
  const root = mkdtempSync(join(tmpdir(), 'ws-switch-'));
  roots.push(root);
  const sessionDir = join(root, '.forgeax', 'games', slug, 'sessions', sid);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({ autoStart: true }) + '\n');
  return root;
}

// Mirrors main.ts: sessionLayoutFactory: (root) => new GameSessionLayout(root, () => activeGame)
const factory = (slug: string) => (root: string) => new GameSessionLayout(root, () => slug);

describe('workspace switch keeps GameSessionLayout (todo: session-layout drop regression)', () => {
  test('boot via factory enumerates the game-nested session', () => {
    const root = makeProjectWithNestedSession('spin-cube', 'sid-1');
    initPathManager({ projectRoot: root, layout: factory('spin-cube')(root) });
    expect(getPathManager().listSessionIds()).toContain('sid-1');
  });

  test('BUG repro: bare re-init drops the layout → nested session disappears', () => {
    const root = makeProjectWithNestedSession('spin-cube', 'sid-1');
    initPathManager({ projectRoot: root, layout: factory('spin-cube')(root) });
    expect(getPathManager().listSessionIds()).toContain('sid-1');
    // The old workspaces.ts did exactly this on activate:
    initPathManager({ projectRoot: root });
    expect(getPathManager().listSessionIds()).not.toContain('sid-1'); // flat layout can't see games/*/sessions
  });

  test('FIX: re-init with the factory keeps the nested session visible after a switch', () => {
    const root = makeProjectWithNestedSession('spin-cube', 'sid-1');
    initPathManager({ projectRoot: root, layout: factory('spin-cube')(root) });
    // Simulate a workspace switch to the SAME root via the fixed path
    // (deps.sessionLayoutFactory?.(abs) re-applied):
    initPathManager({ projectRoot: root, layout: factory('spin-cube')(root) });
    expect(getPathManager().listSessionIds()).toContain('sid-1');
  });

  test('FIX: switching to a different project root enumerates THAT root\'s nested sessions', () => {
    const rootA = makeProjectWithNestedSession('game-a', 'sid-a');
    const rootB = makeProjectWithNestedSession('game-b', 'sid-b');
    initPathManager({ projectRoot: rootA, layout: factory('game-a')(rootA) });
    expect(getPathManager().listSessionIds()).toContain('sid-a');
    // switch to B via factory(B)
    initPathManager({ projectRoot: rootB, layout: factory('game-b')(rootB) });
    const ids = getPathManager().listSessionIds();
    expect(ids).toContain('sid-b');
    expect(ids).not.toContain('sid-a');
  });
});
