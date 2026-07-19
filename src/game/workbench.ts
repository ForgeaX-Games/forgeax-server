import { Hono } from 'hono';
import { readFile, writeFile, cp, stat, rm, unlink } from 'node:fs/promises';
import { existsSync, lstatSync, mkdirSync, readdirSync, statSync, readFileSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, basename, join, isAbsolute, dirname } from 'node:path';
// Why Bun.Glob and not node:fs/promises#glob: bun 1.3.x's shim of the node
// glob silently won't enter dot-prefixed dirs (`.forgeax/`) regardless of
// any option — patterns like `.forgeax/games/<slug>/**/*.ts` return zero
// matches even when files clearly exist. `Bun.Glob` accepts `{ dot: true }`
// and walks dot-dirs correctly. The server is already bun-only (Bun.serve /
// Bun.spawn / Bun.file in main.ts/files.ts/spawn helpers), so this is
// consistent with the rest of the codebase.
import { Glob } from 'bun';
import { defaultProjectRoot } from '@forgeax/platform-io';
import { assetRoot } from '@forgeax/platform-io';
import { friendlyPath } from '@forgeax/platform-io';
import { getActiveGame, setActiveGame, clearActiveGameIf } from './active-game';
import { findMarketplaceManifest } from '@forgeax/orchestrator/api/lib/marketplace-manifest';
import { computeAgentNaming, pickPersonName, type AgentNaming } from '@forgeax/orchestrator/api/lib/agent-naming';
import { getPathManager } from '@forgeax/orchestrator/fs/path-manager';
import { listAgents, resolvePersonaForAgent } from '@forgeax/orchestrator/agents/loader';
import { reloadExtensions } from '@forgeax/orchestrator/extensions/registry';
import { getSessionManager } from '@forgeax/orchestrator/core/session-manager';
import { getTerminalManager } from '@forgeax/orchestrator/terminal/manager';
import { BLACKBOARD_KEYS } from '@forgeax/orchestrator/defaults/blackboard-vars';
import type { FileActivityRecord } from '@forgeax/orchestrator/ledger/file-activity-ledger';
import { registry, listHistory, deleteHistory, cleanPackagingEnv, createJob, getJob, updateJob, makeProgressFn, detectEngineRoots } from './packager';
import type { TargetPlatform } from './packager';

/**
 * Valid game slug: 1-41 chars, [a-z0-9] first then [a-z0-9-]*. No
 * underscores (projects.ts allows them at the workspace level; games
 * intentionally stricter to keep URL/path/import-specifier ergonomics
 * uniform — e.g. /preview/?slug=<x> + .forgeax/games/<x>/). Exported
 * for tests (cc-game/20).
 */
export const GAME_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** Content types for the `/play/:slug/*` static route. Bun.file infers most
 *  types, but the engine is strict about `.wasm` (must be `application/wasm`
 *  for streaming instantiation) — so we pin the ones that matter and fall back
 *  to Bun's inference otherwise. */
function playMimeFor(p: string): string | undefined {
  const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase();
  const map: Record<string, string> = {
    html: 'text/html; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    mjs: 'text/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8',
    json: 'application/json; charset=utf-8',
    wasm: 'application/wasm',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    ktx2: 'image/ktx2',
    wgsl: 'text/plain; charset=utf-8',
    glb: 'model/gltf-binary',
    gltf: 'model/gltf+json',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
  };
  return map[ext];
}

/**
 * Detect whether a game dir is an interactive film-game (wb-reel): its
 * `reel/scenarios.json` exists and has a non-empty `activeId` (the author has
 * activated a scenario in the reel workbench). The package endpoint uses this
 * to route packaging to the reel bundler (a standalone film-game site) instead
 * of the 3D engine's build-standalone. Any read/parse failure is treated as
 * "not a reel game" (fall back to the existing ECS packaging path).
 *
 * Exported for tests (workbench-package-reel).
 */
export function isReelGame(gameDir: string): boolean {
  try {
    const p = join(gameDir, 'reel', 'scenarios.json');
    if (!existsSync(p)) return false;
    const db = JSON.parse(readFileSync(p, 'utf-8')) as { activeId?: unknown };
    return typeof db.activeId === 'string' && db.activeId.length > 0;
  } catch {
    return false;
  }
}

/** The active reel scenario id of a game (reel/scenarios.json `activeId`), or
 *  null when the game has no activated reel scenario. The studio preview needs
 *  this to mount <ReelPlaySurface scenarioId=...>. */
export function readReelScenarioId(gameDir: string): string | null {
  try {
    const p = join(gameDir, 'reel', 'scenarios.json');
    if (!existsSync(p)) return null;
    const db = JSON.parse(readFileSync(p, 'utf-8')) as { activeId?: unknown };
    return typeof db.activeId === 'string' && db.activeId.length > 0 ? db.activeId : null;
  } catch {
    return null;
  }
}

/** The active video-game scenario id of a game (game-video/scenarios.json
 *  `activeId`), or null when none is activated. Parallel to readReelScenarioId
 *  for the wb-game-video fork; the studio preview mounts it via
 *  <GameVideoPlaySurface scenarioId=...>. */
export function readGameVideoScenarioId(gameDir: string): string | null {
  try {
    const p = join(gameDir, 'game-video', 'scenarios.json');
    if (!existsSync(p)) return null;
    const db = JSON.parse(readFileSync(p, 'utf-8')) as { activeId?: unknown };
    return typeof db.activeId === 'string' && db.activeId.length > 0 ? db.activeId : null;
  } catch {
    return null;
  }
}

/**
 * The declared project type of a game. Decision B: the type is declared in the
 * game's `forge.json` (`projectType: "reel"` is stamped by the wb-reel
 * scenario-save link). The studio preview routes on THIS, not on a
 * reel/scenarios.json heuristic.
 *
 * Back-compat fallback: pre-existing reel games created before the forge.json
 * stamp existed are still recognized via isReelGame() so their preview routes
 * correctly; the next reel-save will backfill the explicit forge.json field.
 */
export function readProjectType(gameDir: string): 'reel' | 'engine' | 'game-video' {
  try {
    const m = JSON.parse(readFileSync(join(gameDir, 'forge.json'), 'utf-8')) as {
      projectType?: unknown;
    };
    if (m.projectType === 'reel' || m.projectType === 'engine' || m.projectType === 'game-video') {
      return m.projectType;
    }
  } catch {
    /* no/invalid forge.json — fall through to heuristic backfill */
  }
  return isReelGame(gameDir) ? 'reel' : 'engine';
}

