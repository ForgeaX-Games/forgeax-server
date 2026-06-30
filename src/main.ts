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

import { serveStatic } from 'hono/bun';
// 产品壳:初始化编排层(forgeax-cli)并注入产品相关内容,自己只负责进程/服务/代理。
import { createForgeaxApp } from 'forgeax-cli';
import { getVersion } from '@forgeax/platform-io';
import { loadBrand } from 'forgeax-cli/brand';
import { defaultProjectRoot } from '@forgeax/platform-io';
import { friendlyPath } from '@forgeax/platform-io';
import { mp, interfaceDist as resolveInterfaceDist } from '@forgeax/platform-io';
import { FsWatcher } from 'forgeax-cli/api/lib/watcher';
import { WsHub, createWsHandler, type WsClientData } from 'forgeax-cli/ws';
import { getSessionManager } from 'forgeax-cli/core/session-manager';
import { getActiveGame } from './game/active-game';
import { GameSessionLayout } from './studio-session-layout';
// 游戏业务路由(阶段A:从 forgeax-cli 搬入产品壳)—— 经 ctx.routers 注入编排层。
import { createWorkbenchRouter } from './game/workbench';
import { createCharacterRouter } from './game/wb-character';
import { createBgmRouter } from './game/wb-bgm';
import { createCeApiShimRouter } from './game/ce-api-shim';
import { GameSystemPromptComposer } from './game/system-prompt-composer';
// 产品壳装配原生内核(DIP):编排层不依赖具体内核,这里把 forgeax-core 注册进共享 registry。
import { registerForgeaxCoreKernel } from './kernel/forgeax-core-adapter';
import { createTelemetryFileSink } from './kernel/telemetry-file-sink';
import { setHostTelemetry } from 'forgeax-cli/kernel/host-telemetry';
import type { TelemetryRecord } from '@forgeax/types';
// 业务能力注入(DIP):marketplace UI 资产清洗由产品壳提供,编排层不直接依赖 marketplace。
import {
  inspectUiAssetCanvas,
  normalizeStandaloneUiAsset,
} from '../../marketplace/plugins/wb-ui/src/pipelines/ui-design/ui-asset-cleanup';

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
// Guards the shutdown handler against double-entry (SIGINT then SIGTERM, etc.).
let shuttingDown = false;

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

const hub = new WsHub();
const watcher = new FsWatcher();
const projectRoot = defaultProjectRoot();

// 全链路 trace 落盘 sink(项目本地 .forgeax/sessions/<sid>/logs/)——后端 adapter 与
// 浏览器 span 上传路由 `/api/telemetry` 共用同一实例,后端 + 浏览器 span 同落一处、拼一棵树。
// 方案B PR1 D1:不再各算各的 projectSessionLogsDir,省略 resolveLogsDir → sink 默认走
// getPathManager().session(sid).logsDir(),即下方注入的 SessionLayout(studio=项目本地)。
// 于是 trace/log 与 session WAL 由**同一个** PathManager/layout 决定路径 → split-brain 收口。
const telemetrySink = createTelemetryFileSink({
  onError: (err) => process.stderr.write(`[telemetry-sink] ${String(err)}\n`),
});

// observability v3 / B 档 · 第 2 层:把同一份 sink + 广播注入 host-telemetry 单例,使 **CLI 内核**
//   (codebuddy/claude-code/codex/cursor,跑在本进程、不经 sidecar 回流)产的 kernel.turn span/log
//   也落项目本地 <sid>/logs/ + 广播给浏览器 viewer,与 forgeax-core/浏览器 span 同 trace。无条件接
//   (即便默认内核是 forgeax-core,用户仍可经 providerOverride 选 CLI 内核)。
setHostTelemetry((sid, records) => {
  telemetrySink.write(sid, records);
  hub.broadcast({ type: 'telemetry', records } as Parameters<typeof hub.broadcast>[0]);
});

