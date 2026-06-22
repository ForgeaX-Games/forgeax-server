/** list-characters —— 列出 game slug 下的所有角色 + 缩略图 URL。只读。 */

import type { ToolDefinition } from "../../../../src/core/types";
import { defaultProjectRoot } from "../../../../src/api/lib/safe-path";
import {
  ForgeError,
  listCharacters,
} from "@server-lib/character-forge";

const tool: ToolDefinition = {
  name: "list-characters",
  description:
    "列出指定 game slug 下的角色资产清单 —— charId / name / portraitUrl / createdAt / hasSprites。",
  input_schema: {
    type: "object",
    properties: {
      slug: { type: "string", description: "game-project slug" },
    },
    required: ["slug"],
  },
  async execute(args) {
    try {
      const result = await listCharacters(
        { projectRoot: defaultProjectRoot(), env: process.env },
        String(args.slug ?? ''),
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
