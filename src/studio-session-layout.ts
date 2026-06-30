/** GameSessionLayout — the studio shell's game-nested SessionLayout (plan B PR2)
 *  with backward compatibility for pre-PR2 sessions (PR2-compat).
 *
 *  Canonical layout (new sessions): a session lives under its permanently-bound
 *  game at  <projectRoot>/.forgeax/games/<slug>/sessions/<sid>/ . The binding is
 *  set once at allocate() against the current active game and is recoverable from
 *  the on-disk path (path-as-SSOT); no defaultDir is persisted. A sid→slug cache
 *  makes resolution O(1); binding is permanent so the cache never invalidates.
 *
 *  Backward compat (pre-PR2 sessions live in legacy roots):
 *    - read  → sessionRoot / sessionWorkDir / listSessionIds fall back to legacy
 *              roots (`<proj>/.forgeax/sessions`, `~/.forgeax/sessions`). Only
 *              legacy sessions whose bound game (session.json.defaultDir) STILL
 *              EXISTS in this project are surfaced — this filters out unit-test
 *              pollution and other-workspace noise automatically.
 *    - write → `isLegacySession` flags such a session; `migrateLegacyIntoProject`
 *              MOVES its whole dir into games/<slug>/sessions/<sid>/ before the
 *              first write, so new + old records end up under the project.
 *
 *  This is the game-aware layout; it lives in the product shell (the cli stays
 *  game-agnostic — it only sees the SessionLayout contract). `getActiveGame` is
 *  injected so this file does not reach into game-CRUD internals. */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { listSessionDirs, type SessionLayout } from 'forgeax-cli/fs/session-layout';
import { safeSegment } from 'forgeax-cli/fs/safe-segment';
import { resolveUserDir } from 'forgeax-cli/fs/user-dir';

export class GameSessionLayout implements SessionLayout {
  private readonly gamesRoot: string;
  private readonly legacyRoots: string[];
  /** sid → bound game slug (project-local). Never invalidated. */
  private readonly slugCache = new Map<string, string>();
  /** Lazily-built index of legacy sessions worth surfacing: sid → {root, slug}.
   *  Only includes sids whose session.json.defaultDir is an existing project game.
   *  Frozen for process lifetime except entries removed on migration. */
  private legacyIndex: Map<string, { root: string; slug: string }> | null = null;

  constructor(
    projectRoot: string,
    private readonly getActiveGame: (root?: string) => string | undefined,
    opts?: { legacyRoots?: string[] },
  ) {
    this.gamesRoot = resolve(projectRoot, '.forgeax', 'games');
    this.legacyRoots = opts?.legacyRoots ?? [
      resolve(projectRoot, '.forgeax', 'sessions'), // PR1-era flat (project-local)
      join(resolveUserDir(), 'sessions'),           // original home root
    ];
  }

  // ── canonical (new sessions) ──────────────────────────────────────────────

  allocate(sid: string): { sessionRoot: string; workDir: string } {
    const slug = safeSegment(this.getActiveGame() || 'default');
    safeSegment(sid);
    this.slugCache.set(sid, slug);
    const workDir = join(this.gamesRoot, slug);
    const sessionRoot = join(workDir, 'sessions', sid);
    mkdirSync(sessionRoot, { recursive: true });
    return { sessionRoot, workDir };
  }

  sessionRoot(sid: string): string {
    const slug = this.projectSlugOf(sid);
    if (slug) return join(this.gamesRoot, slug, 'sessions', safeSegment(sid));
    const leg = this.ensureLegacyIndex().get(sid);
    if (leg) return join(leg.root, safeSegment(sid)); // read-compat: stay in legacy root
    return join(this.gamesRoot, safeSegment(this.getActiveGame() || 'default'), 'sessions', safeSegment(sid));
  }

  sessionWorkDir(sid: string): string {
    const slug = this.projectSlugOf(sid) ?? this.ensureLegacyIndex().get(sid)?.slug ?? (this.getActiveGame() || 'default');
    return join(this.gamesRoot, safeSegment(slug));
  }

  listSessionIds(): string[] {
    const out = new Set<string>();
    if (existsSync(this.gamesRoot)) {
      const seen = new Map<string, string>();
      for (const slug of this.dirsUnder(this.gamesRoot)) {
        for (const sid of listSessionDirs(join(this.gamesRoot, slug, 'sessions'))) {
          const prev = seen.get(sid);
          if (prev && prev !== slug) {
            throw new Error(`GameSessionLayout: sid ${sid} bound to multiple games (${prev}, ${slug})`);
          }
          seen.set(sid, slug);
          this.slugCache.set(sid, slug);
          out.add(sid);
        }
      }
    }
    // read-compat: surface legacy sessions (whose game still exists) not yet migrated.
    for (const sid of this.ensureLegacyIndex().keys()) out.add(sid);
    return [...out];
  }