// 内环切换:产品壳**默认走原生内核 forgeax-core**(DIP——编排层 cli 不依赖具体内核,这里把
// forgeax-core 注册进共享 registry;claude-code/codex 仍由 cli 自带注册)。逃生闸:显式
// FORGEAX_KERNEL_IMPL=claude-code(或 codex)回租用内核。必须在任何 chat 之前完成。
//
// R3 内核归一:注册的是**连接式** adapter —— forgeax-core 经 sidecar spawn 成
// `--serve` 子进程(与 claude-code/codex 同级),**不再 in-process**(in-process 路径已删,
// 不留逃生)。详见 forgeax-core-adapter.ts。
if (!process.env.FORGEAX_KERNEL_IMPL?.trim()) {
  process.env.FORGEAX_KERNEL_IMPL = 'forgeax-core';
}
if (process.env.FORGEAX_KERNEL_IMPL.trim() === 'forgeax-core') {
  // observability v3 / B 档:把 hub.broadcast 注入 adapter,让 forgeax-core serve 经
  // RPC `telemetry` 推回的 span/log 既落盘(<sid>/logs/{trace,log}.jsonl)又广播给
  // 浏览器 viewer(WS `{ type:'telemetry', records }`)。
  registerForgeaxCoreKernel({
    broadcast: (msg) => hub.broadcast(msg as Parameters<typeof hub.broadcast>[0]),
    telemetrySink,
  });
  // 冷启动消除:server boot 即预热 agent-host(fire-and-forget),让首轮 chat 命中"已存在实例"
  // 的快路径,而非在首轮里现 `Bun.spawn`——后者在 Windows 上冷启可能超过 ensureSidecar 的 spawn
  // 窗口,误报 "sidecar (agent-host) not reachable after spawn"。kernel-only 路径(下方)已会
  // 自行预热并擦 key,这里只覆盖默认(非 kernel-only)路径;预热失败不阻塞 boot(首轮仍会自行
  // spawn + 重试)。
  if (process.env.FORGEAX_KERNEL_ONLY !== '1') {
    void (async (): Promise<void> => {
      const { sidecarEnabled } = await import('forgeax-cli/kernel/kernel-mode');
      if (!sidecarEnabled()) return;
      const { ensureSidecar } = await import('forgeax-cli/kernel/sidecar-singleton');
      await ensureSidecar();
    })().catch(() => { /* 预热失败不阻塞 boot;首轮 chat 会自行 spawn+重试 */ });
  }
}

// 初始化编排层 + 注入产品上下文。createForgeaxApp(forgeax-cli)负责 boot(path /
// session / plugins / cli-providers / brand)并挂载全部 /api 路由,返回已就绪的 Hono
// app。产品壳(本文件)只在其上叠加:静态资源(SPA / 插件 dist)、引擎/界面反向代理、
// WS、Bun.serve、文件 watcher。这是"产品层初始化并注入编排层"的落点;换产品 = 换这层注入。
const shimEnv = process.env as Record<string, string | undefined>;
const { app } = await createForgeaxApp({
  projectRoot,
  version: VERSION,
  broadcast: (msg) => hub.broadcast(msg as Parameters<typeof hub.broadcast>[0]),
  rebindWatcher: WATCH_FS ? (root) => watcher.rebind(root) : undefined,
  // system-prompt charter/environment/note 由产品壳提供(阶段A §3.2)——编排层经
  // 注入的 composer 取,cli 自身不再硬编码游戏宪章。ports 取自 env(与原 cli 顶层常量一致)。
  systemPromptComposer: new GameSystemPromptComposer({
    serverPort: process.env.FORGEAX_SERVER_PORT ?? '18900',
    interfacePort: process.env.FORGEAX_INTERFACE_PORT ?? '18920',
  }),
  // 游戏业务路由由产品壳注入(阶段A:原 cli 静态 mount 搬到此)。路由表逐条不变。
  routers: [
    { path: '/api/workbench', router: createWorkbenchRouter() },
    { path: '/api/wb/character', router: createCharacterRouter({ projectRoot, env: shimEnv }) },
    { path: '/api/wb/bgm', router: createBgmRouter() },
    {
      path: '/__ce-api__',
      router: createCeApiShimRouter({
        projectRoot,
        env: shimEnv,
        // marketplace UI 资产清洗能力直接交给业务 router(不再经 cli ProductContext 中转)。
        uiAssetCleanup: { inspectUiAssetCanvas, normalizeStandaloneUiAsset },
      }),
    },
  ],
  // 方案B PR2:session 状态树落**绑定 game 下** <projectRoot>/.forgeax/games/<slug>/sessions/<sid>/
  //   ——新建时绑当前 active game(永久绑定,路径即 SSOT,无 defaultDir)。WAL 的 logsDir() 与
  //   telemetrySink(回落同一 PathManager 路径)同落该 game 的 <sid>/logs/ → trace/log 与 WAL
  //   同源同根,且整份记录随 game 目录可迁移/上传(#033)。slug→sid 缓存,切 game 不动既有 session。
  // **工厂**(而非单实例):切 workspace/项目根时 workspaces 路由用新 root 重建 layout 再
  //   initPathManager,否则会退回默认扁平布局、扫不到 games/<slug>/sessions/ → 列会话/查历史失灵。
  //   内层闭包带可选 root(配合 SessionLayout.resolveScope(sessionId?, root?) —— workspaces 激活
  //   时用 abs 查该工作区的 active game);无参时回落工厂 root。
  sessionLayoutFactory: (root) => new GameSessionLayout(root, (r) => getActiveGame(r ?? root)),
});

