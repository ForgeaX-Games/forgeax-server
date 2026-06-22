// Load $FORGEAX_PROJECT_ROOT/.env into process.env BEFORE any module reads it.
// Bun auto-loads .env from CWD (packages/server) but the canonical .env lives
// at the studio root — without this prefix, LITELLM_PROXY_*, OPENAI_*, ARK_*
// silently disappear when the server is started outside `bun run` from root.
// existing process.env wins (so explicit shell exports still override file).
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
{
  const root = process.env.FORGEAX_PROJECT_ROOT ?? resolve(import.meta.dir, '../../..');
  if (!process.env.FORGEAX_PROJECT_ROOT) process.env.FORGEAX_PROJECT_ROOT = root;
  const file = resolve(root, '.env');
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf-8').split('\n')) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      const [, k, raw] = m;
      if (process.env[k] !== undefined) continue;
      let v = raw;
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      process.env[k] = v;
    }
  }
}

import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { createFilesRouter } from './api/files';
import { createAssetsRouter } from './api/assets';
import { createWorkbenchRouter } from './api/workbench';
import { createProjectsRouter } from './api/projects';
import { createFsBrowserRouter } from './api/fs-browser';
import { createWorkspacesRouter } from './api/workspaces';
import { createSettingsRouter } from './api/settings';
import { createBootSplashRouter } from './api/boot-splash';
import { createVersionRouter, getVersion } from './api/version';
import { createChangelogRouter } from './api/changelog';
import { createSessionsRouter } from './api/sessions';
import { createCommandsApiRouter } from './api/commands';
import { createCliRouter } from './api/cli/chat';
import { createBrandRouter, loadBrand } from './brand';
import { createBusRouter } from './api/bus';
import { createPluginsRouter } from './api/plugins';
import { reloadPlugins } from './plugins/registry';
import { createThreadsRouter } from './api/threads';
import { createCharacterRouter } from './api/wb-character';
import { createBgmRouter } from './api/wb-bgm';
import { createLlmTestRouter } from './api/llm-test';
import { createUsageRouter } from './api/usage';
import { createToolsRouter } from './api/tools';
import { createEventsRouter } from './api/events';
import { createSkillsRouter } from './api/skills';
import { createPacksRouter } from './api/packs';
import { createRuntimeRouter } from './api/runtime';
import { createObservatoryRouter } from './api/observatory';
import { createCeApiShimRouter } from './api/ce-api-shim';
import { createPrefsRouter } from './api/prefs';
import { createLogsRouter, appendToStream, logsDir } from './api/logs';
import { bootCliProviders } from './cli-providers';
import { defaultProjectRoot } from './api/lib/safe-path';
import { friendlyPath } from './api/lib/friendly-path';
import { mp, interfaceDist as resolveInterfaceDist } from './lib/asset-root';
import { FsWatcher } from './api/lib/watcher';
import { WsHub, createWsHandler, type WsClientData } from './ws';
import { initPathManager } from './fs/path-manager';
import { ensureUserDirDefaults } from './defaults/scaffold';
import { initSessionManager, getSessionManager } from './core/session-manager';
import { listAllCommands } from './commands/runner';
import { getTerminalManager } from './terminal/manager';
import { listProviders } from './cli-providers/registry';
import './llm/register-all';

// ──────────────────────────────────────────────────────────────────────────
// FaultBoundary — top-level process-wide exception backstop (perf-analysis-2
// server P0-1, 维度 2). forgeax-server is the SINGLE runtime core: every
// session, chat turn, HMR reload + spawned child lives in this one process.
// Before this, the process had NO uncaughtException / unhandledRejection
// handler, so any stray throw on a turn/stream/observer killed the WHOLE
// server and every session with it.
//
// Contract:
//   • STARTUP (before the HTTP server is listening): a fatal error — e.g.
//     EADDRINUSE on bind, a broken plugin scan — MUST still crash loudly so
//     we never "pretend to be up" while actually dead. `serverReady` gates
//     this: until it flips true, an uncaughtException re-throws / exits(1).
//   • RUNTIME (after listening): a single turn / stream / observer throwing is
//     downgraded from "kill the whole process" to "log one structured line
//     and keep serving every other session". NEVER process.exit here.
let serverReady = false;

function logFatal(kind: string, err: unknown): void {
  const e = err instanceof Error ? err : new Error(String(err));
  // Structured single-line JSON so operators / log scrapers can grep it.
  const rec = {
    ts: new Date().toISOString(),
    level: 'error',
    component: 'fault-boundary',
    kind,
    phase: serverReady ? 'runtime' : 'startup',
    msg: e.message,
    stack: e.stack ?? null,
  };
  try { process.stderr.write(JSON.stringify(rec) + '\n'); } catch { /* stderr gone */ }
}

process.on('uncaughtException', (err) => {
  logFatal('uncaughtException', err);
  // Startup-phase failures are genuinely fatal — bind errors, missing dist,
  // broken boot wiring. Exiting here is correct: a half-initialised server is
  // worse than a clean crash the supervisor (run.sh) can restart.
  if (!serverReady) {
    process.stderr.write('[forgeax-server] fatal during startup — exiting\n');
    process.exit(1);
  }
  // Runtime phase: stay alive. One bad turn must not take the host down.
});