const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** After scaffold-copying a game template, give the new game its own identity
 *  for every asset it DEFINES, while leaving references to SHARED/builtin assets
 *  intact.
 *
 *  Why: template GUIDs are shared across all scaffolds, so without regeneration
 *  two games collide in the global catalog. But a scaffold also *references*
 *  assets it does not define — builtin meshes (the cylinder), shared HDR/material
 *  GUIDs — via pack `refs[]` and hardcoded literals in main.ts (SCENE_GUID,
 *  CYLINDER_GUID). Those must keep pointing at the real shared asset.
 *
 *  So the map is seeded ONLY from locally-defined `asset.guid` (pass 1), then
 *  every GUID reference across all game text files — pack payloads/refs,
 *  forge.json.defaultScene, main.ts/src literals — is rewritten through it
 *  (pass 2, `map.get ?? keep`). A reference to a GUID the game never defines is
 *  a map miss and survives unchanged. Regenerating those (the previous bug)
 *  pointed them at phantom GUIDs → asset-not-found / `/__import` 404 → blank
 *  scene. */
async function regenerateGameGuids(gameDir: string): Promise<void> {
  // Pass 1 — collect the GUIDs this game DEFINES (asset.guid in its packs) and
  // assign each a fresh unique identity.
  const guidMap = new Map<string, string>();
  const packGlob = new Glob('**/*.pack.json');
  for await (const fp of packGlob.scan({ cwd: gameDir, absolute: true, dot: true })) {
    if (fp.includes('node_modules')) continue;
    try {
      const pack = JSON.parse(await readFile(fp, 'utf-8')) as { assets?: { guid?: string }[] };
      for (const asset of pack.assets ?? []) {
        if (typeof asset.guid === 'string' && !guidMap.has(asset.guid)) {
          guidMap.set(asset.guid, crypto.randomUUID());
        }
      }
    } catch { /* skip malformed pack files */ }
  }
  if (guidMap.size === 0) return;
  // Pass 2 — rewrite every reference to a locally-defined GUID across all game
  // text files (packs, forge.json, main.ts/src). External refs miss the map and
  // are preserved.
  const textGlob = new Glob('**/*.{ts,tsx,js,jsx,mjs,cjs,json}');
  for await (const fp of textGlob.scan({ cwd: gameDir, absolute: true, dot: true })) {
    if (fp.includes('node_modules')) continue;
    try {
      const raw = await readFile(fp, 'utf-8');
      const next = raw.replace(GUID_RE, (g) => guidMap.get(g) ?? g);
      if (next !== raw) await writeFile(fp, next, 'utf-8');
    } catch { /* skip unreadable files */ }
  }
}

function resolveGameTemplate(projectRoot: string): string | null {
  const userOverride = resolve(projectRoot, '.forgeax/games/_template');
  if (existsSync(userOverride)) return userOverride;
  // Use assetRoot() to locate the builtin template across all platforms/modes
  // (dev source tree, or packaged app). assetRoot() points to the 'packages' level.
  // Engine is now the editor's nested submodule (top-level packages/engine removed).
  const builtin = resolve(assetRoot(), '..', 'packages', 'editor', 'packages', 'engine', 'templates', 'game-default');
  if (existsSync(builtin)) return builtin;
  return null;
}

interface MarketplaceAgent {
  id: string;
  role: string;
  cardName: { zh?: string; en?: string };
  color?: string;
  avatar?: string;
  produces?: string[];
  status?: 'active' | 'placeholder';
  default?: boolean;
}

interface ResolvedFile {
  name: string;
  path: string;
  ico: string;
}

function iconFor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['ts', 'tsx', 'js', 'jsx'].includes(ext)) return '📄';
  if (['md'].includes(ext)) return name.includes('pillar') ? '🏛️' : name.includes('design') ? '📐' : name.includes('dialog') || name.includes('narrative') ? '💬' : '📝';
  if (['json'].includes(ext)) return name.includes('manifest') ? '📦' : name.includes('tree') ? '📖' : '⚙️';
  if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) return '🖼️';
  if (['spine'].includes(ext) || name.includes('.spine.')) return '🦴';
  if (['mp3', 'wav', 'ogg'].includes(ext)) return '🎵';
  return '📄';
}

function expandTemplates(pattern: string, slug?: string): string {
  // Expand <slug>, <module>, <category>, <id>, <ext>, <doc_dir>, <active_game>.dir
  // Game paths anchor at `.forgeax/games/<slug>/` post-2026-05-13 refactor
  // (was `forgeax/games/<slug>/` when the forgeax submodule was the project root).
  let p = pattern;
  if (slug) p = p.replace(/<slug>/g, slug);
  // Remaining templates → wildcards
  p = p
    .replace(/<doc_dir>/g, slug ? `.forgeax/games/${slug}/design` : '.forgeax/games/*/design')
    .replace(/<active_game>\.dir/g, slug ? `.forgeax/games/${slug}` : '.forgeax/games/*')
    .replace(/<slug>/g, '*')
    .replace(/<module>/g, '*')
    .replace(/<category>/g, '*')
    .replace(/<id>/g, '*')
    .replace(/<ext>/g, '*')
    .replace(/<scene>/g, '*');
  return p;
}

// Defensive resolver guards. Some plugin manifests ship unbounded patterns
// (`**/*.ts`) that aren't anchored to <active_game>.dir; without filtering
// they walk every nested workspace's node_modules and return 60k+ matches
// per agent → 50MB JSON, 7s blocking glob. Skip the noise dirs, and cap
// total matches per agent — the UI renders this as a sidebar list and
// can't reasonably display thousands of files anyway.
const NOISE_RX = /(?:^|\/)(?:node_modules|dist|build|\.git|\.cache|\.forgeax\/cache|\.forgeax\/agenteam-state)(?:\/|$)/;
const MAX_FILES_PER_AGENT = 200;

/** Group ledger records by agent → unique paths (latest write per path).
 *  Returns `{ agentId → ResolvedFile[] }`. agentId here = the **last segment**
 *  of agentPath, matching the manifest agent ids ("iori/suzu" → "suzu",
 *  "root" → "root"). Unknown agents (eg "root" when no manifest entry) are
 *  bucketed under their full path.
 *
 *  This is the SSOT-derived attribution (see [[file-activity-tracking]]) —
 *  uses what an agent actually wrote, not what its produces[] manifest says
 *  it might write. Two agents with overlapping produces no longer both
 *  claim the same file. */
function ledgerFilesByAgent(records: FileActivityRecord[], projectRoot: string): Map<string, ResolvedFile[]> {
  // Most-recent-write wins per path. Walk newest-first (caller passes that
  // order) and keep first-seen.
  const seenPath = new Map<string, { agentId: string; rec: FileActivityRecord }>();
  for (const rec of records) {
    if (rec.op === 'delete') continue; // deleted files don't belong to anyone
    if (seenPath.has(rec.path)) continue;
    const agentId = rec.agentPath.split('/').pop() || rec.agentPath;
    seenPath.set(rec.path, { agentId, rec });
  }
  const out = new Map<string, ResolvedFile[]>();
  for (const { agentId, rec } of seenPath.values()) {
    const rel = rec.path.startsWith(projectRoot + '/') ? rec.path.slice(projectRoot.length + 1) : rec.path;
    if (NOISE_RX.test(rel)) continue;
    const file: ResolvedFile = { name: rel.split('/').pop() ?? rel, path: rel, ico: iconFor(rel.split('/').pop() ?? rel) };
    let bucket = out.get(agentId);
    if (!bucket) { bucket = []; out.set(agentId, bucket); }
    if (bucket.length < MAX_FILES_PER_AGENT) bucket.push(file);
  }
  return out;
}

