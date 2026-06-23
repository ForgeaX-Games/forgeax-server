// list_models — LiteLLM live + disk metadata merge.
//
// Stage B contract:
// - Disk entries (~/.forgeax/key/models.json) come back with their stored spec
//   intact (contextWindow / reasoning / input / maxOutput / defaultTemperature)
//   and `source: 'disk'`.
// - LiteLLM `/v1/models` ids absent on disk get appended with LIVE_DEFAULT_SPEC
//   + `source: 'live'`. Disk wins when an id appears in both.
// - Order: disk first (preserves user's curated picker order), then live-only.
// - The response gains a sibling `live: { source, error?, ids }` for UI
//   diagnostics; existing `{ models }` consumers stay green.
// - Live fetch never throws: on HTTP/network failure, models still come back
//   from disk and live.source = 'error' surfaces the reason.
//
// We intercept globalThis.fetch instead of pointing at the real proxy — tests
// must be hermetic and runnable offline.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { initPathManager, resetPathManager, getPathManager } from "../src/fs/path-manager";
import { initSessionManager, resetSessionManager, getSessionManager } from "../src/core/session-manager";
import models from "../builtin/commands/models";
import { _resetLiveCatalogCache } from "../src/lib/llm-gateway/live-catalog";

let userRoot: string;
let prevBaseUrl: string | undefined;
let prevKey: string | undefined;
let realFetch: typeof fetch;

function ctx() {
  return { sm: getSessionManager(), paths: getPathManager() };
}