process.on('unhandledRejection', (reason) => {
  logFatal('unhandledRejection', reason);
  // A rejected promise is never a reason to kill the host at runtime; and at
  // startup it would already surface via the awaited boot chain below, so we
  // only log here and never exit (avoids racing the boot await with a double
  // exit). Startup-fatal sync throws are handled by uncaughtException above.
});

const PORT = Number(process.env.FORGEAX_SERVER_PORT ?? 18900);
const HOST = process.env.FORGEAX_SERVER_HOST ?? '0.0.0.0';
// Studio-wide version (v0.M.D.N). Sourced from scripts/version.sh via run.sh
// (FORGEAX_VERSION env / dist/version.json), with live-git fallback for dev mode.
const FORGEAX_VERSION = getVersion();
const VERSION = FORGEAX_VERSION.version;
const KEY_AUDIT = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
  'ARK_IMAGE_KEY', 'ARK_VIDEO_KEY', 'AZURE_GPT_IMAGE_KEY', 'LITELLM_PROXY_KEY']
  .map((k) => `${k}=${process.env[k] ? '✓' : '·'}`)
  .join(' ');
console.log(`[forgeax-server] ${VERSION} · commit ${FORGEAX_VERSION.sha} · ${FORGEAX_VERSION.date}`);
console.log(`[forgeax-server] env: ${KEY_AUDIT}`);
try {
  const br = loadBrand();
  console.log(`[forgeax-server] brand: ${br.config.id} (${br.source.kind}) · ${br.config.product.name}`);
} catch (e) {
  console.warn(`[forgeax-server] brand: load failed — ${(e as Error).message}`);
}
const WATCH_FS = process.env.FORGEAX_NO_WATCH !== '1';

const app = new Hono();
const hub = new WsHub();
const watcher = new FsWatcher();
const projectRoot = defaultProjectRoot();

const pm = initPathManager();
await ensureUserDirDefaults(pm);
const sm = initSessionManager(pm);

// Phase B3 — plugin scan MUST finish before scheduler.start(): host_tool_bridge
// enumerates listTools() on agent attach; if agents boot first, character:* /
// narrative:* tools stay empty for the whole session until a lucky re-sync.
{
  const snap = await reloadPlugins();
  const issueCount = snap.scanErrors.length + snap.mergeIssues.length + snap.kinds.issues.length;
  console.log(
    `[forgeax-server] plugins loaded: ${snap.manifests.length} manifest(s) · ` +
      `${snap.kinds.workbench.length} workbench · ${snap.kinds.skills.length} skill · ` +
      `${snap.kinds.agents.length} agent · ${issueCount} issue(s)`,
  );
  for (const e of snap.scanErrors) console.warn(`[forgeax-server] plugin scan error (${e.layer}): ${e.originPath} — ${e.reason}`);
  for (const i of snap.mergeIssues) console.warn(`[forgeax-server] plugin merge issue: ${i.pluginId} — ${i.detail}`);
  for (const i of snap.kinds.issues) console.warn(`[forgeax-server] plugin kind issue: ${i.pluginId} — ${i.reason}`);
}

const restored = await sm.bootAutoStart();
for (const s of restored) s.scheduler.start();
console.log(`[forgeax-server] sessions restored: ${restored.length}`);

// Commands transport — stateless directory scanner (agenteam-os-ref parity).
// Modules live at `packages/server/commands/*.ts`; runner re-scans on every
// list/query/execute call (mtime cache-bust dynamic import). Boot-time pass
// is purely diagnostic: surfaces _error:<file> specs early so a broken module
// shows up in startup log instead of silently 500-ing the first caller.
{
  const specs = await listAllCommands({ sm, paths: pm });
  const real = specs.filter((s) => !s.name.startsWith("_error:"));
  const bad = specs.filter((s) => s.name.startsWith("_error:"));
  console.log(`[forgeax-server] commands discovered: ${real.length} ok · ${bad.length} broken`);
  for (const b of bad) console.warn(`[forgeax-server] ${b.name}: ${b.description}`);
}

// Temporary cli-providers bridge (claude-code only for now). Independent REST
// branch under /api/cli/*, every response carries `Deprecation: true`. Will be
// replaced by commands.attach_script_agent + ScriptAgent at forgeax-v1.0.
await bootCliProviders();

// ── Server-side logging (mirrors the browser log sink into .forgeax/logs) ─────
// Server errors previously hit ONLY stderr (uncaughtException/logFatal); the UI
// never saw them and they weren't on disk with the browser streams. Capture them
// into the 'server' stream (readable via GET /api/logs/server).
const LOGS_DIR = logsDir(projectRoot);
function serverLog(entry: Record<string, unknown>): void {
  // Fire-and-forget; appendToStream is async + serialized + size-rotated and
  // never throws into the request path.
  void appendToStream(LOGS_DIR, 'server', [{ ts: Date.now(), ...entry }]).catch(() => {});
}

