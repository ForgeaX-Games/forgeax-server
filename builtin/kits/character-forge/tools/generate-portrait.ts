/** generate-portrait —— 生成单角色立绘 / 三视图。
 *
 *  AI 调用入口；与 builtin/commands/character-forge.ts::generate_portrait 共享
 *  同一份 handlers.ts 实现。结果默认序列化为 JSON 字符串（ToolOutput=string，
 *  方便 LLM 复读），同时发 `character-forge.portrait.generated` 事件让前端 ws
 *  实时刷新缩略图。 */

import type { ToolDefinition } from "../../../../src/core/types";
import { defaultProjectRoot } from "../../../../src/api/lib/safe-path";
import {
  ForgeError,
  generatePortrait,
} from "@server-lib/character-forge";
import type { GeneratePortraitArgs } from "@server-lib/character-forge/types";

const tool: ToolDefinition = {
  name: "generate-portrait",
  description:
    "生成角色立绘（可选三视图 front/side/back）。主用 Seedream，备用 Gemini nano-banana / Azure GPT-image。" +
    "落盘到 <projectRoot>/.forgeax/games/<slug>/characters/<charId>/portrait/<view>.png，" +
    "同时 append/refresh manifest.json。返回 { charId, name, files[{view,path,url}], manifestPath, model, costEstimate }。",
  input_schema: {
    type: "object",
    properties: {
      slug: { type: "string", description: "game-project slug，要求 [a-z0-9][a-z0-9-]{1,40}" },
      prompt: { type: "string", description: "角色文字描述（自然语言）" },
      style: {
        type: "string",
        description: "风格预设；缺省 anime-hd-flat",
        enum: [
          "anime-hd-flat",
          "semi-realistic",
          "pixel-32",
          "cell-shaded",
          "watercolor",
          "cyberpunk",
        ],
      },
      views: {
        type: "array",
        description: "要生成的视角，缺省只 front",
        items: { type: "string", enum: ["front", "side", "back"] },
      },
      name: { type: "string", description: "角色显示名，缺省从 prompt 推导" },
      charId: { type: "string", description: "复用已存在 charId 时填；缺省自动 derive" },
      model: {
        type: "string",
        description: "强制首选模型（仍走 fallback 链）",
        enum: ["seedream", "nano-banana", "azure-gpt-image"],
      },
      size: { type: "string", enum: ["1k", "2k", "4k"] },
      refImageBase64: { type: "string", description: "参考图 base64（可选，做角色一致性）" },
    },
    required: ["slug", "prompt"],
  },
  async execute(args, ctx) {
    try {
      const result = await generatePortrait(
        {
          projectRoot: defaultProjectRoot(),
          env: process.env,
          emit: (name, payload) => { ctx.eventBus.hook(name, payload); },
        },
        args as unknown as GeneratePortraitArgs,
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
