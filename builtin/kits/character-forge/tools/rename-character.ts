/** rename-character —— 修改 manifest.name（1-80 字符），其他字段不动。 */

import type { ToolDefinition } from "../../../../src/core/types";
import { defaultProjectRoot } from "../../../../src/api/lib/safe-path";
import {
  ForgeError,
  renameCharacter,
} from "@server-lib/character-forge";

const tool: ToolDefinition = {
  name: "rename-character",
  description: "重命名角色（仅改 manifest.name，1-80 字符）。会触发 character-forge.character.renamed 事件。",
  input_schema: {
    type: "object",
    properties: {
      slug: { type: "string", description: "game-project slug" },
      charId: { type: "string", description: "角色 id" },
      name: { type: "string", description: "新名字（1-80 字符）" },
    },
    required: ["slug", "charId", "name"],
  },
  async execute(args, ctx) {
    try {
      const result = await renameCharacter(
        {
          projectRoot: defaultProjectRoot(),
          env: process.env,
          emit: (name, payload) => { ctx.eventBus.hook(name, payload); },
        },
        String(args.slug ?? ''),
        String(args.charId ?? ''),
        String(args.name ?? ''),
      );
      return JSON.stringify(result);
    } catch (err: unknown) {
      if (err instanceof ForgeError) {
        return JSON.stringify({ error: err.code, message: err.message });
      }
      throw err;
    }
  },
};

export default tool;
