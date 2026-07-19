/** GameSessionLayout — game-nested layout + pre-PR2 backward compat (plan B PR2).
 *
 *  Covers:
 *    - allocate binds a new session to the active game (games/<slug>/sessions/<sid>).
 *    - read-compat: a legacy session whose bound game STILL EXISTS is surfaced
 *      (listed + resolved in its legacy root); one whose game is gone is hidden.
 *    - migrate-on-write: migrateLegacyIntoProject MOVES the whole dir into
 *      games/<slug>/sessions/<sid>/ (old content preserved), flips resolution to
 *      project-local, and is idempotent.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { GameSessionLayout } from '../src/studio-session-layout';

let proj: string;
let legacy: string; // a legacy sessions root we control (avoids touching real ~/.forgeax)

beforeEach(() => {
  proj = mkdtempSync(resolve(tmpdir(), 'forgeax-gsl-'));
  legacy = join(proj, '.forgeax', 'sessions'); // PR1-era flat legacy root
  mkdirSync(join(proj, '.forgeax', 'games'), { recursive: true });
});
afterEach(() => rmSync(proj, { recursive: true, force: true }));

function makeGame(slug: string): void {
  mkdirSync(join(proj, '.forgeax', 'games', slug), { recursive: true });
}
/** Write a legacy session (pre-PR2 shape) under the legacy root, bound to `slug`. */
function makeLegacySession(sid: string, slug: string, payload = 'OLD'): void {
  const dir = join(legacy, sid);
  mkdirSync(join(dir, 'agents', 'forge', 'events'), { recursive: true });
  writeFileSync(join(dir, 'session.json'), JSON.stringify({ displayName: sid, defaultDir: slug }) + '\n');
  writeFileSync(join(dir, 'agents', 'forge', 'events', 'events-1.jsonl'), JSON.stringify({ type: 'user_input', payload: { content: payload } }) + '\n');
}
function layout(): GameSessionLayout {
  return new GameSessionLayout(proj, () => 'active-game', { legacyRoots: [legacy] });
}

describe('GameSessionLayout — new sessions', () => {
  test('allocate binds to the active game under games/<slug>/sessions/<sid>', () => {
    makeGame('active-game');
    const l = layout();
    const { sessionRoot, workDir } = l.allocate('new1');
    expect(sessionRoot).toBe(join(proj, '.forgeax', 'games', 'active-game', 'sessions', 'new1'));
    expect(workDir).toBe(join(proj, '.forgeax', 'games', 'active-game'));
    expect(l.sessionRoot('new1')).toBe(sessionRoot);
    expect(l.isLegacySession('new1')).toBe(false);
  });
});

describe('GameSessionLayout — read-compat for legacy sessions', () => {
  test('legacy session whose game EXISTS is surfaced (listed + resolved in legacy root)', () => {
    makeGame('moo-hell');
    makeLegacySession('old1', 'moo-hell');
    const l = layout();
    expect(l.isLegacySession('old1')).toBe(true);
    expect(l.listSessionIds()).toContain('old1');
    expect(l.sessionRoot('old1')).toBe(join(legacy, 'old1')); // still readable in place
    expect(l.sessionWorkDir('old1')).toBe(join(proj, '.forgeax', 'games', 'moo-hell'));
  });

  test('legacy session whose game is GONE is hidden (filters junk / other workspaces)', () => {
    // no game created for 'fileact-wb'
    makeLegacySession('junk1', 'fileact-wb');
    const l = layout();
    expect(l.isLegacySession('junk1')).toBe(false);
    expect(l.listSessionIds()).not.toContain('junk1');
  });
});

describe('GameSessionLayout — migrate on write', () => {
  test('migrate moves the whole dir into games/<slug>/sessions/<sid> (old content kept) + flips resolution', () => {
    makeGame('moo-hell');
    makeLegacySession('old2', 'moo-hell', 'HELLO-OLD');
    const l = layout();
    expect(l.isLegacySession('old2')).toBe(true);

    l.migrateLegacyIntoProject('old2');

    const dest = join(proj, '.forgeax', 'games', 'moo-hell', 'sessions', 'old2');
    expect(existsSync(dest)).toBe(true);
    expect(existsSync(join(legacy, 'old2'))).toBe(false); // moved, not copied
    // old history preserved at the new location
    const ev = readFileSync(join(dest, 'agents', 'forge', 'events', 'events-1.jsonl'), 'utf-8');
    expect(ev).toContain('HELLO-OLD');
    // resolution now project-local; no longer legacy
    expect(l.isLegacySession('old2')).toBe(false);
    expect(l.sessionRoot('old2')).toBe(dest);
    expect(l.listSessionIds()).toContain('old2');
  });

  test('migrate is idempotent (second call is a no-op, no throw)', () => {
    makeGame('moo-hell');
    makeLegacySession('old3', 'moo-hell');
    const l = layout();
    l.migrateLegacyIntoProject('old3');
    expect(() => l.migrateLegacyIntoProject('old3')).not.toThrow();
    expect(l.sessionRoot('old3')).toBe(join(proj, '.forgeax', 'games', 'moo-hell', 'sessions', 'old3'));
  });
});

describe('GameSessionLayout — project index (perf: no per-sid scan)', () => {
  test('sid judged non-project by the index flips to project-local after allocate', () => {
    makeGame('active-game');
    const l = layout();
    // force the index to be built while sid is unknown → recorded as "not project"
    expect(l.listSessionIds()).not.toContain('later1');
    expect(l.isLegacySession('later1')).toBe(false);
    // allocate the same sid afterwards — resolution must flip immediately
    const { sessionRoot } = l.allocate('later1');
    expect(l.sessionRoot('later1')).toBe(sessionRoot);
    expect(l.listSessionIds()).toContain('later1');
  });

  test('sid judged non-project flips after migrateLegacyIntoProject', () => {
    makeGame('moo-hell');
    const l = layout();
    // build the index BEFORE the legacy session exists on disk
    expect(l.listSessionIds()).toEqual([]);
    makeLegacySession('later2', 'moo-hell');
    // legacy index is built lazily per instance; a fresh instance sees it
    const l2 = layout();
    expect(l2.listSessionIds()).not.toContain('nonexistent');
    l2.migrateLegacyIntoProject('later2');
    const dest = join(proj, '.forgeax', 'games', 'moo-hell', 'sessions', 'later2');
    expect(l2.sessionRoot('later2')).toBe(dest);
    expect(l2.listSessionIds()).toContain('later2');
  });

  test('sessions created on disk between calls are picked up (listSessionIds refreshes the index)', () => {
    makeGame('active-game');
    const l = layout();
    expect(l.listSessionIds()).toEqual([]);
    // simulate a session dir appearing without going through allocate
    mkdirSync(join(proj, '.forgeax', 'games', 'active-game', 'sessions', 'ext1'), { recursive: true });
    expect(l.listSessionIds()).toContain('ext1');
    expect(l.sessionRoot('ext1')).toBe(join(proj, '.forgeax', 'games', 'active-game', 'sessions', 'ext1'));
  });
});
