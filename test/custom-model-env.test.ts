/** custom-model-env 解析 + catalog 合并 单测. */
import { test, expect } from "bun:test";
import { parseCustomModelFromEnv } from "../src/llm/custom-model-env";
import { resolveModelAdapter } from "../src/llm/auto-resolver";

test("未配 FORGEAX_CUSTOM_MODEL → null (不启用 custom)", () => {
  expect(parseCustomModelFromEnv({})).toBeNull();
});

test("配 MODEL 但缺 BASE_URL → null + warn (避免'看得见选不通')", () => {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (m: string) => warns.push(m);
  try {
    const r = parseCustomModelFromEnv({ FORGEAX_CUSTOM_MODEL: "orphan-model" });
    expect(r).toBeNull();
    expect(warns.some((w) => /FORGEAX_CUSTOM_BASE_URL 缺失/.test(w))).toBe(true);
  } finally {
    console.warn = orig;
  }
});

test("配齐 → 解析出 id + spec (含 baseUrl/apiKey/api/displayName)", () => {
  const r = parseCustomModelFromEnv({
    FORGEAX_CUSTOM_MODEL: "glm-5.2",
    FORGEAX_CUSTOM_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
    FORGEAX_CUSTOM_API_KEY: "tok",
    FORGEAX_CUSTOM_API: "anthropic-messages",
    FORGEAX_CUSTOM_NAME: "GLM 5.2",
  });
  expect(r?.id).toBe("glm-5.2");
  expect(r?.spec.baseUrl).toBe("https://open.bigmodel.cn/api/anthropic");
  expect(r?.spec.apiKey).toBe("tok");
  expect(r?.spec.api).toBe("anthropic-messages");
  expect(r?.spec.displayName).toBe("GLM 5.2");
});

test("默认上下文窗口 1M; 仅显式覆盖才变", () => {
  const def = parseCustomModelFromEnv({ FORGEAX_CUSTOM_MODEL: "m", FORGEAX_CUSTOM_BASE_URL: "https://x" });
  expect(def?.spec.contextWindow).toBe(1_000_000);
  const ovr = parseCustomModelFromEnv({ FORGEAX_CUSTOM_MODEL: "m", FORGEAX_CUSTOM_BASE_URL: "https://x", FORGEAX_CUSTOM_CONTEXT_WINDOW: "200000" });
  expect(ovr?.spec.contextWindow).toBe(200000);
  // 非法值落回缺省 1M
  const bad = parseCustomModelFromEnv({ FORGEAX_CUSTOM_MODEL: "m", FORGEAX_CUSTOM_BASE_URL: "https://x", FORGEAX_CUSTOM_CONTEXT_WINDOW: "abc" });
  expect(bad?.spec.contextWindow).toBe(1_000_000);
});

test("缺省字段: api→openai-compat, displayName→id, apiKey→空串", () => {
  const r = parseCustomModelFromEnv({ FORGEAX_CUSTOM_MODEL: "bare", FORGEAX_CUSTOM_BASE_URL: "https://b/v1" });
  expect(r?.spec.api).toBe("openai-compat");
  expect(r?.spec.displayName).toBe("bare");
  expect(r?.spec.apiKey).toBe("");
});

test("非法 FORGEAX_CUSTOM_API 落回 openai-compat", () => {
  const r = parseCustomModelFromEnv({ FORGEAX_CUSTOM_MODEL: "m", FORGEAX_CUSTOM_BASE_URL: "https://x", FORGEAX_CUSTOM_API: "bogus" });
  expect(r?.spec.api).toBe("openai-compat");
});

test("端到端: env custom 经 catalog 注入 → resolveModelAdapter 用声明端点", () => {
  // 模拟 catalog 已含 env custom 条目 (model-catalog.loadModelCatalog 会做这个合并).
  const parsed = parseCustomModelFromEnv({
    FORGEAX_CUSTOM_MODEL: "glm-5.2",
    FORGEAX_CUSTOM_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
    FORGEAX_CUSTOM_API_KEY: "tok",
    FORGEAX_CUSTOM_API: "anthropic-messages",
  })!;
  const catalog = { [parsed.id]: parsed.spec };
  const r = resolveModelAdapter("glm-5.2", {}, catalog);
  expect(r.api).toBe("anthropic-messages");
  expect(r.apiBase).toBe("https://open.bigmodel.cn/api/anthropic");
  expect(r.apiKey).toBe("tok");
});
