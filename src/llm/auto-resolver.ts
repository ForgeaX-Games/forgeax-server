/** Pure model→adapter resolver. Replaces llm_key.json: every routing decision
 *  derives from `.env` + the model id pattern (+ 前缀 miss 时查 models.json 的
 *  custom 声明). catalog 读取走 model-catalog.ts 的 mtime 缓存, 无重复 IO.
 *
 *  Routing policy:
 *
 *    if LITELLM_PROXY_KEY + LITELLM_PROXY_BASE_URL are set, the proxy is
 *    treated as the primary gateway for every model:
 *      claude-*                         → anthropic-messages (proxy /messages)
 *      gpt-* / codex-* / o[1-9]-*       → openai-responses   (proxy /v1)
 *      everything else                  → openai-compat      (proxy /v1)
 *
 *    otherwise we fall back to direct vendor APIs:
 *      claude-*                         → anthropic-messages + ANTHROPIC_*
 *      glm-*                            → anthropic-messages + ANTHROPIC_* (智谱 BigModel 兼容端点)
 *      gpt-* / codex-* / o[1-9]-*       → openai-responses   + OPENAI_*
 *      gemini-3*                        → google-gemini-3    + GEMINI_API_KEY
 *      gemini-*                         → google-gemini-2    + GEMINI_API_KEY
 *      deepseek-*                       → deepseek-v4        + DEEPSEEK_*
 *
 *    nothing matches → throws a single, actionable error: "set
 *    LITELLM_PROXY_KEY + LITELLM_PROXY_BASE_URL in .env, or add a vendor key
 *    that recognizes this id".
 *
 *  Trade-off: when the proxy is configured we lose Gemini-native features
 *  (thinkingBudget / thinkingLevel / thoughtSignature) because LiteLLM speaks
 *  openai-compat for Gemini. Users who need those features can clear
 *  LITELLM_PROXY_* and rely on direct GEMINI_API_KEY routing.
 *
 *  Custom model escape hatch: 前缀路由都不匹配时, 查 ~/.forgeax/key/models.json
 *  (model-catalog.ts); 条目带 baseUrl (custom 声明) 即用其 api/apiKey/baseUrl 绕过
 *  前缀路由, 让任意名字的自定义端点可用. */

import { loadModelCatalog } from "./model-catalog.js";
import type { ModelSpec } from "../core/types.js";

export interface ResolvedAdapter {
  api: string;
  apiKey: string;
  apiBase: string | undefined;
}

function proxyConfigured(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.LITELLM_PROXY_KEY && env.LITELLM_PROXY_BASE_URL);
}

/** Normalize the user's LITELLM_PROXY_BASE_URL into a bare host (no trailing
 *  slash, no trailing `/v1`). The resolver re-appends `/v1` itself for the
 *  openai-* adapter families; the anthropic adapter prepends `/v1/messages`.
 *  Tolerating both `https://host` and `https://host/v1` covers the most
 *  common .env pasting mistake — legacy llm_key.json configs put `/v1` in
 *  api_base, and users carrying that habit into .env hit /v1/v1/... 404s. */
function normalizeProxyBase(raw: string): string {
  return raw.replace(/\/+$/, "").replace(/\/v1$/, "");
}

const RE_CLAUDE = /^claude-/i;
const RE_OPENAI_RESPONSES = /^(gpt-|codex-|o[1-9](-|$))/i;
const RE_GEMINI_3 = /^gemini-3/i;
const RE_GEMINI = /^gemini-/i;
const RE_GLM = /^glm-/i; // 智谱 BigModel GLM 系列 (走其 Anthropic 兼容端点)
const RE_DEEPSEEK = /^deepseek-/i;