// Request logger — HIGH SIGNAL ONLY (5xx or slow ≥1s). Logging every request
// would flood the stream with health polls / SSE / fs events (the disk-flood we
// are hardening against). Registered before routes so it wraps them all.
app.use('*', async (c, next) => {
  const t0 = performance.now();
  await next();
  const ms = Math.round(performance.now() - t0);
  const status = c.res.status;
  if ((status >= 500 || ms >= 1000) && !c.req.path.startsWith('/api/logs')) {
    serverLog({ kind: 'request', method: c.req.method, path: c.req.path, status, ms });
  }
});

// Global error handler — previously absent, so a thrown route handler became an
// opaque 500 with the cause only on stderr. Capture + return a clean 500.
app.onError((err, c) => {
  serverLog({ kind: 'error', method: c.req.method, path: c.req.path, message: err.message, stack: err.stack });
  console.error('[forgeax-server] unhandled route error:', c.req.method, c.req.path, err);
  return c.json({ error: 'internal error' }, 500);
});

app.get('/api/health', (c) => {
  const mem = process.memoryUsage();
  return c.json({
    status: 'ok',
    version: VERSION,
    name: '@forgeax/server',
    pid: process.pid,
    uptime: process.uptime(),
    projectRoot: friendlyPath(projectRoot),
    wsClients: hub.size(),
    // Resource usage for the status-bar RES chip (rss = process working set).
    mem: { rss: mem.rss, heapUsed: mem.heapUsed },
  });
});

console.log(`[forgeax-server] project root = ${projectRoot}`);

// HTTP surface scope (post-runtime-rewrite cleanup):
//   Server only owns session-management-and-below — workspace activation,
//   file/fs/projects browsing, settings, version, changelog, boot splash,
//   workbench (game/agent UI list). Anything agent-level (chat, sessions,
//   threads, runs, daemons) was deleted along with the cli daemon model.
//   The runtime/ rewrite (docs/features/runtime-rewrite-core-plan.md) will
//   bring those back via the agenteam-style commands transport (3 endpoints:
//   list / query / execute) instead of one HTTP route per concern.
// Plugin iframe assets — wb-character vite build lives in the marketplace
// submodule and is served verbatim under /plugins/wb-character/*. Path is
// resolved from main.ts source location so it works regardless of process.cwd.

// 插件 iframe 入口 html 禁用缓存:dist 资源文件名带内容 hash(可长缓存),但
// index.html 入口必须每次重新拉取,否则 webview/iframe 命中旧 html → 引用旧
// hash 的 JS,导致「改了代码、重新构建,APP 却刷不出新版本」。对 html 文档
// (路径以 / 结尾或 .html 结尾、且非静态资源)统一加 no-store。
app.use('/plugins/*', async (c, next) => {
  await next();
  const p = new URL(c.req.url).pathname;
  const isHtmlDoc = p.endsWith('/') || p.endsWith('.html');
  // Entry JS bundles (no content-hash in name, e.g. index-DuAj5FnI.js that is reused
  // across builds) must not be cached, otherwise old dynamic-import paths reference
  // chunks that no longer exist and the page breaks silently.
  const isEntryJs = p.endsWith('.js') && !p.includes('/jszip') && !p.includes('/PipelineSession') && !p.includes('/CharacterRender');
  if (isHtmlDoc || isEntryJs) {
    c.header('Cache-Control', 'no-store, must-revalidate');
    c.header('Pragma', 'no-cache');
  }
  // Allow iframed plugins to fetch() their own static assets (images, JSON, etc.)
  // without canvas CORS taint. Same-origin in dev, cross-origin in embeds.
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Cross-Origin-Resource-Policy', 'cross-origin');
});

// wb-gen3d generated 3D assets — content-addressed blobs (GLB/PNG) live under
// the project root, NOT the marketplace dir. LocalBlobStore persists each
// manifest file's localUrl as `/api/gen3d-blobs/<storageKey>` where storageKey
// is `blobs/<sha[0:2]>/<sha>.<ext>`; this route maps the prefix back to the
// gen3d asset root so the plugin UI can <img>/GLTFLoader them. Blob names carry
// their sha256 (immutable) so they are safely long-cacheable.
const gen3dAssetRoot = resolve(projectRoot, '.forgeax', 'assets', 'gen3d');
app.use('/api/gen3d-blobs/*', serveStatic({
  root: gen3dAssetRoot,
  rewriteRequestPath: (p) => p.replace(/^\/api\/gen3d-blobs/, '') || '/',
  onFound: (_p, c) => {
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    c.header('Cross-Origin-Resource-Policy', 'cross-origin');
  },
}));