async function resolveProduces(root: string, patterns: string[], slug?: string): Promise<ResolvedFile[]> {
  const out: ResolvedFile[] = [];
  const seen = new Set<string>();
  outer: for (const raw of patterns) {
    const pattern = expandTemplates(raw, slug);
    try {
      // dot:true so patterns rooted at `.forgeax/games/<slug>/` actually
      // descend (default behavior in Bun.Glob is to skip dot-prefixed dirs).
      const g = new Glob(pattern);
      for await (const match of g.scan({ cwd: root, dot: true })) {
        if (NOISE_RX.test(match)) continue;
        if (seen.has(match)) continue;
        seen.add(match);
        // /api/files expects paths relative to projectRoot. Post-refactor,
        // projectRoot is the studio/instance root and patterns already start
        // with `.forgeax/games/...` — no prefix stripping needed.
        out.push({ name: basename(match), path: match, ico: iconFor(basename(match)) });
        if (out.length >= MAX_FILES_PER_AGENT) break outer;
      }
    } catch (e) {
      // pattern not matchable; skip silently
    }
  }
  return out;
}

async function listAllGames(root: string): Promise<Array<{ slug: string; name: string; mtime: number; fileCount: number; projectType: 'reel' | 'engine' | 'game-video'; reelScenarioId: string | null }>> {
  /* UI enumeration — reads all game dirs as a flat scan; resolves via projectRoot
   * directly rather than per-slug pm.user().gameDir for O(1) listing. */
  const gamesDir = resolve(root, '.forgeax/games');
  if (!existsSync(gamesDir)) return [];
  const out: Array<{ slug: string; name: string; mtime: number; fileCount: number; projectType: 'reel' | 'engine' | 'game-video'; reelScenarioId: string | null }> = [];
  try {
    for (const slug of readdirSync(gamesDir)) {
      if (slug.startsWith('.') || slug.startsWith('_')) continue;
      const dir = resolve(gamesDir, slug);
      // Per-entry guard: a dangling symlink (e.g. a games/<slug> link whose
      // target was removed by a submodule sync) makes statSync throw ENOENT.
      // This MUST NOT abort the whole enumeration — a loop-wide try/catch would
      // truncate the list at the first bad entry, silently dropping every game
      // read after it (including the active game). The UI then can't find the
      // active slug in the list and falls back to games[0], previewing the
      // wrong game. Skip the bad entry instead of bailing out.
      let st: ReturnType<typeof statSync>;
      try { st = statSync(dir); } catch { continue; }
      if (!st.isDirectory()) continue;
      let name = slug;
      try {
        const m = JSON.parse(readFileSync(resolve(dir, 'forge.json'), 'utf-8') ?? '{}') as { name?: string };
        if (typeof m.name === 'string') name = m.name;
      } catch { /* no forge.json */ }
      let fileCount = 0;
      // Cap at 5000 — UI only shows the count as a badge; saves walking
      // huge node_modules trees a freshly-npm-installed game might carry.
      const fcGlob = new Glob('**/*');
      for await (const _ of fcGlob.scan({ cwd: dir, dot: true })) {
        fileCount++;
        if (fileCount >= 5000) break;
      }
      // Decision B: declared project type from forge.json (reel / game-video
      // preview routing). `reelScenarioId` carries the active scenario id for
      // BOTH reel and the wb-game-video fork (the studio reads it generically).
      const projectType = readProjectType(dir);
      const reelScenarioId = projectType === 'game-video' ? readGameVideoScenarioId(dir) : null;
      out.push({ slug, name, mtime: st.mtimeMs, fileCount, projectType, reelScenarioId });
    }
  } catch { /* ignore */ }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}


