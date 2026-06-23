// @desc Command module: character-forge —— 角色锻造 plugin 的 UI/CLI 入口
//
// 与 builtin/kits/character-forge/tools/*.ts 是**平行**路径而**不**是 wrapper：
// 两侧都直接 import `@server-lib/character-forge` 的 handlers，agent 调
// 走 kit tool，前端 / CLI / cron 调走 commands transport。共享同一份业务实现
// + 同一个 character-forge.* 事件名 —— ledger 与 ws 上看到的事件，不论谁触发的
// 都是同一种 shape。
//
// emit 桥：args[0] 给定的 sid 命中 live session 时，事件 hook 到该 session 的
// eventBus（hook = observer-only，**不**落 ledger，但 ws.observe 会接住 → 前端
// 立刻看到"画完了"）。args[0] 缺省或 session 已 dispose → emit 退化为 noop，
// 命令仍返回 JSON 结果给 caller，差别只是没有"实时进度推流"。
//
// 命令清单（positional args；JSON 结构走 args[N]=JSON.stringify(obj) 约定）：
//   forge_status                args[0]?=sid                                 hasQuery
//                               ↳ 返回 dispatcher.isReady() + style 枚举
//   forge_list_characters       args[0]=sid, args[1]=slug                    hasQuery
//   forge_get_character         args[0]=sid, args[1]=slug, args[2]=charId    hasQuery
//   forge_generate_portrait     args[0]=sid, args[1]=JSON(GeneratePortraitArgs) hasExecute
//   forge_generate_sprite_sheet args[0]=sid, args[1]=JSON(GenerateSpriteSheetArgs) hasExecute
//   forge_rename_character      args[0]=sid, args[1]=slug, args[2]=charId, args[3]=name hasExecute

import type { CommandModule } from "../../src/commands/types";
import { defaultProjectRoot } from "../../src/api/lib/safe-path";
import {
  generatePortrait,
  generateSpriteSheet,
  getCharacter,
  getStatus,
  listCharacters,
  renameCharacter,
} from "@server-lib/character-forge";
import type {
  GeneratePortraitArgs,
  GenerateSpriteSheetArgs,
} from "@server-lib/character-forge/types";
import type { SessionManager } from "../../src/core/session-manager";

/** 构造 HandlerCtx —— sid 可选；命中 live session 时 emit 桥到 eventBus.hook。 */
async function buildHandlerCtx(
  sm: SessionManager,
  sid: string | undefined,
): Promise<{
  projectRoot: string;
  env: Record<string, string | undefined>;
  emit: (name: string, payload: Record<string, unknown>) => void;
}> {
  let emit: (name: string, payload: Record<string, unknown>) => void = () => { /* noop */ };
  if (sid && sid.trim()) {
    try {
      const session = await sm.open(sid.trim());
      // raw EventBus.publish —— observer-only（无 `to`），不入任何 agent queue / ledger，
      // 但 ws.observe 会收到 → 前端实时刷新。与 kit-tool 路径走的 `eventBus.hook()` 在
      // 网线上看到的形状一致（source / type / payload / ts），只是 source 由 caller 显式给。
      emit = (type, payload) => {
        session.eventBus.publish({
          source: "character-forge",
          type,
          payload,
          ts: Date.now(),
        });
      };
    } catch {
      // session 不存在 / 已 dispose —— 命令仍可跑，只是没有 ws 实时回灌
    }
  }
  return {
    projectRoot: defaultProjectRoot(),
    env: process.env,
    emit,
  };
}

function parseJsonArg<T>(name: string, raw: string | undefined, label: string): T {
  if (!raw) throw new Error(`${name}: ${label} required`);
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`${name}: ${label} must be valid JSON — ${(err as Error).message}`);
  }
}

