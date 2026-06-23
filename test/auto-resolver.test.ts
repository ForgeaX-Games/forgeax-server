/** auto-resolver 单测: 前缀路由 (vendor) + custom model 查表回退. */
import { test, expect } from "bun:test";
import { resolveModelAdapter } from "../src/llm/auto-resolver";
import type { ModelSpec } from "../src/core/types";

/** 能力规格基线 (custom 测试条目复用). */
const SPEC: ModelSpec = {
  input: ["text", "image"],
  reasoning: true,
  contextWindow: 128000,
  maxOutput: 8192,
  defaultTemperature: 0.7,
};

test("前缀路由: claude-* / glm-* → anthropic-messages + ANTHROPIC_*", () => {
  const env = { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://a" };
  const claude = resolveModelAdapter("claude-opus-4-8", env);
  expect(claude.api).toBe("anthropic-messages");
  expect(claude.apiKey).toBe("k");
  const glm = resolveModelAdapter("glm-5.2", env);
  expect(glm.api).toBe("anthropic-messages");
  expect(glm.apiBase).toBe("https://a");
});

test("前缀路由: gpt-* → openai-responses + OPENAI_*", () => {
  const r = resolveModelAdapter("gpt-5.5", { OPENAI_API_KEY: "k" });
  expect(r.api).toBe("openai-responses");
});

test("前缀路由: deepseek-* (配 DEEPSEEK_API_KEY) → deepseek-v4 直连", () => {
  const r = resolveModelAdapter("deepseek-v4-pro", { DEEPSEEK_API_KEY: "k" });
  expect(r.api).toBe("deepseek-v4");
});

test("前缀 miss + 空 catalog → throw (无适配器识别)", () => {
  expect(() => resolveModelAdapter("totally-unknown-model", {}, {})).toThrow();
});

test("查表回退: catalog custom 条目 (带 baseUrl/api/apiKey) → 用声明值绕过前缀路由", () => {
  const catalog: Record<string, ModelSpec> = {
    "my-glm": { ...SPEC, api: "anthropic-messages", baseUrl: "https://zhipu/api/anthropic", apiKey: "tok" },
  };
  const r = resolveModelAdapter("my-glm", {}, catalog);
  expect(r.api).toBe("anthropic-messages");
  expect(r.apiBase).toBe("https://zhipu/api/anthropic");
  expect(r.apiKey).toBe("tok");
});

test("查表回退: custom 缺省 api → openai-compat (多数第三方兼容端点)", () => {
  const catalog: Record<string, ModelSpec> = {
    "my-oai": { ...SPEC, baseUrl: "https://oai/v1", apiKey: "k" },
  };
  const r = resolveModelAdapter("my-oai", {}, catalog);
  expect(r.api).toBe("openai-compat");
  expect(r.apiBase).toBe("https://oai/v1");
});

test("查表回退: 条目无 baseUrl → 不触发回退 (仍按前缀路由/throw)", () => {
  // 无 baseUrl 的条目视为普通能力声明, 不构成 custom 端点 → custom miss → 前缀 miss → throw.
  const catalog: Record<string, ModelSpec> = { "plain-entry": { ...SPEC } };
  expect(() => resolveModelAdapter("plain-entry", {}, catalog)).toThrow();
});

test("custom 优先于 vendor 前缀: id 匹配前缀名但带 baseUrl → 走 custom 声明", () => {
  const catalog: Record<string, ModelSpec> = {
    "glm-custom": { ...SPEC, api: "anthropic-messages", baseUrl: "https://custom/api", apiKey: "ck" },
  };
  // 即便 env 有 ANTHROPIC_* (glm 前缀本会命中), custom 声明优先 → 用 custom baseUrl/apiKey.
  const r = resolveModelAdapter("glm-custom", { ANTHROPIC_API_KEY: "ak", ANTHROPIC_BASE_URL: "https://anthropic" }, catalog);
  expect(r.apiBase).toBe("https://custom/api");
  expect(r.apiKey).toBe("ck");
});

test("custom 优先于 proxy: 配 LITELLM_PROXY + catalog custom → 走 custom 声明", () => {
  const env = { LITELLM_PROXY_KEY: "pk", LITELLM_PROXY_BASE_URL: "https://proxy/v1" };
  const catalog: Record<string, ModelSpec> = {
    "my-local": { ...SPEC, baseUrl: "https://local/v1", apiKey: "lk" },
  };
  const r = resolveModelAdapter("my-local", env, catalog);
  expect(r.apiBase).toBe("https://local/v1");
  expect(r.api).toBe("openai-compat");
});

test("custom api 枚举: openai-responses", () => {
  const catalog: Record<string, ModelSpec> = {
    "my-resp": { ...SPEC, api: "openai-responses", baseUrl: "https://r/v1", apiKey: "k" },
  };
  const r = resolveModelAdapter("my-resp", {}, catalog);
  expect(r.api).toBe("openai-responses");
});