app.get('/api/health', (c) =>
  c.json({
    status: 'ok',
    version: VERSION,
    name: '@forgeax/server',
    pid: process.pid,
    uptime: process.uptime(),
    projectRoot: friendlyPath(projectRoot),
    wsClients: hub.size(),
  }),
);

// 全链路 trace:浏览器产的 span(ui.send/ui.request/ui.stream/ui.render、app.boot.*)经此
// 上传 → 与后端 span 同落项目本地 .forgeax/sessions/<sid>/logs/(同 traceId 拼一棵树)+ 广播给
// 其它 viewer。best-effort,绝不抛回客户端。records 按 sid 分组写(一批可能跨 sid)。
app.post('/api/telemetry', async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { records?: unknown };
    const records = Array.isArray(body.records) ? (body.records as TelemetryRecord[]) : [];
    const valid = records.filter(
      (r): r is TelemetryRecord => !!r && typeof r === 'object' && ((r as { kind?: unknown }).kind === 'span' || (r as { kind?: unknown }).kind === 'log'),
    );
    if (valid.length === 0) return c.json({ ok: true, written: 0 });
    const bySid = new Map<string, TelemetryRecord[]>();
    for (const r of valid) {
      const sid = (r as { sid?: string }).sid ?? 'browser';
      (bySid.get(sid) ?? bySid.set(sid, []).get(sid)!).push(r);
    }
    for (const [sid, group] of bySid) telemetrySink.write(sid, group);
    hub.broadcast({ type: 'telemetry', records: valid } as Parameters<typeof hub.broadcast>[0]);
    return c.json({ ok: true, written: valid.length });
  } catch (err) {
    process.stderr.write(`[api/telemetry] ${String(err)}\n`);
    return c.json({ ok: false }, 200); // 诊断不反噬:即便出错也回 200,不让浏览器报错
  }
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