function writeDiskCatalog(contents: Record<string, unknown>): void {
  const p = getPathManager().user().modelsFile();
  mkdirSync(resolve(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(contents, null, 2), "utf-8");
}

function mockFetch(responder: (url: string) => { status: number; body: unknown } | Error): void {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    const result = responder(u);
    if (result instanceof Error) throw result;
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

beforeEach(async () => {
  userRoot = mkdtempSync(resolve(tmpdir(), "forgeax-listmodels-"));
  prevBaseUrl = process.env.LITELLM_PROXY_BASE_URL;
  prevKey = process.env.LITELLM_PROXY_KEY;
  process.env.LITELLM_PROXY_BASE_URL = "https://test-proxy.invalid/v1";
  process.env.LITELLM_PROXY_KEY = "sk-test-1234567890";
  realFetch = globalThis.fetch;
  resetPathManager();
  await resetSessionManager();
  _resetLiveCatalogCache();
  const pm = initPathManager({ userRoot });
  initSessionManager(pm);
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  if (prevBaseUrl === undefined) delete process.env.LITELLM_PROXY_BASE_URL;
  else process.env.LITELLM_PROXY_BASE_URL = prevBaseUrl;
  if (prevKey === undefined) delete process.env.LITELLM_PROXY_KEY;
  else process.env.LITELLM_PROXY_KEY = prevKey;
  await resetSessionManager();
  resetPathManager();
  rmSync(userRoot, { recursive: true, force: true });
  _resetLiveCatalogCache();
});

interface ListModelsResp {
  models: Array<{ id: string; source?: string; contextWindow?: number; reasoning?: boolean; input?: string[] }>;
  live: { source: string; error?: string; ids: number };
}

async function callListModels(): Promise<ListModelsResp> {
  return (await models.query!("list_models", [], ctx())) as ListModelsResp;
}

describe("list_models — disk + LiteLLM merge", () => {
  test("disk entries win; live-only entries get defaults + source: 'live'", async () => {
    writeDiskCatalog({
      "claude-opus-4-7": {
        input: ["text", "image"],
        reasoning: true,
        contextWindow: 1000000,
        maxOutput: 128000,
        defaultTemperature: 1.0,
      },
      "gpt-5.4": {
        input: ["text", "image"],
        reasoning: true,
        contextWindow: 400000,
        maxOutput: 128000,
        defaultTemperature: 1.0,
      },
    });

    mockFetch((url) => {
      expect(url).toBe("https://test-proxy.invalid/v1/models");
      return {
        status: 200,
        body: {
          object: "list",
          data: [
            { id: "claude-opus-4-7" }, // dup with disk
            { id: "gpt-5.5" },          // live-only
            { id: "glm-5.1" },          // live-only
            { id: "gemini-3.5-flash" }, // live-only
          ],
        },
      };
    });

    const resp = await callListModels();

    expect(resp.live.source).toBe("live");
    expect(resp.live.ids).toBe(4);

    const byId = new Map(resp.models.map((m) => [m.id, m]));
    // disk metadata preserved
    expect(byId.get("claude-opus-4-7")?.contextWindow).toBe(1000000);
    expect(byId.get("claude-opus-4-7")?.source).toBe("disk");
    // live-only ids appear with default contextWindow + source:'live'
    expect(byId.get("gpt-5.5")?.source).toBe("live");
    expect(byId.get("gpt-5.5")?.contextWindow).toBe(128000); // LIVE_DEFAULT_SPEC
    expect(byId.get("glm-5.1")?.source).toBe("live");
    expect(byId.get("gemini-3.5-flash")?.source).toBe("live");
    // disk-only entries still present
    expect(byId.get("gpt-5.4")?.source).toBe("disk");
    expect(byId.get("gpt-5.4")?.contextWindow).toBe(400000);

    // Disk entries come first (user-curated picker order).
    const ids = resp.models.map((m) => m.id);
    expect(ids.indexOf("claude-opus-4-7")).toBeLessThan(ids.indexOf("gpt-5.5"));
    expect(ids.indexOf("gpt-5.4")).toBeLessThan(ids.indexOf("gpt-5.5"));
  });

  test("LiteLLM fetch error → disk-only catalog with live.source='error'", async () => {
    writeDiskCatalog({
      "claude-opus-4-7": { contextWindow: 1000000, reasoning: true },
    });
    mockFetch(() => new Error("network down"));

    const resp = await callListModels();
    expect(resp.live.source).toBe("error");
    expect(resp.live.error).toMatch(/network down/);
    expect(resp.models.length).toBe(1);
    expect(resp.models[0].id).toBe("claude-opus-4-7");
    expect(resp.models[0].source).toBe("disk");
  });

  test("LiteLLM HTTP 401 → disk-only catalog with live.source='error'", async () => {
    writeDiskCatalog({ "claude-opus-4-7": { contextWindow: 1000000 } });
    mockFetch(() => ({ status: 401, body: { error: "unauthorized" } }));

    const resp = await callListModels();
    expect(resp.live.source).toBe("error");
    expect(resp.live.error).toMatch(/401/);
    expect(resp.models.map((m) => m.id)).toEqual(["claude-opus-4-7"]);
  });

  test("no LITELLM_PROXY_BASE_URL → live.source='disabled' (still merges disk)", async () => {
    delete process.env.LITELLM_PROXY_BASE_URL;
    writeDiskCatalog({ "claude-opus-4-7": { contextWindow: 1000000 } });

    const resp = await callListModels();
    expect(resp.live.source).toBe("disabled");
    expect(resp.live.ids).toBe(0);
    expect(resp.models.length).toBe(1);
  });

  test("disk missing → only live entries (still returns live ids)", async () => {
    // no writeDiskCatalog call → file absent
    mockFetch(() => ({
      status: 200,
      body: { data: [{ id: "gpt-5.5" }, { id: "glm-5.1" }] },
    }));

    const resp = await callListModels();
    expect(resp.models.map((m) => m.id).sort()).toEqual(["glm-5.1", "gpt-5.5"]);
    expect(resp.models.every((m) => m.source === "live")).toBe(true);
  });

  test("60s TTL cache: second call within window doesn't refetch", async () => {
    writeDiskCatalog({ "claude-opus-4-7": { contextWindow: 1000000 } });

    let fetchCount = 0;
    mockFetch(() => {
      fetchCount++;
      return { status: 200, body: { data: [{ id: "gpt-5.5" }] } };
    });

    await callListModels();
    await callListModels();
    await callListModels();
    // Cache should suppress the latter two; only one network call.
    expect(fetchCount).toBe(1);
  });
});