export function createWorkbenchRouter(): Hono {
  const router = new Hono();

  // ── GET /active-slug — single-field, low-cost. Polled every 5s by
  // PreviewMode, so it must NOT touch marketplace manifest, listAgents(), or
  // produces[] glob resolution. Just one readdir + statSync per .forgeax/games/.
  router.get('/active-slug', (c) => {
    const projectRoot = defaultProjectRoot();
    return c.json({ activeSlug: getActiveGame(projectRoot) ?? null });
  });

  // ── GET /games — list all games + current ──
  // listAllGames + getActiveGame look under <projectRoot>/.forgeax/games/
  // (post-2026-05-13 refactor: games live in instance-local .forgeax/games/
  // under the studio root, not in the forgeax submodule).
  router.get('/games', async (c) => {
    const projectRoot = defaultProjectRoot();
    const games = await listAllGames(projectRoot);
    const activeSlug = getActiveGame(projectRoot);
    return c.json({ games, activeSlug });
  });

  // ── GET /templates — list built-in games usable as first-run templates ──
  // Source is the official examples under assetRoot()/games (dev: packages/games;
  // packaged: Resources/games). Read-only: onboarding "从模板创建" copies one of
  // these into a fresh workspace via POST /api/workspaces/activate {template}.
  // Filters underscore/dot/scripts entries and anything without a forge.json.
  router.get('/templates', (c) => {
    const gamesRoot = resolve(assetRoot(), 'games');
    const out: Array<{ slug: string; name: string }> = [];
    try {
      for (const entry of readdirSync(gamesRoot)) {
        if (entry.startsWith('.') || entry.startsWith('_') || entry === 'scripts') continue;
        const dir = resolve(gamesRoot, entry);
        try {
          if (!statSync(dir).isDirectory()) continue;
          const forgeJson = join(dir, 'forge.json');
          if (!existsSync(forgeJson)) continue;
          let name = entry;
          try {
            const parsed = JSON.parse(readFileSync(forgeJson, 'utf-8')) as { name?: string };
            if (typeof parsed.name === 'string' && parsed.name) name = parsed.name;
          } catch { /* keep slug as name */ }
          out.push({ slug: entry, name });
        } catch { /* skip unreadable entry */ }
      }
    } catch { /* games root missing → empty list */ }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return c.json({ templates: out });
  });

  // ── DELETE /games/:slug — remove a game's whole dir ──
  // Charter P3 (explicit contract): detect symlinks with lstatSync so that
  // DELETE of a symlinked game only removes the link node, never follows
  // into the submodule target. Dangling symlinks (broken links) are also
  // cleaned up — lstatSync sees the link node even when existsSync can't.
  router.delete('/games/:slug', async (c) => {
    const slug = c.req.param('slug');
    if (!GAME_SLUG_RE.test(slug ?? '')) {
      return c.json({ error: 'invalid slug' }, 400);
    }
    const pm = getPathManager();
    const gameDir = pm.user().gameDir(slug);
    let isSymlink = false;
    try { isSymlink = lstatSync(gameDir).isSymbolicLink(); } catch { /* not found */ }
    if (!isSymlink && !existsSync(gameDir)) return c.json({ error: 'not found' }, 404);
    try {
      if (isSymlink) {
        // Symlinked game (shared-library submodule): only remove the link
        // node, never recurse into the submodule target (charter P3).
        await unlink(gameDir);
      } else {
        await rm(gameDir, { recursive: true, force: true });
      }
      // If the deleted game was the explicitly-pinned active game, drop the
      // binding so getActiveGame re-derives from the remaining games instead of
      // staying pinned to a now-missing dir.
      clearActiveGameIf(defaultProjectRoot(), slug!);
      return c.json({ ok: true, slug });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  // ── /agents response cache for the `?include=files` hot path ──
  // AgentsPanel + WorkbenchMode poll at 4 s with include=files, which walks
  // produces[] globs for ~19 agents per call. Default path (no include=files)
  // is already <2ms and not worth caching. Cache key includes lang + slug +
  // include flag so different callers don't poison each other's view.
  type AgentsResp = { agents: unknown[]; activeSlug: string | undefined };
  const agentsCache = new Map<string, { ts: number; resp: AgentsResp }>();
  const AGENTS_TTL_MS = 2500;
  // Persona read/write BY AGENT ID — resolves the REAL persona file across
  // L0/L1/L2 via the plugin snapshot (resolvePersonaForAgent), so roles created
  // by role.create (living in L1 `~/.forgeax` or L2 `<project>/.forgeax`, NOT
  // `packages/marketplace`) are viewable/editable in wb-agent-persona. The
  // editor's old `/api/files?path=packages/marketplace/extensions/agent-<id>/…`
  // assumed L0 → 404 for created roles (files whitelist also excludes
  // `.forgeax/extensions/**` and can't reach `~/.forgeax` at all).
  const resolvePersonaAny = async (raw: string) => {
    const cands = [raw, raw.replace(/^@[^/]+\//, ''), raw.replace(/^@[^/]+\//, '').replace(/^agent-/, '')];
    for (const cand of cands) {
      const p = await resolvePersonaForAgent(cand);
      if (p) return p;
    }
    return null;
  };
  router.get('/agents/:id/persona', async (c) => {
    const id = c.req.param('id');
    const lang = c.req.query('lang') === 'en' ? 'en' : 'zh';
    const persona = await resolvePersonaAny(id);
    if (!persona) return c.json({ error: `agent not found: ${id}` }, 404);
    const target = join(dirname(persona.personaPath), `${lang}.md`);
    const path = existsSync(target) ? target : persona.personaPath;
    try {
      const content = await readFile(path, 'utf-8');
      return c.json({ content, lang, path });
    } catch (e) {
      return c.json({ error: `read failed: ${(e as Error).message}` }, 404);
    }
  });
  router.put('/agents/:id/persona', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as { lang?: string; content?: unknown };
    const lang = body.lang === 'en' ? 'en' : 'zh';
    if (typeof body.content !== 'string') return c.json({ error: 'content (string) required' }, 400);
    const persona = await resolvePersonaAny(id);
    if (!persona) return c.json({ error: `agent not found: ${id}` }, 404);
    const target = join(dirname(persona.personaPath), `${lang}.md`);
    try {
      await writeFile(target, body.content, 'utf-8');
      await reloadExtensions();
      return c.json({ ok: true, path: target });
    } catch (e) {
      return c.json({ error: `write failed: ${(e as Error).message}` }, 500);
    }
  });

  router.get('/agents', async (c) => {
    const lang = (c.req.query('lang') ?? 'en') as 'zh' | 'en';
    const pinnedSlug = c.req.query('slug') ?? undefined;
    // `?include=files` opts into per-agent files[] resolution. Default skips
    // it: most callers (PreviewMode, FilesPanel, Composer, agent-role, etc.)
    // only read activeSlug/role/name/avatar, and resolving files was the
    // single largest source of UI slowdown.
    //
    // When include=files AND a sid is given, the response is **ledger-derived**
    // (real attribution from <sid>/file-activity.jsonl). Without sid we fall
    // back to the legacy produces[] glob (intent-based) so the endpoint stays
    // usable on a fresh server with no open session.
    const includeFiles = (c.req.query('include') ?? '').split(',').includes('files');
    const sid = c.req.query('sid') ?? undefined;
    const projectRoot = defaultProjectRoot();

    // Ledger-derived files share the per-agent SSOT — read once per request,
    // bucket-by-agent, then look up at render time. Empty when no sid or the
    // session isn't open.
    let ledgerByAgent: Map<string, ResolvedFile[]> | null = null;
    if (includeFiles && sid) {
      try {
        const session = getSessionManager().peek(sid);
        if (session) {
          const records = session.fileActivity.query({ limit: 1000 });
          ledgerByAgent = ledgerFilesByAgent(records, projectRoot);
        }
      } catch { /* ignore — fall back to glob */ }
    }

    // TTL cache only for include=files (the expensive path). sid + slug both
    // baked in so different sessions/games don't poison each other's view.
    const cacheKey = includeFiles ? `${lang}:${pinnedSlug ?? '_auto'}:${sid ?? '_nosid'}` : null;
    if (cacheKey) {
      const hit = agentsCache.get(cacheKey);
      if (hit && Date.now() - hit.ts < AGENTS_TTL_MS) return c.json(hit.resp);
    }

    const found = findMarketplaceManifest(projectRoot);
    if (!found.path) {
      return c.json({
        agents: [],
        error: 'marketplace/manifest.json not found',
        tried: found.triedFriendly,
      });
    }
    const manifestPath = found.path;
    // Use projectRoot directly as the resolution root — patterns are
    // `.forgeax/games/...` relative to instance/studio root.
    const root = projectRoot;
    try {
      const raw = await readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(raw) as { agents?: MarketplaceAgent[] };
      const autoSlug = getActiveGame(root);
      const slug = pinnedSlug ?? autoSlug;

      // ADR-0019: 为 legacy manifest.json agents 也注入 avatarRules. 字典 key 是
      // plugin 自报 id (def.id, e.g. "arin"/"iori"). legacy "forge" 视觉上是 Arin
      // → 显式 alias. 其它 legacy id (iori/suzu/kotone/iro/tsumugi/cc-coder) 同名
      // 直接匹配上 plugin agent-iori/agent-suzu/... 因为它们的 def.id 就这么写的.
      const extensionEntries = listAgents();
      type AvatarRulesT = NonNullable<(typeof extensionEntries)[number]['definition']['avatarRules']>;
      const avatarRulesById = new Map<string, AvatarRulesT>();
      for (const e of extensionEntries) {
        if (e.definition.avatarRules) {
          avatarRulesById.set(e.definition.id, e.definition.avatarRules);
        }
      }
      // forge → arin (legacy 主 agent 复用 Arin 立绘).
      const arinRules = avatarRulesById.get('arin');
      if (arinRules && !avatarRulesById.has('forge')) {
        avatarRulesById.set('forge', arinRules);
      }

      // 统一命名「中文职能·英文名」+ 灰字英文职能。card 是 SSOT（plugin 自带
      // cnTitle/enTitle/name）；legacy manifest agent 也按 id 借 plugin card 拼。
      type CardT = (typeof extensionEntries)[number]['definition']['card'];
      const cardById = new Map<string, CardT>();
      for (const e of extensionEntries) cardById.set(e.definition.id, e.definition.card);
      const namingFor = (
        id: string,
        fallbackName: string,
        legacyProfession?: { zh?: string; en?: string },
      ): { naming: AgentNaming; personName?: string } => {
        // forge：legacy-only 编排者，没有 plugin card，合成英文名 Forge。
        if (id === 'forge') {
          return {
            naming: computeAgentNaming({
              personName: 'Forge',
              cnTitle: legacyProfession?.zh ?? '主线制作人',
              enTitle: legacyProfession?.en ?? 'Lead Producer',
              fallback: fallbackName,
            }, lang),
            personName: 'Forge',
          };
        }
        const card = cardById.get(id);
        const cn = card?.cnTitle;
        const pn = cn ? pickPersonName(card?.name) : undefined;
        return {
          naming: computeAgentNaming({
            personName: pn,
            cnTitle: cn,
            enTitle: card?.enTitle,
            fallback: fallbackName,
          }, lang),
          personName: pn,
        };
      };

      const agents = await Promise.all(
        (manifest.agents ?? []).map(async (a) => {
          let files: ResolvedFile[] = [];
          if (includeFiles && a.status !== 'placeholder') {
            // SSOT path: real ledger attribution wins when we have a session.
            // Empty bucket = agent simply hasn't written anything yet → empty
            // list (correct, not "show their produces[]"). Falling back to
            // glob would re-introduce the multi-agent-claiming-same-file bug.
            if (ledgerByAgent) {
              files = ledgerByAgent.get(a.id) ?? [];
            } else {
              files = await resolveProduces(root, a.produces ?? [], slug);
            }
          }
          const ar = avatarRulesById.get(a.id);
          const name = a.cardName[lang] ?? a.cardName.zh ?? a.cardName.en ?? a.id;
          const { naming, personName } = namingFor(a.id, name, a.cardName);
          return {
            id: a.id,
            name,
            ...(personName ? { personName } : {}),
            naming,
            role: a.role,
            color: a.color,
            avatar: a.avatar ?? a.id[0].toUpperCase(),
            ...(ar ? { avatarRules: ar } : {}),
            status: a.status ?? 'active',
            isMain: Boolean(a.default),
            files,
          };
        }),
      );
      // Merge plugin-provided agents (kind=agent in the plugin bus). These
      // come from packages/marketplace/extensions/agent-* manifests, distinct
      // from the legacy peers listed in marketplace/manifest.json above.
      // De-dupe by id so a plugin-defined agent doesn't double up with the
      // hand-curated manifest entry.
      const seenIds = new Set(agents.map((a) => a.id));
      for (const entry of listAgents()) {
        const def = entry.definition;
        if (seenIds.has(def.id)) continue;
        seenIds.add(def.id);
        const cardName = def.card.name;
        const name = typeof cardName === 'string'
          ? cardName
          : (cardName[lang] ?? cardName.zh ?? cardName.en ?? def.id);
        const { naming, personName } = namingFor(def.id, name);
        agents.push({
          id: def.id,
          name,
          ...(personName ? { personName } : {}),
          naming,
          role: def.role,
          color: def.card.color,
          avatar: def.card.avatar ?? def.id[0].toUpperCase(),
          // ADR-0019: WEBM 状态机. 仅当 loader 成功解析 AVATAR.md 时存在.
          ...(def.avatarRules ? { avatarRules: def.avatarRules } : {}),
          status: 'active',
          isMain: false,
          files: !includeFiles
            ? []
            : ledgerByAgent
              ? (ledgerByAgent.get(def.id) ?? [])
              : await resolveProduces(root, def.produces ?? [], slug),
        });
      }
      const resp: AgentsResp = { agents, activeSlug: slug };
      if (cacheKey) agentsCache.set(cacheKey, { ts: Date.now(), resp });
      return c.json(resp);
    } catch (e) {
      return c.json({ agents: [], error: (e as Error).message });
    }
  });

  // ── POST /games — create a new game scaffold (mkdir + forge.json + main.ts) ──
  // Optional `template` = a built-in game slug (GET /templates, sourced from
  // assetRoot()/games) to copy from instead of the blank `_template`/game-default.
  // Either way the copy gets fresh GUIDs (regenerateGameGuids) so a template
  // copied into a workspace that already holds games can't collide in the catalog.
  router.post('/games', async (c) => {
    let body: { slug?: string; name?: string; brief?: string; template?: string };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'invalid json' }, 400);
    }
    const slug = String(body?.slug ?? '').trim();
    if (!GAME_SLUG_RE.test(slug)) {
      return c.json({ error: 'slug must be 2-41 chars lowercase ASCII / digits / hyphens' }, 400);
    }
    const projectRoot = defaultProjectRoot();
    const pm = getPathManager();
    const gameDir = pm.user().gameDir(slug);
    if (existsSync(gameDir)) {
      return c.json({ error: `.forgeax/games/${slug} already exists`, slug }, 409);
    }
    let templateDir: string | null;
    if (body.template) {
      const tslug = String(body.template).trim();
      if (!GAME_SLUG_RE.test(tslug)) return c.json({ error: 'invalid template slug' }, 400);
      const cand = resolve(assetRoot(), 'games', tslug);
      templateDir = existsSync(cand) ? cand : null;
      if (!templateDir) return c.json({ error: `template not found: ${tslug}` }, 404);
    } else {
      templateDir = resolveGameTemplate(projectRoot);
    }
    if (!templateDir) {
      return c.json({ error: 'game template not found — expected .forgeax/games/_template/ or packages/editor/packages/engine/templates/game-default/' }, 500);
    }
    try {
      // Skip per-instance state when copying (built-in templates like spin-cube
      // ship a sessions/ dir + may have node_modules — not part of the template).
      await cp(templateDir, gameDir, {
        recursive: true,
        filter: (src) => { const b = basename(src); return b !== 'sessions' && b !== 'node_modules' && b !== '.git'; },
      });
      // Give the new game unique identities for the assets it defines, remapping
      // every reference (pack refs/payload, forge.json.defaultScene, main.ts
      // literals) while preserving refs to shared/builtin assets.
      await regenerateGameGuids(gameDir);
      // Replace id in forge.json (defaultScene already remapped by the pass above).
      const manifestPath = join(gameDir, 'forge.json');
      if (existsSync(manifestPath)) {
        const raw = await readFile(manifestPath, 'utf-8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        parsed.id = slug;
        parsed.name = body.name ?? slug;
        await writeFile(manifestPath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
      } else {
        await writeFile(manifestPath, JSON.stringify({ id: slug, name: body.name ?? slug, entry: 'main.ts' }, null, 2) + '\n', 'utf-8');
      }
      // FORGE.md — capture optional brief for the agent's later reference
      const memoPath = join(gameDir, 'FORGE.md');
      const memo = `# ${body.name ?? slug}\n\n${body.brief ? body.brief + '\n' : '_(no brief yet — tell Forge what you want to make)_\n'}`;
      await writeFile(memoPath, memo, 'utf-8');
      // A freshly-created game is what the user wants to work on next — record
      // it as the explicit active game and relocate live sessions' cli there,
      // so the agent's shell stops resolving against the previous game.
      setActiveGame(projectRoot, slug);
      return c.json({ ok: true, slug, gameDir: friendlyPath(gameDir) });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  // ── POST /games/link — adopt an existing game dir at an arbitrary path ──
  // The game keeps living at its own path; we just symlink it into this
  // workspace's .forgeax/games/<slug> so it belongs to the workspace (same
  // mechanism as the seeded shared games: .forgeax/games/<slug> -> /abs/path).
  // Used by first-run onboarding "打开目录" and any "adopt existing game" flow.
  router.post('/games/link', async (c) => {
    let body: { path?: string; slug?: string };
    try { body = (await c.req.json()) as typeof body; }
    catch { return c.json({ error: 'invalid json' }, 400); }
    const raw = String(body?.path ?? '').trim();
    if (!raw) return c.json({ error: 'path required' }, 400);
    if (raw.includes('\0')) return c.json({ error: 'invalid path (NUL byte)' }, 400);

    let abs = raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw;
    if (!isAbsolute(abs)) return c.json({ error: 'path must be absolute or start with ~' }, 400);
    abs = resolve(abs);
    if (!existsSync(abs)) return c.json({ error: `not found: ${friendlyPath(abs)}` }, 404);
    if (!statSync(abs).isDirectory()) return c.json({ error: `not a directory: ${friendlyPath(abs)}` }, 400);

    // Must look like a game — forge.json (canonical) or a bare main.ts entry.
    // Empty (or junk/dotfile-only) dirs get a default template scaffolded in place
    // first so onboarding "打开目录" can mount a blank folder outside the workspace.
    let isGame = existsSync(join(abs, 'forge.json')) || existsSync(join(abs, 'main.ts'));
    let scaffolded = false;
    if (!isGame) {
      // Ignore macOS/Windows junk + any dot entry (.git, .DS_Store, .vscode, …).
      // A folder with only those still counts as "empty" for auto-init.
      const junk = new Set(['Thumbs.db', 'desktop.ini', '__MACOSX']);
      const entries = readdirSync(abs).filter((n) => {
        if (n === '.' || n === '..') return false;
        if (n.startsWith('.')) return false;
        if (junk.has(n)) return false;
        return true;
      });
      if (entries.length === 0) {
        const scaffoldRoot = defaultProjectRoot();
        const templateDir = resolveGameTemplate(scaffoldRoot);
        if (!templateDir) {
          return c.json({ error: 'game template not found — cannot scaffold empty folder' }, 500);
        }
        try {
          await cp(templateDir, abs, {
            recursive: true,
            filter: (src) => {
              const b = basename(src);
              return b !== 'sessions' && b !== 'node_modules' && b !== '.git';
            },
          });
          await regenerateGameGuids(abs);
          const slugGuess = basename(abs).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
          const manifestPath = join(abs, 'forge.json');
          if (existsSync(manifestPath)) {
            const parsed = JSON.parse(await readFile(manifestPath, 'utf-8')) as Record<string, unknown>;
            parsed.id = slugGuess;
            parsed.name = basename(abs) || slugGuess;
            await writeFile(manifestPath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
          } else {
            await writeFile(
              manifestPath,
              JSON.stringify({ id: slugGuess, name: basename(abs) || slugGuess, entry: 'main.ts' }, null, 2) + '\n',
              'utf-8',
            );
          }
          scaffolded = true;
          isGame = true;
        } catch (e) {
          return c.json({ error: `failed to scaffold empty folder: ${(e as Error).message}` }, 500);
        }
      }
    }
    if (!isGame) return c.json({ error: 'not a game folder (expected forge.json or main.ts inside)' }, 400);

    // Derive slug: explicit body.slug → forge.json.id → dir basename.
    let slug = String(body?.slug ?? '').trim();
    if (!slug) {
      try {
        const fj = JSON.parse(readFileSync(join(abs, 'forge.json'), 'utf-8')) as { id?: unknown };
        if (typeof fj.id === 'string') slug = fj.id;
      } catch { /* fall through to basename */ }
    }
    if (!slug) slug = basename(abs);
    slug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
    if (!GAME_SLUG_RE.test(slug)) return c.json({ error: 'could not derive a valid slug — pass one explicitly' }, 400);

    const projectRoot = defaultProjectRoot();
    const gamesRoot = resolve(projectRoot, '.forgeax/games');
    const linkPath = resolve(gamesRoot, slug);
    if (existsSync(linkPath) || (() => { try { return !!lstatSync(linkPath); } catch { return false; } })()) {
      return c.json({ error: `.forgeax/games/${slug} already exists`, slug }, 409);
    }
    try {
      mkdirSync(gamesRoot, { recursive: true });
      // 'junction' on Windows: links a dir without admin rights (unlike 'dir').
      symlinkSync(abs, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      setActiveGame(projectRoot, slug);
      return c.json({
        ok: true,
        slug,
        gameDir: friendlyPath(linkPath),
        target: friendlyPath(abs),
        ...(scaffolded ? { scaffolded: true } : {}),
      });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  // ── POST /games/:slug/activate — make a game the explicit active game ──
  // Called by the TopBar game switcher when the user picks a game. Records the
  // choice (active-game.json) AND relocates every live session's cli into the
  // game dir, so "session 拉起的 cli 的默认工作目录就是对应的激活 game".
  router.post('/games/:slug/activate', async (c) => {
    const slug = c.req.param('slug');
    if (!GAME_SLUG_RE.test(slug ?? '')) {
      return c.json({ error: 'invalid slug' }, 400);
    }
    const projectRoot = defaultProjectRoot();
    const gameDir = resolve(projectRoot, '.forgeax/games', slug);
    if (!existsSync(gameDir)) {
      return c.json({ error: `.forgeax/games/${slug} not found`, slug }, 404);
    }
    setActiveGame(projectRoot, slug);
    return c.json({ ok: true, activeSlug: slug });
  });

  // ── POST /games/:slug/verify — build/import preflight (closed-loop check) ──
  // The agent writes the game's main.ts + src/ server-side, but the BUILD (vite
  // import-analysis) + RENDER happen client-side where the agent can't see them
  // — so it can declare "done" on a game whose Preview is actually a red error
  // overlay (e.g. main.ts imports "./src/components" that doesn't exist). This
  // bundles the game's main.ts with Bun.build (engine packages external — we
  // only check the game's OWN import graph), surfacing unresolved imports /
  // missing files / syntax errors deterministically, WITHOUT a browser. The
  // agent MUST call this and reach `ok:true` before claiming the game is done.
  router.post('/games/:slug/verify', async (c) => {
    const slug = c.req.param('slug');
    if (!GAME_SLUG_RE.test(slug ?? '')) {
      return c.json({ error: 'invalid slug' }, 400);
    }
    const projectRoot = defaultProjectRoot();
    const gameDir = resolve(projectRoot, '.forgeax/games', slug);
    const mainPath = resolve(gameDir, 'main.ts');
    if (!existsSync(mainPath)) {
      return c.json({ ok: false, errors: [{ message: `main.ts not found at .forgeax/games/${slug}/main.ts — scaffold the game first` }] });
    }
    const rel = (f?: string): string | undefined => (f ? f.replace(`${projectRoot}/`, '') : undefined);
    try {
      // engine packages are resolved by the preview's vite, not here — external
      // them so we only validate the game's own (relative) import graph + syntax.
      const result = await Bun.build({
        entrypoints: [mainPath],
        target: 'browser',
        external: ['@forgeax/*'],
        throw: false,
      });
      const errors: Array<{ file?: string; line?: number; message: string }> = result.logs
        .filter((l) => l.level === 'error')
        .map((l) => ({ file: rel(l.position?.file), line: l.position?.line, message: l.message }));

      // Contract-drift typecheck: Bun.build only resolves the import GRAPH; it
      // transpiles WITHOUT type checking, so cross-file API mismatches (e.g.
      // src/survivor.ts calls `hud.setHp` when src/hud.ts only defines `setHP`)
      // pass build and then crash at runtime as `hud.setHp is not a function`.
      // Fold the @forgeax/engine-project contract gate (crash-class TS codes only)
      // into this required preflight so the agent must fix drift before `ok:true`.
      // Run via its bin (Bun.spawn) so the ~2s compile stays off the event loop
      // and behind a process boundary; skip gracefully if the engine isn't built.
      try {
        const tcBin = resolve(projectRoot, 'packages/editor/packages/engine/packages/engine-project/dist/cli.mjs');
        if (existsSync(tcBin)) {
          const proc = Bun.spawn({
            cmd: [process.execPath || 'bun', tcBin, gameDir, '--json'],
            stdout: 'pipe',
            stderr: 'pipe',
          });
          const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
          const tc = JSON.parse(out) as {
            ok: boolean;
            diagnostics: Array<{ file?: string; line?: number; code: number; message: string }>;
          };
          for (const d of tc.diagnostics) {
            errors.push({ file: rel(d.file), line: d.line, message: `TS${d.code}: ${d.message}` });
          }
        }
      } catch {
        // typecheck unavailable / output unparseable — don't block delivery on a
        // gate-infra error; the import preflight above still stands.
      }

      return c.json({ ok: result.success && errors.length === 0, errors });
    } catch (e) {
      return c.json({ ok: false, errors: [{ message: (e as Error)?.message ?? String(e) }] });
    }
  });

  // ── POST /games/:slug/package — cross-platform game packaging ──
  // Body: { targetPlatform?, rebuildEngine?, forceRebuild? }
  // ALL platforms (web included) run asynchronously — the response returns a
  // jobId immediately so the client can show a live progress overlay while the
  // build runs. (Web used to be synchronous, which made the UI look frozen for
  // the whole Vite build with zero feedback — "点了没反应，半天才弹详情".)
  router.post('/games/:slug/package', async (c) => {
    const slug = c.req.param('slug');
    if (!GAME_SLUG_RE.test(slug ?? '')) {
      return c.json({ error: 'invalid slug' }, 400);
    }

    let targetPlatform: TargetPlatform = 'web';
    let rebuildEngine = false;
    let forceRebuild = false;
    let engineRoot: string | undefined;
    let androidAppId: string | undefined;
    let androidAppName: string | undefined;
    let androidProjectName: string | undefined;
    let androidIcon: { dataBase64: string; filename: string } | undefined;
    let androidOrientation: 'portrait' | 'landscape' | undefined;
    let iosBundleId: string | undefined;
    let iosAppName: string | undefined;
    let iosProjectName: string | undefined;
    let iosIcon: { dataBase64: string; filename: string } | undefined;
    let iosOrientation: 'portrait' | 'landscape' | undefined;
    try {
      const body = await c.req.json() as {
        targetPlatform?: string;
        rebuildEngine?: boolean;
        forceRebuild?: boolean;
        engineRoot?: string;
        androidAppId?: string;
        androidAppName?: string;
        androidProjectName?: string;
        androidIcon?: { dataBase64?: string; filename?: string };
        androidOrientation?: string;
        iosBundleId?: string;
        iosAppName?: string;
        iosProjectName?: string;
        iosIcon?: { dataBase64?: string; filename?: string };
        iosOrientation?: string;
      } | null;
      if (body?.targetPlatform) targetPlatform = body.targetPlatform as TargetPlatform;
      if (body?.rebuildEngine) rebuildEngine = true;
      if (body?.forceRebuild) forceRebuild = true;
      if (body?.engineRoot) engineRoot = body.engineRoot;
      if (body?.androidAppId) androidAppId = String(body.androidAppId);
      if (body?.androidAppName) androidAppName = String(body.androidAppName);
      if (body?.androidProjectName) androidProjectName = String(body.androidProjectName);
      if (body?.androidIcon?.dataBase64) {
        androidIcon = {
          dataBase64: String(body.androidIcon.dataBase64),
          filename: String(body.androidIcon.filename ?? 'icon.png'),
        };
      }
      if (body?.androidOrientation === 'portrait' || body?.androidOrientation === 'landscape') {
        androidOrientation = body.androidOrientation;
      }
      if (body?.iosBundleId) iosBundleId = String(body.iosBundleId);
      if (body?.iosAppName) iosAppName = String(body.iosAppName);
      if (body?.iosProjectName) iosProjectName = String(body.iosProjectName);
      if (body?.iosIcon?.dataBase64) {
        iosIcon = {
          dataBase64: String(body.iosIcon.dataBase64),
          filename: String(body.iosIcon.filename ?? 'icon.png'),
        };
      }
      if (body?.iosOrientation === 'portrait' || body?.iosOrientation === 'landscape') {
        iosOrientation = body.iosOrientation;
      }
    } catch { /* default to 'web' */ }

    const projectRoot = defaultProjectRoot();
    const gameDir = resolve(projectRoot, '.forgeax/games', slug);

    const job = createJob(slug!, targetPlatform);
    // Web ships to `.forgeax/exports/<slug>`; native platforms carry a suffix
    // so they don't clobber the web build (and so `/play/<slug>` maps 1:1 to
    // the web export dir).
    const outDir = targetPlatform === 'web'
      ? resolve(projectRoot, '.forgeax/exports', slug!)
      : resolve(projectRoot, '.forgeax/exports', `${slug}-${targetPlatform}`);
    const onProgress = makeProgressFn(job.id);

    // Fire-and-forget — run in background, client polls /package/jobs/:id.
    (async () => {
      updateJob(job.id, { status: 'running', phase: 'starting' });
      try {
        const result = await registry.build({
          slug: slug!,
          gameDir,
          projectRoot,
          outDir,
          platform: targetPlatform,
          rebuildEngine,
          forceRebuild,
          engineRoot,
          androidAppId,
          androidAppName,
          androidProjectName,
          androidIcon,
          androidOrientation,
          iosBundleId,
          iosAppName,
          iosProjectName,
          iosIcon,
          iosOrientation,
          onProgress,
        });
        updateJob(job.id, {
          status: result.ok ? 'success' : 'failed',
          phase: result.ok ? 'done' : 'failed',
          finishedAt: Date.now(),
          result: result as unknown as Record<string, unknown>,
        });
      } catch (e) {
        updateJob(job.id, {
          status: 'failed',
          phase: 'error',
          finishedAt: Date.now(),
          result: { ok: false, error: e instanceof Error ? e.message : String(e) },
        });
      }
    })();

    return c.json({ async: true, jobId: job.id, slug, platform: targetPlatform });
  });

  // ── GET /package/jobs/:id — poll async job progress ──
  router.get('/package/jobs/:id', (c) => {
    const job = getJob(c.req.param('id'));
    if (!job) return c.json({ error: 'job not found' }, 404);
    return c.json(job);
  });

  // ── GET /package/engine-roots — detect engine-root candidates for export ──
  router.get('/package/engine-roots', (c) => {
    return c.json({ roots: detectEngineRoots(resolve(assetRoot(), '..')) });
  });

  // ── GET /package/history — list packaging history ──
  router.get('/package/history', (c) => {
    return c.json({ records: listHistory() });
  });

  // ── POST /package/clean — wipe local packaging environment ──
  // Removes the isolated Rust toolchain, launcher-shell cache and leftover
  // .forgeax-export scratch dirs. Does NOT touch export products or history.
  router.post('/package/clean', (c) => {
    return c.json(cleanPackagingEnv());
  });

  // ── DELETE /package/history/:id — delete a single history record ──
  router.delete('/package/history/:id', (c) => {
    const clean = c.req.query('clean') === '1';
    const ok = deleteHistory(c.req.param('id'), clean);
    if (!ok) return c.json({ error: 'record not found' }, 404);
    return c.json({ ok: true });
  });

  // ── POST /package/reveal — open an export product folder in the OS file
  // manager (Finder / Explorer / xdg). Body: { path }. The path must resolve
  // inside .forgeax/exports so a rogue caller can't open arbitrary dirs. ──
  router.post('/package/reveal', async (c) => {
    let target = '';
    try { target = String(((await c.req.json()) as { path?: unknown })?.path ?? ''); } catch { /* empty */ }
    const exportsRoot = resolve(defaultProjectRoot(), '.forgeax/exports');
    const abs = resolve(exportsRoot, target.replace(/^.*\.forgeax\/exports\/?/, ''));
    if (!abs.startsWith(exportsRoot) || !existsSync(abs)) {
      return c.json({ ok: false, error: 'path not found under exports' }, 400);
    }
    try {
      const cmd = process.platform === 'win32'
        ? ['explorer', abs]
        : process.platform === 'darwin'
          ? ['open', abs]
          : ['xdg-open', abs];
      Bun.spawn({ cmd, stdout: 'ignore', stderr: 'ignore' });
      return c.json({ ok: true, path: abs });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  // ── GET /play/:slug/* — one-click local playtest for a Web export, served
  // directly by the studio server. This replaces the old `/package/serve` that
  // spawned `npx serve` — that had a slow, unpredictable first-run download
  // (the package is fetched on demand) and we could only guess when it was
  // ready before opening the tab, so the browser often hit a not-yet-bound
  // server → blank/black tab. Serving from the already-running studio process
  // is instant, same-origin (a secure context on localhost → WebGPU works),
  // and lets us set the correct `.wasm` MIME the engine needs. The web export
  // is base-relative (`base: './'`), so it runs fine under this `/play/<slug>/`
  // subpath. Path is confined to `.forgeax/exports/<slug>` (no traversal).
  router.get('/play/:slug/*', async (c) => {
    const slug = c.req.param('slug');
    if (!GAME_SLUG_RE.test(slug ?? '')) return c.text('bad slug', 400);
    const exportsRoot = resolve(defaultProjectRoot(), '.forgeax/exports');
    const base = resolve(exportsRoot, slug!);
    if (!base.startsWith(exportsRoot) || !existsSync(base)) {
      return c.text('export not found — package this game for Web first', 404);
    }
    const marker = `/play/${slug}/`;
    const at = c.req.path.indexOf(marker);
    let rel = at === -1 ? '' : c.req.path.slice(at + marker.length);
    try { rel = decodeURIComponent(rel); } catch { /* keep raw */ }
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const abs = resolve(base, rel);
    if (!abs.startsWith(base) || !existsSync(abs)) return c.text('not found', 404);
    const file = Bun.file(abs);
    const type = playMimeFor(abs) ?? (file.type || 'application/octet-stream');
    return new Response(file, { headers: { 'content-type': type, 'cache-control': 'no-cache' } });
  });

  // ── GET /events/recent — recent file activity across .forgeax/games/, with agent attribution ──
  // Polled every 4s by WorkbenchMode.AgentsMainArea ledger panel. Each call
  // glob-walks all agents × all games' produces[] then stat()s every match,
  // so a 2.5s in-memory TTL absorbs ~half the work without any visible lag
  // (UI just shows recently-touched files; sub-3s freshness is invisible).
  // Cache is keyed by lang because agent display name varies. Limit isn't in
  // the key — we cache the unsliced list and slice at response time.
  type LedgerEvent = { name: string; path: string; agentId: string; agentName: string; mtime: number; ico?: string };
  const ledgerCache = new Map<string, { ts: number; events: LedgerEvent[] }>();
  const LEDGER_TTL_MS = 2500;
  router.get('/events/recent', async (c) => {
    const lang = (c.req.query('lang') ?? 'en') as 'zh' | 'en';
    const limit = Math.min(Number(c.req.query('limit') ?? 30), 100);
    const now = Date.now();
    const cached = ledgerCache.get(lang);
    if (cached && now - cached.ts < LEDGER_TTL_MS) {
      return c.json({ events: cached.events.slice(0, limit) });
    }
    const projectRoot = defaultProjectRoot();
    const manifestPath = findMarketplaceManifest(projectRoot).path;
    const events: LedgerEvent[] = [];
    if (manifestPath) {
      const root = projectRoot;
      try {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { agents?: MarketplaceAgent[] };
        // Ledger spans ALL games — pass undefined so produces glob matches all slugs.
        for (const a of manifest.agents ?? []) {
          if (a.status === 'placeholder') continue;
          const files = await resolveProduces(root, a.produces ?? [], undefined);
          for (const f of files) {
            try {
              const abs = resolve(root, f.path);
              const st = await stat(abs);
              events.push({
                name: f.name, path: f.path, agentId: a.id,
                agentName: a.cardName[lang] ?? a.cardName.zh ?? a.id,
                mtime: st.mtimeMs,
                ico: f.ico,
              });
            } catch { /* skip */ }
          }
        }
      } catch { /* manifest unreadable */ }
    }
    events.sort((a, b) => b.mtime - a.mtime);
    ledgerCache.set(lang, { ts: now, events });
    return c.json({ events: events.slice(0, limit) });
  });

  return router;
}
