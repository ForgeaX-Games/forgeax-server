/** gameHostTools — the studio shell's game-domain host tools, injected into the
 *  orchestration layer via the `HostToolSpec` seam (Stage A §3 / P1-7 落地:
 *  `list_games` / `query_world` / `capture_frame` 从 cli 硬编码迁到这里,cli 层回
 *  纯通用)。
 *
 *  执行形态:两个 host 工具执行口(host-tool-bridge / `:sid/kernel-tool`)在信任闸
 *  放行后调用 `run(args, ctx)`。感知类工具经 `ctx.perception`(编排层通用感知往返:
 *  EventBus→WS→interface→preview iframe→回灌)取真值——机制业务无关归 cli,
 *  「感知的是游戏世界」这层语义归本文件。UI 未连 fail-soft 返回 `{ unavailable }`。
 *
 *  注:租用内核(外部 CLI 内核)路径的这三个工具仍由 cli 的
 *  `kernel/mcp/forgeax-tools-server.mjs` 本地镜像执行(历史双镜像债,收敛是独立
 *  follow-up);本 seam 覆盖 forgeax-core 原生路径。
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { HostToolSpec, HostToolRunCtx } from 'forgeax-cli/orchestration-seams';

/** 列出工作区里的游戏(`.forgeax/games/` + 兼容旧 `games/`),过滤 _template / 隐藏。 */
function listGames(projectRoot: string): { count: number; games: string[] } {
  const out: string[] = [];
  for (const base of [join(projectRoot, '.forgeax/games'), join(projectRoot, 'games')]) {
    if (!existsSync(base)) continue;
    try {
      for (const e of readdirSync(base, { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.')) out.push(e.name);
      }
    } catch {
      /* unreadable dir → skip */
    }
  }
  const games = [...new Set(out)];
  return { count: games.length, games };
}

export function gameHostTools(): HostToolSpec[] {
  return [
    {
      name: 'list_games',
      description: 'List the game projects in this forgeax workspace. Returns { count, games }.',
      inputSchema: { type: 'object', properties: {} },
      run: (_args, ctx: HostToolRunCtx) => listGames(ctx.projectRoot),
    },
    {
      // 感知接地(R5/M8):向运行中的游戏取真值。仅取数,裁判是模型 + 结构/不变量,引擎不当裁判。
      name: 'query_world',
      description:
        "Query the RUNNING game's live world for ground truth: a structural ECS snapshot { entityCount, archetypes:[{componentNames, entityCount}], activeComponents, systems, resourceKeys }. Use it to VERIFY what the game actually contains/does (after writing code) instead of guessing. Data only — you are the judge.",
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      run: async (args, ctx: HostToolRunCtx) =>
        ctx.perception ? ctx.perception('world', args?.query) : { unavailable: true, reason: 'no perception channel' },
    },
    {
      name: 'capture_frame',
      description:
        "Capture the running game preview's current rendered frame as a PNG data URL (best-effort; may be blank on some GPUs — judge by structure/invariants, not pixels). Returns { dataUrl, bytes }.",
      inputSchema: { type: 'object', properties: {} },
      run: async (_args, ctx: HostToolRunCtx) => {
        if (!ctx.perception) return { unavailable: true, reason: 'no perception channel' };
        const snap = await ctx.perception('frame');
        const dataUrl =
          snap && typeof snap === 'object' && typeof (snap as { dataUrl?: unknown }).dataUrl === 'string'
            ? (snap as { dataUrl: string }).dataUrl
            : '';
        if (!dataUrl) {
          const reason = snap && typeof snap === 'object' ? (snap as { reason?: unknown }).reason : undefined;
          return { unavailable: true, reason: reason ?? 'no frame' };
        }
        return { bytes: dataUrl.length, dataUrl: `${dataUrl.slice(0, 64)}…` };
      },
    },
  ];
}