  // ── backward compat (pre-PR2 sessions) ────────────────────────────────────

  isLegacySession(sid: string): boolean {
    if (this.projectSlugOf(sid)) return false; // already project-local
    return this.ensureLegacyIndex().has(sid);
  }

  migrateLegacyIntoProject(sid: string): void {
    const leg = this.ensureLegacyIndex().get(sid);
    if (!leg) return; // not legacy / already migrated
    const src = join(leg.root, sid);
    const destParent = join(this.gamesRoot, leg.slug, 'sessions');
    const dest = join(destParent, sid);
    this.slugCache.set(sid, leg.slug);
    this.legacyIndex?.delete(sid);
    if (existsSync(dest)) return; // already there (idempotent)
    mkdirSync(destParent, { recursive: true });
    try {
      renameSync(src, dest);
    } catch {
      // cross-device (home on a different mount): copy then remove.
      cpSync(src, dest, { recursive: true });
      rmSync(src, { recursive: true, force: true });
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** Project-local slug for sid (cache, else scan each game's sessions dir), or null. */
  private projectSlugOf(sid: string): string | null {
    const cached = this.slugCache.get(sid);
    if (cached) return cached;
    const scanned = this.scanProjectSlug(sid);
    if (scanned) {
      this.slugCache.set(sid, scanned);
      return scanned;
    }
    return null;
  }

  private scanProjectSlug(sid: string): string | undefined {
    if (!existsSync(this.gamesRoot)) return undefined;
    let found: string | undefined;
    for (const slug of this.dirsUnder(this.gamesRoot)) {
      if (existsSync(join(this.gamesRoot, slug, 'sessions', sid))) {
        if (found && found !== slug) {
          throw new Error(`GameSessionLayout: sid ${sid} bound to multiple games (${found}, ${slug})`);
        }
        found = slug;
      }
    }
    return found;
  }

  /** Build (once) the legacy index: legacy sids whose bound game exists here. */
  private ensureLegacyIndex(): Map<string, { root: string; slug: string }> {
    if (this.legacyIndex) return this.legacyIndex;
    const idx = new Map<string, { root: string; slug: string }>();
    for (const root of this.legacyRoots) {
      if (!existsSync(root)) continue;
      for (const sid of listSessionDirs(root)) {
        if (idx.has(sid)) continue;
        let slug: unknown;
        try {
          slug = (JSON.parse(readFileSync(join(root, sid, 'session.json'), 'utf-8')) as { defaultDir?: unknown }).defaultDir;
        } catch {
          continue; // no/unreadable session.json → skip
        }
        if (typeof slug === 'string' && slug && slug !== 'default' && this.gameExists(slug)) {
          idx.set(sid, { root, slug });
        }
      }
    }
    this.legacyIndex = idx;
    return idx;
  }

  // ── scope authority (Stage A §3.3) ────────────────────────────────────────

  /** The single "current scope" authority cli reads through (replaces the
   *  scattered `getActiveGame(projectRoot)` fallback — SSOT).
   *    - no sid → the current active game (== the injected getActiveGame
   *      closure), i.e. byte-for-byte the legacy fallback every consumer used;
   *    - with sid → that session's permanently-bound game (path-as-SSOT, then
   *      legacy index), else the active game.
   *  Generic/flat layouts omit this → undefined (game-agnostic standalone). */
  resolveScope(sessionId?: string, root?: string): string | undefined {
    // explicit root (workspace activation) ⇒ active game under THAT root.
    if (root) return this.getActiveGame(root);
    if (sessionId) {
      const bound = this.projectSlugOf(sessionId) ?? this.ensureLegacyIndex().get(sessionId)?.slug;
      if (bound) return bound;
    }
    return this.getActiveGame();
  }

  private gameExists(slug: string): boolean {
    try {
      return existsSync(join(this.gamesRoot, safeSegment(slug)));
    } catch {
      return false;
    }
  }

  /** Direct child "directories" of `root`, FOLLOWING symlinks. Shared games are
   *  seeded into `.forgeax/games/<slug>` as symlinks → `packages/games/<slug>`
   *  (run.sh / .app seed). A `withFileTypes` entry for a symlink reports
   *  `isDirectory() === false` (it's `isSymbolicLink()`), so a plain isDirectory
   *  filter silently DROPS every symlinked game — and with it every session under
   *  it (→ /api/sessions returns an empty per-game list → UI loses history). We
   *  therefore also admit symlinks whose resolved target is a directory. */
  private dirsUnder(root: string): string[] {
    try {
      return readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() || (e.isSymbolicLink() && this.isDirTarget(join(root, e.name))))
        .map((e) => e.name);
    } catch {
      return [];
    }
  }

  /** statSync (follows symlinks) → is the resolved target a directory? */
  private isDirTarget(p: string): boolean {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  }
}
