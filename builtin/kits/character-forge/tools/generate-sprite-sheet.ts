/** generate-sprite-sheet —— 为已有 charId 生成行动小人 sprite sheet。
 *
 *  必须先跑过 generate-portrait（拿到 front 立绘做 reference）。同样的 handler
 *  也被 commands/character-forge.ts::generate_sprite_sheet 复用。 */

import type { ToolDefinition } from "../../../../src/core/types";
import { defaultProjectRoot } from "../../../../src/api/lib/safe-path";
import {
  ForgeError,
  generateSpriteSheet,
} from "@server-lib/character-forge";
import type { GenerateSpriteSheetArgs } from "@server-lib/character-forge/types";

const tool: ToolDefinition = {
  name: "generate-sprite-sheet",
  description:
    "为已存在的角色生成行动小人 sprite sheet（4 方向 × N 帧）。立绘 front 自动当 reference 保持角色一致。" +
    "落盘到 <projectRoot>/.forgeax/games/<slug>/characters/<charId>/sprites/<action>/sheet.<ext>。",
  input_schema: {
    type: "object",
    properties: {
      slug: { type: "string", description: "game-project slug" },
      charId: { type: "string", description: "目标角色 id（必须已存在 manifest.json）" },
      action: { type: "string", enum: ["walk", "idle", "attack"], description: "缺省 walk" },
      directions: {
        type: "array",
        description: "缺省 4 方向 down/left/right/up",
        items: { type: "string", enum: ["down", "left", "right", "up"] },
      },
      framesPerDir: { type: "number", description: "每方向帧数 2-8，缺省 4" },
      frameSize: { type: "number", enum: [64, 96, 128] },
      model: { type: "string", enum: ["nano-banana", "azure-gpt-image"] },
    },
    required: ["slug", "charId"],
  },
  async execute(args, ctx) {
    try {
      const result = await generateSpriteSheet(
        {
          projectRoot: defaultProjectRoot(),
          env: process.env,
          emit: (name, payload) => { ctx.eventBus.hook(name, payload); },
        },
        args as unknown as GenerateSpriteSheetArgs,
      );
      return JSON.stringify(result, null, 2);
    } catch (err: unknown) {
      if (err instanceof ForgeError) {
        return JSON.stringify({ error: err.code, message: err.message });
      }
      throw err;
    }
  },
};

export default tool;