// wb-gen3d per-game 3D assets (M9 / ADR-0002). The plugin's per-game store
// writes generation output to
// `.forgeax/games/<slug>/assets/3d/{characters|meshes}/<name>.glb` (+ preview
// sidecar) and persists each file's localUrl as
// `/api/game-assets/<slug>/3d/<slot>/<file>`. This route is the read-only
// preview surface for those files. It is deliberately NOT a general file
// server for the game dir: it only serves files under `assets/3d/**`, rejects
// unsafe slugs and `..` traversal, and asserts the resolved path stays inside
// `<gameDir>/assets/3d/`. Mutations still go through the gen3d:delete-asset tool.
const gamesRoot = resolve(projectRoot, '.forgeax', 'games');
const GAME_ASSETS_RE = /^\/api\/game-assets\/([^/]+)\/3d\/(.+)$/;
const SAFE_SLUG_RE = /^[A-Za-z0-9._-]+$/;
app.get('/api/game-assets/:slug/*', async (c) => {
  const m = GAME_ASSETS_RE.exec(c.req.path);
  if (!m) return c.text('not found', 404);
  let slug: string;
  let tail: string;
  try {
    slug = decodeURIComponent(m[1]!);
    tail = decodeURIComponent(m[2]!);
  } catch {
    return c.text('bad path', 400);
  }
  if (!SAFE_SLUG_RE.test(slug) || slug === '..') return c.text('bad slug', 400);
  if (tail.includes('\0') || tail.split('/').includes('..')) return c.text('bad path', 400);
  const assets3dDir = resolve(gamesRoot, slug, 'assets', '3d');
  const abs = resolve(assets3dDir, tail);
  // Double-guard against traversal: the resolved path must stay under assets/3d.
  if (abs !== assets3dDir && !abs.startsWith(assets3dDir + '/')) return c.text('forbidden', 403);
  const file = Bun.file(abs);
  if (!(await file.exists())) return c.text('not found', 404);
  c.header('Cache-Control', 'public, max-age=3600');
  c.header('Cross-Origin-Resource-Policy', 'cross-origin');
  return new Response(file);
});

const wbCharDist = mp('wb-character', 'dist');
app.use('/plugins/wb-character/*', serveStatic({
  root: wbCharDist,
  rewriteRequestPath: (p) => {
    const rest = p.replace(/^\/plugins\/wb-character/, '') || '/';
    return rest === '/' ? '/index.html' : rest;
  },
}));

const wbNarrDist = mp('wb-narrative', 'viz', 'dist');
app.use('/plugins/wb-narrative/*', serveStatic({
  root: wbNarrDist,
  rewriteRequestPath: (p) => {
    const rest = p.replace(/^\/plugins\/wb-narrative/, '') || '/';
    return rest === '/' ? '/index.html' : rest;
  },
}));

const wbSkillDist = mp('wb-skill', 'dist');
app.use('/plugins/wb-skill/*', serveStatic({
  root: wbSkillDist,
  rewriteRequestPath: (p) => {
    const rest = p.replace(/^\/plugins\/wb-skill/, '') || '/';
    return rest === '/' ? '/index.html' : rest;
  },
}));

const wbAnimDist = mp('wb-anim', 'dist');
app.use('/plugins/wb-anim/*', serveStatic({
  root: wbAnimDist,
  rewriteRequestPath: (p) => {
    const rest = p.replace(/^\/plugins\/wb-anim/, '') || '/';
    return rest === '/' ? '/index.html' : rest;
  },
}));

// wb-gen3d — production 3D generation UI. Embedded same-origin (manifest
// entry.standalone.embeddedAlso:true) like every other workbench frontend,
// instead of the fragile cross-origin standalone dev port (:15175). The plugin
// builds with vite `base: './'` so emitted asset URLs are relative and resolve
// under this mount. Pairs with the /api/gen3d-blobs/* route above.
const wbGen3dDist = mp('wb-gen3d', 'dist');
app.use('/plugins/wb-gen3d/*', serveStatic({
  root: wbGen3dDist,
  rewriteRequestPath: (p) => {
    const rest = p.replace(/^\/plugins\/wb-gen3d/, '') || '/';
    return rest === '/' ? '/index.html' : rest;
  },
}));

// wb-ui - standard UI workshop Vite build served as a same-origin iframe.
const wbUiDist = mp('wb-ui', 'dist');
app.use('/plugins/wb-ui/*', serveStatic({
  root: wbUiDist,
  rewriteRequestPath: (p) => {
    const rest = p.replace(/^\/plugins\/wb-ui/, '') || '/';
    return rest === '/' ? '/index.html' : rest;
  },
}));

// wb-lowpoly-obj — v0.1.0 scaffold serves index.html directly from the
// submodule source (no build step required for the form-only UI).
const wbLowpolyDir = mp('wb-lowpoly-obj');
app.use('/plugins/wb-lowpoly-obj/*', serveStatic({
  root: wbLowpolyDir,
  rewriteRequestPath: (p) => {
    const rest = p.replace(/^\/plugins\/wb-lowpoly-obj/, '') || '/';
    return rest === '/' ? '/index.html' : rest;
  },
}));

// wb-agent-persona — v0.1.0 single-file editor; same no-build pattern as
// wb-lowpoly-obj. Loads /api/bus/plugins?kind=agent → reads/writes
// `packages/marketplace/plugins/<short-id>/persona/zh.md` via /api/files.
const wbAgentPersonaDir = mp('wb-agent-persona');
app.use('/plugins/wb-agent-persona/*', serveStatic({
  root: wbAgentPersonaDir,
  rewriteRequestPath: (p) => {
    const rest = p.replace(/^\/plugins\/wb-agent-persona/, '') || '/';
    return rest === '/' ? '/index.html' : rest;
  },
}));