const characterForge: CommandModule = {
  async list() {
    return [
      {
        name: "forge_status",
        description:
          "character-forge 健康检查：返回 vendor key readiness + 可用 style 枚举（args[0]?=sid，仅用于 emit；不传也能查）",
        hasQuery: true,
        hasExecute: false,
      },
      {
        name: "forge_list_characters",
        description: "列出 game slug 下的角色清单（args[0]=sid, args[1]=slug）",
        hasQuery: true,
        hasExecute: false,
      },
      {
        name: "forge_get_character",
        description: "读单角色 manifest + asset urls（args[0]=sid, args[1]=slug, args[2]=charId）",
        hasQuery: true,
        hasExecute: false,
      },
      {
        name: "forge_generate_portrait",
        description:
          "生成立绘 / 三视图（args[0]=sid, args[1]=JSON.stringify(GeneratePortraitArgs)）。" +
          "args 同 kit tool generate-portrait —— { slug, prompt, style?, views?, name?, charId?, model?, size?, refImageBase64? }",
        hasQuery: false,
        hasExecute: true,
      },
      {
        name: "forge_generate_sprite_sheet",
        description:
          "为已存在 charId 生成行动小人 sheet（args[0]=sid, args[1]=JSON.stringify(GenerateSpriteSheetArgs)）。" +
          "args 同 kit tool generate-sprite-sheet —— { slug, charId, action?, directions?, framesPerDir?, frameSize?, model? }",
        hasQuery: false,
        hasExecute: true,
      },
      {
        name: "forge_rename_character",
        description:
          "重命名角色（args[0]=sid, args[1]=slug, args[2]=charId, args[3]=name 1-80 字符）",
        hasQuery: false,
        hasExecute: true,
      },
    ];
  },

  async query(name, args, ctx) {
    if (name === "forge_status") {
      const handlerCtx = await buildHandlerCtx(ctx.sm, args[0]);
      return getStatus(handlerCtx);
    }

    if (name === "forge_list_characters") {
      const sid = (args[0] ?? "").trim();
      const slug = (args[1] ?? "").trim();
      if (!sid) throw new Error(`${name}: args[0] (sid) required`);
      if (!slug) throw new Error(`${name}: args[1] (slug) required`);
      const handlerCtx = await buildHandlerCtx(ctx.sm, sid);
      return listCharacters(handlerCtx, slug);
    }

    if (name === "forge_get_character") {
      const sid = (args[0] ?? "").trim();
      const slug = (args[1] ?? "").trim();
      const charId = (args[2] ?? "").trim();
      if (!sid) throw new Error(`${name}: args[0] (sid) required`);
      if (!slug) throw new Error(`${name}: args[1] (slug) required`);
      if (!charId) throw new Error(`${name}: args[2] (charId) required`);
      const handlerCtx = await buildHandlerCtx(ctx.sm, sid);
      return getCharacter(handlerCtx, slug, charId);
    }

    throw new Error(`No query for: ${name}`);
  },

  async execute(name, args, ctx) {
    if (name === "forge_generate_portrait") {
      const sid = (args[0] ?? "").trim();
      if (!sid) throw new Error(`${name}: args[0] (sid) required`);
      const body = parseJsonArg<GeneratePortraitArgs>(name, args[1], "args[1] (GeneratePortraitArgs JSON)");
      const handlerCtx = await buildHandlerCtx(ctx.sm, sid);
      return generatePortrait(handlerCtx, body);
    }

    if (name === "forge_generate_sprite_sheet") {
      const sid = (args[0] ?? "").trim();
      if (!sid) throw new Error(`${name}: args[0] (sid) required`);
      const body = parseJsonArg<GenerateSpriteSheetArgs>(
        name,
        args[1],
        "args[1] (GenerateSpriteSheetArgs JSON)",
      );
      const handlerCtx = await buildHandlerCtx(ctx.sm, sid);
      return generateSpriteSheet(handlerCtx, body);
    }

    if (name === "forge_rename_character") {
      const sid = (args[0] ?? "").trim();
      const slug = (args[1] ?? "").trim();
      const charId = (args[2] ?? "").trim();
      const newName = (args[3] ?? "").trim();
      if (!sid) throw new Error(`${name}: args[0] (sid) required`);
      if (!slug) throw new Error(`${name}: args[1] (slug) required`);
      if (!charId) throw new Error(`${name}: args[2] (charId) required`);
      if (!newName) throw new Error(`${name}: args[3] (name) required`);
      const handlerCtx = await buildHandlerCtx(ctx.sm, sid);
      return renameCharacter(handlerCtx, slug, charId, newName);
    }

    throw new Error(`No execute for: ${name}`);
  },
};

export default characterForge;