export function resolveModelAdapter(
  model: string,
  env: NodeJS.ProcessEnv,
  /** 测试注入 / 调用方预解析的 catalog; 缺省读 ~/.forgeax/key/models.json. */
  catalog?: Record<string, ModelSpec>,
): ResolvedAdapter {
  // Direct-route exceptions: 用户显式配了 DEEPSEEK_API_KEY 等直连 key 的情况下,
  // 即便 LITELLM_PROXY 也配着, 也优先走直连. 理由: 自家 LiteLLM proxy 不一定上架
  // 所有 vendor model id (e.g. deepseek-v4-flash), 强制走代理会 401/404. 直连
  // key 是"我要绕过代理用这个模型"的明确意图, 应当尊重.
  if (RE_DEEPSEEK.test(model) && env.DEEPSEEK_API_KEY) {
    return { api: "deepseek-v4", apiKey: env.DEEPSEEK_API_KEY, apiBase: env.DEEPSEEK_BASE_URL || undefined };
  }

  // Custom model (显式声明优先): models.json 里带 baseUrl 的条目是用户显式指定的
  // 自定义端点, 优先于 proxy / vendor 前缀路由. 让任意名字的自定义模型 (含与 vendor
  // 前缀同名的情况) 都按声明的 api/apiKey/baseUrl 走, 而不被 proxy catch-all 吞掉或
  // 前缀路由覆盖. 缺省 adapter 为 openai-compat (多数第三方兼容端点适用).
  const custom = (catalog ?? loadModelCatalog())[model];
  if (custom?.baseUrl) {
    return {
      api: custom.api ?? "openai-compat",
      apiKey: custom.apiKey ?? "",
      apiBase: custom.baseUrl,
    };
  }

  if (proxyConfigured(env)) {
    const proxyKey = env.LITELLM_PROXY_KEY!;
    const proxyBase = normalizeProxyBase(env.LITELLM_PROXY_BASE_URL!);
    if (RE_CLAUDE.test(model)) {
      return { api: "anthropic-messages", apiKey: proxyKey, apiBase: proxyBase };
    }
    if (RE_OPENAI_RESPONSES.test(model)) {
      return { api: "openai-responses", apiKey: proxyKey, apiBase: `${proxyBase}/v1` };
    }
    return { api: "openai-compat", apiKey: proxyKey, apiBase: `${proxyBase}/v1` };
  }

  // claude-* 与 glm-* 共用 Anthropic Messages 协议, 统一经 ANTHROPIC_BASE_URL 出口:
  // 端点地址完全由 .env 的该变量决定, 代码不写死任何具体 URL. 复用同一
  // ANTHROPIC_API_KEY 凭证. 兼容端点通常同时认 x-api-key 与 Authorization: Bearer,
  // 而本仓 anthropic 适配器 (anthropic.ts) 发 x-api-key, 故无需改认证.
  if (RE_CLAUDE.test(model) || RE_GLM.test(model)) {
    const apiKey = env.ANTHROPIC_API_KEY ?? "";
    if (!apiKey) throw new Error(`No API key for '${model}': set ANTHROPIC_API_KEY (or LITELLM_PROXY_KEY+LITELLM_PROXY_BASE_URL) in .env`);
    return { api: "anthropic-messages", apiKey, apiBase: env.ANTHROPIC_BASE_URL || undefined };
  }
  if (RE_OPENAI_RESPONSES.test(model)) {
    const apiKey = env.OPENAI_API_KEY ?? "";
    if (!apiKey) throw new Error(`No API key for '${model}': set OPENAI_API_KEY (or LITELLM_PROXY_KEY+LITELLM_PROXY_BASE_URL) in .env`);
    return { api: "openai-responses", apiKey, apiBase: env.OPENAI_BASE_URL || undefined };
  }
  if (RE_GEMINI_3.test(model)) {
    const apiKey = env.GEMINI_API_KEY ?? "";
    if (!apiKey) throw new Error(`No API key for '${model}': set GEMINI_API_KEY (or LITELLM_PROXY_KEY+LITELLM_PROXY_BASE_URL) in .env`);
    return { api: "google-gemini-3", apiKey, apiBase: undefined };
  }
  if (RE_GEMINI.test(model)) {
    const apiKey = env.GEMINI_API_KEY ?? "";
    if (!apiKey) throw new Error(`No API key for '${model}': set GEMINI_API_KEY (or LITELLM_PROXY_KEY+LITELLM_PROXY_BASE_URL) in .env`);
    return { api: "google-gemini-2", apiKey, apiBase: undefined };
  }
  if (RE_DEEPSEEK.test(model)) {
    const apiKey = env.DEEPSEEK_API_KEY ?? "";
    if (!apiKey) throw new Error(`No API key for '${model}': set DEEPSEEK_API_KEY (or LITELLM_PROXY_KEY+LITELLM_PROXY_BASE_URL) in .env`);
    return { api: "deepseek-v4", apiKey, apiBase: env.DEEPSEEK_BASE_URL || undefined };
  }

  throw new Error(
    `No adapter recognizes model '${model}'. Either set LITELLM_PROXY_KEY + ` +
    `LITELLM_PROXY_BASE_URL in .env to route through the proxy, or use a model ` +
    `id matching one of: claude-*, glm-*, gpt-*/codex-*/o[1-9]-*, gemini-*, deepseek-*.`,
  );
}
