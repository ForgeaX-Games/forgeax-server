/** get-character —— 读取单角色的完整 manifest + asset urls。只读。 */

import type { ToolDefinition } from "../../../../src/core/types";
import { defaultProjectRoot } from "../../../../src/api/lib/safe-path";
import {
  ForgeError,
  getCharacter,
} from "@server-lib/character-forge";

const tool: ToolDefinition = {
  name: "get-character",
  description:
    "读取单角色的完整 manifest（含 prompt / portrait 字段 / sprites 字段 / variants）+ 每个 asset 的 url。",
  input_schema: {
    type: "object",
    properties: {
      slug: { type: "string", description: "game-project slug" },
      charId: { type: "string", description: "角色 id" },
    },
    required: ["slug", "charId"],
  },
  async execute(args) {
    try {
      const result = await getCharacter(
        { projectRoot: defaultProjectRoot(), env: process.env },
        String(args.slug ?? ''),
        String(args.charId ?? ''),
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