// wb-observatory — Vite/React app, mirrors wb-character's serve-from-dist
// pattern. Source lives in `packages/marketplace/plugins/wb-observatory/`
// and `bun run build` emits to `dist/` (vite `base: /plugins/wb-observatory/`
// so emitted asset URLs work behind this mount).
const wbObservatoryDist = mp('wb-observatory', 'dist');
app.use('/plugins/wb-observatory/*', serveStatic({
  root: wbObservatoryDist,
  rewriteRequestPath: (p) => {
    const rest = p.replace(/^\/plugins\/wb-observatory/, '') || '/';
    return rest === '/' ? '/index.html' : rest;
  },
}));

// wb-bgm — Music & BGM plugin. Vendored vanilla-TS SPA (audio/SFX library)
// built with vite `base: /plugins/wb-bgm/` so emitted asset URLs resolve
// behind this mount. The audio LOGIC now lives in the marketplace plugin
// (registry tools via /api/tools/call); only /api/wb/bgm/cos-proxy remains here.
const wbBgmDist = resolve(import.meta.dir, '../../marketplace/plugins/wb-bgm/dist');
app.use('/plugins/wb-bgm/*', serveStatic({
  root: wbBgmDist,
  rewriteRequestPath: (p) => {
    const rest = p.replace(/^\/plugins\/wb-bgm/, '') || '/';
    return rest === '/' ? '/index.html' : rest;
  },
}));

// wb-scene — node-pipeline editor (3-pane: editor + renderer + assetstore).
// Editor is the iframe entry; built dist with vite `base: /plugins/wb-scene/`
// is served here. Renderer (9556) + AssetStore (9560) remain separate dev
// servers iframed by the editor at runtime; they are NOT served by host.
const wbSceneDist = mp('wb-scene', 'frontend', 'editor', 'dist');
app.use('/plugins/wb-scene/*', serveStatic({
  root: wbSceneDist,
  rewriteRequestPath: (p) => {
    const rest = p.replace(/^\/plugins\/wb-scene/, '') || '/';
    return rest === '/' ? '/index.html' : rest;
  },
}));

// wb-reel — interactive FMV editor (Reel Studio). The plugin's full source
// is the `forgeax-wb-reel` submodule mounted at
// `packages/marketplace/plugins/wb-reel`; the marketplace entry's
// `dist/` is a symlink to that submodule's built dist (built with
// `WB_REEL_PLUGIN_BUILD=1 npx vite build`, which sets vite `base:
// /plugins/wb-reel/` so emitted asset URLs work behind this mount). Same
// serve-from-dist pattern as wb-character / wb-observatory.
const wbReelDist = mp('wb-reel', 'dist');
app.use('/plugins/wb-reel/*', serveStatic({
  root: wbReelDist,
  rewriteRequestPath: (p) => {
    const rest = p.replace(/^\/plugins\/wb-reel/, '') || '/';
    return rest === '/' ? '/index.html' : rest;
  },
}));

// wb-scene backend API proxy. Plugin's Fastify backend listens on port
// `WB_SCENE_API_PORT` (default 9557) and exposes /api/v1/* + /ws/*. The host
// proxies same-origin so the iframe sees /api/v1/* without CORS.
app.all('/api/v1/*', async (c) => {
  const port = process.env.WB_SCENE_API_PORT ?? '9557';
  const target = `http://127.0.0.1:${port}`;
  const url = new URL(c.req.url);
  const resp = await fetch(`${target}${url.pathname}${url.search}`, {
    method: c.req.method,
    headers: c.req.raw.headers,
    body: c.req.method !== 'GET' && c.req.method !== 'HEAD' ? c.req.raw.body : undefined,
    // duplex: 'half' is needed for streaming request bodies; recent
    // @types/node / lib.dom.d.ts now ship the type so the @ts-expect-error
    // it used to need has been dropped.
    duplex: 'half',
  });
  return new Response(resp.body, { status: resp.status, headers: resp.headers });
});

app.all('/api/narrative/*', async (c) => {
  const narrativePort = process.env.NARRATIVE_PORT ?? '8900';
  const target = `http://127.0.0.1:${narrativePort}`;
  const url = new URL(c.req.url);
  try {
    const resp = await fetch(`${target}${url.pathname}${url.search}`, {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: c.req.method !== 'GET' && c.req.method !== 'HEAD' ? c.req.raw.body : undefined,
      duplex: 'half',
    });
    return new Response(resp.body, { status: resp.status, headers: resp.headers });
  } catch {
    // narrative backend (wb-narrative standalone on :8900) is only started by
    // run.sh when wb-narrative/.env has GEMINI_API_KEY or LLM_PROXY_URL. Without
    // it the port is dead and this proxy fetch throws ECONNREFUSED — Hono would
    // surface that as a 500 and the viz/copilot poller (every 4s) floods the
    // console. Return a friendly 503 envelope instead so the iframe degrades
    // quietly to "no narrative history yet" rather than spamming red errors.
    return c.json(
      {
        success: false,
        error: 'narrative 服务未启动（需在 packages/marketplace/plugins/wb-narrative/.env 配置 GEMINI_API_KEY 或 LLM_PROXY_URL 后重启 app）',
        narrativeOffline: true,
      },
      503,
    );
  }
});