// wb-gen3d scratch (transfer) artifacts — pose-standardized images, etc. The
// plugin's per-game store writes these to
// `.forgeax/games/<slug>/.gen3d/tmp/<sha>.<ext>` and persists localUrl as
// `/api/gen3d-scratch/<slug>/<sha>.<ext>`. NOT assets: no manifest, no delete UI.
const GEN3D_SCRATCH_RE = /^\/api\/gen3d-scratch\/([^/]+)\/([^/]+)$/;
app.get('/api/gen3d-scratch/:slug/*', async (c) => {
  const m = GEN3D_SCRATCH_RE.exec(c.req.path);
  if (!m) return c.text('not found', 404);
  let slug: string;
  let fileName: string;
  try {
    slug = decodeURIComponent(m[1]!);
    fileName = decodeURIComponent(m[2]!);
  } catch {
    return c.text('bad path', 400);
  }
  if (!SAFE_SLUG_RE.test(slug) || slug === '..') return c.text('bad slug', 400);
  if (fileName.includes('\0') || fileName.includes('/') || fileName.includes('..')) {
    return c.text('bad path', 400);
  }
  const scratchDir = resolve(gamesRoot, slug, '.gen3d', 'tmp');
  const abs = resolve(scratchDir, fileName);
  if (abs !== scratchDir && !abs.startsWith(scratchDir + '/')) return c.text('forbidden', 403);
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

// wb-bgm — Music & BGM workbench plugin (audio/SFX library SPA). Audio LOGIC
// lives in the marketplace plugin (registry tools) + the orchestration ce-api
// gateway (/reel-tts, /reel-music); this just serves the vendored SPA. Restored
// in Phase 2d alongside the audio-gateway port.
const wbBgmDist = mp('wb-bgm', 'dist');
app.use('/plugins/wb-bgm/*', serveStatic({
  root: wbBgmDist,
  rewriteRequestPath: (p) => {
    const rest = p.replace(/^\/plugins\/wb-bgm/, '') || '/';
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

// wb-ai-asset — Meshy AI lowpoly prop generator (same embedded pattern as wb-gen3d).
const wbAiAssetDist = mp('wb-ai-asset', 'dist');
app.use('/plugins/wb-ai-asset/*', serveStatic({
  root: wbAiAssetDist,
  rewriteRequestPath: (p) => {
    const rest = p.replace(/^\/plugins\/wb-ai-asset/, '') || '/';
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

// 注:全部 /api/* + /__ce-api__ 路由由 createForgeaxApp(编排层)挂载(见上)。
// 产品壳只追加下面的静态资源 / 代理 / SPA fallback。

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

// R3-15:存在 user-imported soul-pack 但内核/sidecar 被关(逃生回旧路径)→ loud warn
// (不可信 pack 缺凭据保险箱/进程监督)。内核+sidecar 现默认开,仅当被显式关掉才告警。
try {
  const importedDir = `${process.env.FORGEAX_PROJECT_ROOT ?? process.cwd()}/.forgeax/souls-imported`;
  const { existsSync, readdirSync } = await import('node:fs');
  const { kernelEnabled, sidecarEnabled } = await import('forgeax-cli/kernel/kernel-mode');
  const guarded = kernelEnabled() && sidecarEnabled();
  if (!guarded && existsSync(importedDir) && readdirSync(importedDir).length > 0) {
    console.warn('[forgeax-server] ⚠️  user-imported soul-pack 存在但内核/sidecar 被关 —— 不可信 pack 缺凭据保险箱/进程监督。移除 FORGEAX_KERNEL=cli / FORGEAX_SIDECAR=off / .forgeax/use-cli 以恢复保护。');
  }
} catch { /* ignore */ }

// R3-02 / ship-gate 闸#3:**kernel-only 模式**(FORGEAX_KERNEL_ONLY=1)下,把真模型 key 交给 sidecar
// 后从 **server 进程 env 擦除** —— 真 key 连 server 都不持(防 server 被攻破泄密)。默认关:旧 in-process
// 路径(auto-resolver / claude-code provider)+ 设置页仍需 key,故仅在显式 kernel-only(内核为唯一对话
// 路径)时才擦。擦前先确保 sidecar 起来且拿到 key;sidecar 起不来则**不擦**(否则无可用路径)。
if (process.env.FORGEAX_KERNEL_ONLY === '1') {
  try {
    const { kernelEnabled, sidecarEnabled } = await import('forgeax-cli/kernel/kernel-mode');
    if (!kernelEnabled() || !sidecarEnabled()) {
      console.warn('[forgeax-server] FORGEAX_KERNEL_ONLY=1 但内核/sidecar 未启用 —— 跳过擦 key(否则无可用模型路径)。');
    } else {
      const { ensureSidecar } = await import('forgeax-cli/kernel/sidecar-singleton');
      await ensureSidecar(); // boot 即起 sidecar,真 key 随 spawn env 交给它(cred-vault 持有)
      const before = Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      console.log(`[forgeax-server] 🔒 kernel-only:真模型 key 已交 sidecar 并从 server env 擦除(was present=${before})。子进程经 cred-vault scoped token,server 不再持真 key(R3-02)。`);
    }
  } catch (e) {
    console.warn(`[forgeax-server] kernel-only 擦 key 跳过(sidecar 起不来:${(e as Error).message})—— 保留 key 以免无可用路径。`);
  }
}

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
  // Spawned children (incl. the agent-host sidecar) are supervised by the
  // sidecar/forgeax-cli runtime now, not by the thin server shell — they tear
  // themselves down on the SM shutdown above / their own exit handlers.
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
