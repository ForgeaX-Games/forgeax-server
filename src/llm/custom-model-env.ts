/** env → custom model 解析 (单模型): 让用户在 .env 一处填全自定义模型的完整信息
 *  (模型名 + base url + key + 可选 adapter/上下文窗口/显示名), 无需再编辑
 *  ~/.forgeax/key/models.json. 解析结果合并进 catalog (model-catalog.ts), UI
 *  ModelPicker 自然列出, forge agent 直接路由到声明的端点.
 *
 *  .env 字段:
 *    FORGEAX_CUSTOM_MODEL          模型 id (必填; 有它即启用 custom, 缺省则关闭)
 *    FORGEAX_CUSTOM_BASE_URL       自定义端点 base url (必填, 触发 auto-resolver 查表)
 *    FORGEAX_CUSTOM_API_KEY        凭证 (可选, 缺省空串)
 *    FORGEAX_CUSTOM_API            adapter 类型 (可选, 缺省 openai-compat)
 *    FORGEAX_CUSTOM_NAME           UI 显示名 (可选, 缺省用 id)
 *    FORGEAX_CUSTOM_CONTEXT_WINDOW 上下文窗口 (可选, 缺省 1000000 = 1M) */

import type { ModelSpec } from "../core/types.js";

/** custom model 缺省上下文窗口 1M; 仅 FORGEAX_CUSTOM_CONTEXT_WINDOW 显式覆盖才变. */
const DEFAULT_CUSTOM_CONTEXT_WINDOW = 1_000_000;

const VALID_API = new Set(["anthropic-messages", "openai-compat", "openai-responses"]);

/** 从 env 解析单个 custom model 条目; 未配 FORGEAX_CUSTOM_MODEL 返回 null.
 *  返回 [id, ModelSpec] 便于调用方直接并入 catalog map.
 *  FORGEAX_CUSTOM_MODEL 已设但 FORGEAX_CUSTOM_BASE_URL 缺失时返回 null 并打 warn ——
 *  否则 catalog 会注入一条"看得见却选不通"的 custom 条目 (auto-resolver 查表因无
 *  baseUrl 不触发, 静默落到前缀/throw, 用户无感知). */
export function parseCustomModelFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { id: string; spec: ModelSpec } | null {
  const id = env.FORGEAX_CUSTOM_MODEL?.trim();
  if (!id) return null; // 未声明 custom model → 不启用

  const baseUrl = env.FORGEAX_CUSTOM_BASE_URL?.trim();
  if (!baseUrl) {
    console.warn(
      `[custom-model] FORGEAX_CUSTOM_MODEL='${id}' 已设但 FORGEAX_CUSTOM_BASE_URL 缺失, ` +
        `custom model 未启用 (需提供端点 base url). 请在 .env 补 FORGEAX_CUSTOM_BASE_URL.`,
    );
    return null;
  }

  // adapter 类型: 非法值落回 openai-compat (多数第三方兼容端点适用).
  const apiRaw = env.FORGEAX_CUSTOM_API?.trim();
  const api = (apiRaw && VALID_API.has(apiRaw) ? apiRaw : "openai-compat") as ModelSpec["api"];

  // 上下文窗口: 仅显式且为正整数才覆盖, 否则缺省 1M.
  const cwRaw = env.FORGEAX_CUSTOM_CONTEXT_WINDOW?.trim();
  const cwParsed = cwRaw ? Number(cwRaw) : NaN;
  const contextWindow = Number.isFinite(cwParsed) && cwParsed > 0 ? cwParsed : DEFAULT_CUSTOM_CONTEXT_WINDOW;

  const spec: ModelSpec = {
    input: ["text", "image"],
    reasoning: true,
    contextWindow,
    maxOutput: 8192,
    defaultTemperature: 1.0,
    displayName: env.FORGEAX_CUSTOM_NAME?.trim() || id,
    api,
    baseUrl,
    apiKey: env.FORGEAX_CUSTOM_API_KEY?.trim() || "",
  };
  return { id, spec };
}