app.route('/api/files', createFilesRouter());
app.route('/api/assets', createAssetsRouter());
app.route('/api/workbench', createWorkbenchRouter());
app.route('/api/projects', createProjectsRouter());
app.route('/api/fs', createFsBrowserRouter());
app.route('/api/workspaces', createWorkspacesRouter({
  broadcast: (msg) => hub.broadcast(msg as Parameters<typeof hub.broadcast>[0]),
  rebindWatcher: WATCH_FS ? (root) => watcher.rebind(root) : undefined,
}));
app.route('/api/settings', createSettingsRouter());
app.route('/api/boot-splash', createBootSplashRouter());
app.route('/api/version', createVersionRouter());
app.route('/api/changelog', createChangelogRouter());
app.route('/api/sessions', createSessionsRouter());
app.route('/api/prefs', createPrefsRouter(projectRoot));
app.route('/api/logs', createLogsRouter(projectRoot));
app.route('/api/commands', createCommandsApiRouter());
app.route('/api/cli', createCliRouter());
app.route('/api/brand', createBrandRouter());
// /api/bus + /api/threads —— R2 把 src/bus 删掉了,但 interface 的
// Sidebar/AgentsPanel/BuildBadge/dashboard-api 都还在调,这里给个 stub
// 让 UI 在 R3 重写之前不至于 404 满屏。详见 api/bus.ts + api/threads.ts。
app.route('/api/bus', createBusRouter());
app.route('/api/plugins', createPluginsRouter());
app.route('/api/threads', createThreadsRouter());

// wb-character —— canonical 角色编辑器 API. 共享 @server-lib/character-forge
// handlers.ts SSOT (5 真实 pipeline + 7 stub),dispatchToSurface 钩子让
// iframe panel 在 generate 完成后自刷新。
// 2026-05-21 Phase 6: wb-character-forge plugin 已删除,此为唯一入口。
app.route('/api/wb/character', createCharacterRouter({
  projectRoot,
  env: process.env as Record<string, string | undefined>,
}));

// /api/wb/bgm —— residual host route for wb-bgm. The library/attach LOGIC moved
// to the marketplace plugin (Host ToolRegistry); this mount now only serves the
// generic /cos-proxy binary stream the SPA's <audio> preview + zip download use.
app.route('/api/wb/bgm', createBgmRouter());

// /api/llm/test — Model Lab one-shot completion endpoint (Stage E). Wraps
// lib/llm-gateway so SettingsPanel → Model Lab can fire prompts at any
// configured model with caller-tuned temperature/top_p/max_tokens.
app.route('/api/llm', createLlmTestRouter());
app.route('/api/usage', createUsageRouter());
app.route('/api/tools', createToolsRouter());
app.route('/api/events', createEventsRouter());
app.route('/api/skills', createSkillsRouter());
app.route('/api/packs', createPacksRouter());
app.route('/api/runtime', createRuntimeRouter());
app.route('/api/observatory', createObservatoryRouter());

// /__ce-api__/* —— wb-character iframe shim (Phase 3). The plugin submodule's
// 88 fetch sites still hit the legacy vite-dev plugin endpoints; this router
// terminates them on the studio host and forwards to lib/llm-gateway,
// lib/image-gateway (via ImageDispatcher), and FS persistence under
// <projectRoot>/.forgeax/wb-character/. Deferred endpoints (monster, video,
// MCP-backed pipelines) return success:false envelopes so the iframe shows
// a friendly toast instead of a network failure.
app.route('/__ce-api__', createCeApiShimRouter({
  projectRoot,
  env: process.env as Record<string, string | undefined>,
}));

// ──────────────────────────────────────────────────────────────────────────
// Interface SPA (single-origin form) — Tauri desktop / web-server prod.
//
// Dev keeps the two-origin split: interface vite (:18920) serves the SPA and
// proxies /api · /ws here (:18900). But for shipping ONE artifact — either a
// web-server you point a browser at, or a Tauri shell that loads a bun-compiled
// server sidecar — the server itself must serve the built SPA so that the
// app's relative `fetch('/api')` / `ws://…/ws` stay same-origin with zero
// frontend changes.
//
// Registered LAST (after every /api, /plugins, /__ce-api__ route) so it only
// catches unmatched paths. Guarded by dist existence + FORGEAX_SERVE_SPA so it
// is a complete no-op in the dev stack (no built dist → nothing mounted).
// Set FORGEAX_SERVE_SPA=0 to force-disable even when a dist is present.
const interfaceDist = resolveInterfaceDist();
const SERVE_SPA = process.env.FORGEAX_SERVE_SPA !== '0' && existsSync(interfaceDist);
if (SERVE_SPA) {
  // Backend/asset namespaces the SPA fallback must NEVER swallow. Without this
  // guard, an unmatched request under these prefixes (e.g. a plugin whose dist
  // isn't built yet, like /plugins/wb-reel/*) would fall through to the
  // index.html fallback below and load the *studio shell* inside the plugin
  // iframe — an infinite "booting shell…" loop. These must 404 instead so the
  // host can tell the plugin simply isn't available. Studio client routes live
  // at '/' (detached windows use a `?surface=` query, not a path), so excluding
  // these prefixes never affects the real SPA.
  //
  // NOTE: `/preview/*` (engine vite) is reverse-proxied at the Bun.serve layer
  // below (HTTP + HMR websocket) → the engine sidecar on FORGEAX_ENGINE_PORT;
  // it's included in RESERVED_PREFIX so this SPA fallback never swallows it
  // (which would return index.html for the preview iframe and recurse the whole
  // Studio SPA — Studio-in-Studio).
  const RESERVED_PREFIX = /^\/(api|plugins|__ce-api__|preview|ws)(\/|$)/;
  const staticAssets = serveStatic({ root: interfaceDist });
  const spaIndex = serveStatic({ path: 'index.html', root: interfaceDist });
  // Static assets (hashed JS/CSS, /brand/*, favicon, etc.).
  app.use('*', (c, next) => (RESERVED_PREFIX.test(c.req.path) ? next() : staticAssets(c, next)));
  // SPA fallback: any unmatched non-reserved GET returns index.html so the
  // client-side entry (incl. detached-window `?surface=…` URLs) boots.
  app.get('*', (c, next) => (RESERVED_PREFIX.test(c.req.path) ? next() : spaIndex(c, next)));
  console.log(`[forgeax-server] serving interface SPA from ${friendlyPath(interfaceDist)}`);
}

// wb-scene WS reverse-proxy —— editor (host:18900/plugins/wb-scene/) 走
// `ws://${host}/ws/{render,editor,log}` 上来；这里把它桥接到 wb-scene backend
// 9557。renderer (:9556) / assetstore (:9560) 自己的 vite dev server 已配
// /ws proxy，不经此处。
const WB_SCENE_WS_PATHS = new Set(['/ws/render', '/ws/editor', '/ws/log']);
const baseWsHandler = createWsHandler(hub);
const wsProxies = new WeakMap<import('bun').ServerWebSocket<WsClientData>, {
  upstream: WebSocket;
  pending: (string | ArrayBufferLike | Blob | ArrayBufferView)[];
}>();
const wsHandler: import('bun').WebSocketHandler<WsClientData> = {
  open(ws) {
    if (ws.data.proxy) {
      // Forward the client's WS subprotocol (vite HMR requires "vite-hmr";
      // without it vite's ws server rejects the upgrade → "closed before
      // established" reconnect spam + dead hot-reload).
      const upstream = ws.data.proxy.protocol
        ? new WebSocket(ws.data.proxy.url, ws.data.proxy.protocol)
        : new WebSocket(ws.data.proxy.url);
      const entry: { upstream: WebSocket; pending: any[] } = { upstream, pending: [] };
      wsProxies.set(ws, entry);
      upstream.binaryType = 'arraybuffer';
      upstream.onopen = () => {
        for (const m of entry.pending) upstream.send(m);
        entry.pending = [];
      };
      upstream.onmessage = (e) => {
        try { ws.send(e.data as any); } catch { /* client gone */ }
      };
      upstream.onclose = () => { try { ws.close(); } catch { /* ignore */ } };
      upstream.onerror = (e) => {
        console.error('[ws-proxy] upstream error:', (e as ErrorEvent).message ?? e);
        try { ws.close(1011, 'upstream error'); } catch { /* ignore */ }
      };
      return;
    }
    return baseWsHandler.open?.(ws);
  },
  message(ws, message) {
    const entry = wsProxies.get(ws);
    if (entry) {
      if (entry.upstream.readyState === WebSocket.OPEN) {
        entry.upstream.send(message as any);
      } else {
        entry.pending.push(message as any);
      }
      return;
    }
    return baseWsHandler.message?.(ws, message);
  },
  close(ws, code, reason) {
    const entry = wsProxies.get(ws);
    if (entry) {
      try { entry.upstream.close(); } catch { /* ignore */ }
      wsProxies.delete(ws);
      return;
    }
    return baseWsHandler.close?.(ws, code, reason);
  },
};

let server: ReturnType<typeof Bun.serve>;
try {
  server = Bun.serve({
  port: PORT,
  hostname: HOST,
  // SSE / long-running streams will exceed Bun's 10s default. 0 = no idle
  // timeout — safe because we cancel via AbortSignal on client disconnect.
  idleTimeout: 0,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      const sid = url.searchParams.get('sid') ?? undefined;
      const data: WsClientData = { id: crypto.randomUUID(), sid };
      const upgraded = srv.upgrade(req, { data });
      if (upgraded) return undefined;
      return new Response('upgrade required', { status: 426 });
    }
    if (WB_SCENE_WS_PATHS.has(url.pathname)) {
      const port = process.env.WB_SCENE_API_PORT ?? '9557';
      const upstreamUrl = `ws://127.0.0.1:${port}${url.pathname}${url.search}`;
      const data: WsClientData = { id: crypto.randomUUID(), proxy: { url: upstreamUrl } };
      const upgraded = srv.upgrade(req, { data });
      if (upgraded) return undefined;
      return new Response('upgrade required', { status: 426 });
    }
    // Engine preview reverse-proxy (single-origin desktop / Plan B). The preview
    // iframe loads `/preview/?game=<slug>`; in dev the interface vite server
    // proxies /preview → engine vite (:15173). With one origin (the .app) we do
    // the same here so the engine vite sidecar serves & live-transforms game TS.
    // Both the HMR websocket (base-prefixed `/preview/` per __HMR_BASE__) and
    // plain HTTP are forwarded. No engine sidecar → 502 (preview just won't load;
    // the rest of the app is unaffected).
    if (url.pathname === '/preview' || url.pathname.startsWith('/preview/')) {
      const enginePort = process.env.FORGEAX_ENGINE_PORT ?? '15173';
      if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        const upstreamUrl = `ws://127.0.0.1:${enginePort}${url.pathname}${url.search}`;
        // vite HMR client connects with the "vite-hmr" subprotocol; carry it to
        // the upstream and echo it back so both handshakes agree.
        const proto = req.headers.get('sec-websocket-protocol')?.split(',')[0]?.trim();
        const data: WsClientData = { id: crypto.randomUUID(), proxy: { url: upstreamUrl, protocol: proto } };
        const upgraded = srv.upgrade(req, {
          data,
          headers: proto ? { 'sec-websocket-protocol': proto } : undefined,
        });
        if (upgraded) return undefined;
        return new Response('upgrade required', { status: 426 });
      }
      const headers = new Headers(req.headers);
      headers.set('host', `127.0.0.1:${enginePort}`); // changeOrigin — vite emits correct URLs
      const target = `http://127.0.0.1:${enginePort}${url.pathname}${url.search}`;
      return fetch(target, {
        method: req.method,
        headers,
        body: req.body,
        redirect: 'manual',
        // Bun streams the request body with duplex:'half'.
        duplex: 'half',
      }).catch(
        (e) => new Response(`engine preview unavailable: ${e}`, { status: 502 }),
      );
    }
    return app.fetch(req);
  },
  websocket: wsHandler,
  });
} catch (e) {
  // EADDRINUSE etc. happen during startup — this is genuinely fatal. Surface a
  // friendly message (the bare Bun error is cryptic) and exit 1 so run.sh can
  // tell the difference between "already running / port busy" and a clean exit.
  const msg = (e as Error)?.message ?? String(e);
  const isInUse = /EADDRINUSE|address already in use|in use/i.test(msg);
  process.stderr.write(
    isInUse
      ? `[forgeax-server] FATAL: port ${PORT} already in use — another server instance is running. ${msg}\n`
      : `[forgeax-server] FATAL: could not start HTTP server on ${HOST}:${PORT} — ${msg}\n`,
  );
  process.exit(1);
}

if (WATCH_FS) {
  watcher.start(projectRoot);
  watcher.on((ev) => hub.broadcast(ev));
}

// The HTTP server is bound and listening. From here on, the FaultBoundary
// switches from "startup-fatal → exit" to "runtime-recoverable → log + keep
// serving". Anything that throws before this point is a real boot failure.
serverReady = true;

console.log(`[forgeax-server] listening on http://${server.hostname}:${server.port}`);
console.log(`[forgeax-server] websocket on ws://${server.hostname}:${server.port}/ws`);

// Child-process reaper (perf-analysis-2 server P0-1, 维度 1). On exit the
// server MUST kill every child it spawned, or they accumulate as orphans —
// the physical root cause of stray vite / EADDRINUSE / black-screen between
// restarts. Long-lived children owned by this process:
//   • bash shell pool — TerminalManager.sessions (cleanup(0) SIGTERMs each)
//   • cli-providers — each provider.shutdown() tears down any app-server /
//     long-lived state it holds (claude/cursor are per-turn no-ops today;
//     codex's shared app-server gets killed here if alive).
// Per-turn transient spawns (claude/codex/cursor CLI turns, zip/unzip,
// --version probes) are bounded by their own AbortSignal/exit and are not an
// orphan source at shutdown, so they are deliberately not enumerated here.
let shuttingDown = false;

const reapChildren = async (): Promise<void> => {
  // 1. cli-providers teardown (these were implemented but NEVER called before).
  for (const p of listProviders()) {
    try {
      const r = p.shutdown?.();
      if (r && typeof (r as Promise<void>).then === 'function') {
        await Promise.race([r, new Promise((res) => setTimeout(res, 3000))]);
      }
    } catch (e) {
      logFatal('provider-shutdown', e);
    }
  }
  // 2. bash shell pool — cleanup(0) SIGTERMs every pooled shell + clears maps.
  try { getTerminalManager().cleanup(0); } catch (e) { logFatal('terminal-cleanup', e); }
};

const shutdown = async (sig: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[forgeax-server] received ${sig}, stopping...`);
  // Stop accepting new connections first so nothing new spawns mid-teardown.
  try { server?.stop(); } catch { /* server may not have started */ }
  await watcher.stop();
  // 等价 ref `Instance.shutdown` → `Scheduler.destroyRuntime` —— close 全部
  // live session（per-Session logger 各自 close）+ detach console bridge +
  // close SM 单例 logger，确保 `<userRoot>/debug.log` 尾部 buffer 落盘。
  try { await getSessionManager().shutdown(); } catch { /* SM 可能未 init */ }
  // Reap every spawned child so none survive as an orphan.
  await reapChildren();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// Last-resort sync backstop: if the process is exiting through any path that
// didn't run the async shutdown above (e.g. uncaughtException during startup,
// explicit process.exit elsewhere), still SIGTERM the bash pool synchronously
// so we never leak the shells. cleanup(0) is sync + idempotent.
process.on('exit', () => {
  try { getTerminalManager().cleanup(0); } catch { /* best-effort */ }
});
