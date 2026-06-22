/** Model catalog (`~/.forgeax/key/models.json`) 读取 —— 从 provider.ts 抽离的独立模块.
 *
 *  抽离目的: 让 auto-resolver 能在前缀路由 miss 时查表回退 (custom model 带声明的
 *  baseUrl/apiKey/api), 而 provider ↔ auto-resolver 之间不产生循环依赖 (provider 已
 *  import auto-resolver; 此模块只依赖 path-manager + fs, 不反向 import 两者).
 *
 *  mtime-keyed 缓存: getModelSpec() 每 LLM turn 命中数次, 缓存避免重复 parse. */

import { readFileSync, existsSync, statSync } from "node:fs";
import type { ModelSpec } from "../core/types.js";
import { getPathManager } from "../fs/path-manager.js";

/** 预制模型缺省能力规格 (catalog miss 时兜底). */
const DEFAULT_SPEC: ModelSpec = {
  input: ["text"],
  reasoning: false,
  contextWindow: 128000,
  maxOutput: 4096,
  defaultTemperature: 0.7,
};

// mtime-keyed 缓存. 文件不变时直接复用上一次 parse 结果; stat 失败则落回重读.
let _modelCatalogCache: { path: string; mtime: number; parsed: Record<string, ModelSpec> } | null = null;

/** 读取 catalog; 始终反映磁盘最新状态 (mtime 变化即重 parse), 文件缺失/损坏返回 {}. */
export function loadModelCatalog(): Record<string, ModelSpec> {
  const p = getPathManager().user().modelsFile();
  if (!existsSync(p)) return {};
  let mtime = 0;
  try { mtime = statSync(p).mtimeMs; } catch { /* fall through */ }
  if (_modelCatalogCache && _modelCatalogCache.path === p && _modelCatalogCache.mtime === mtime) {
    return _modelCatalogCache.parsed;
  }
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as Record<string, ModelSpec>;
    _modelCatalogCache = { path: p, mtime, parsed };
    return parsed;
  } catch {
    if (_modelCatalogCache && _modelCatalogCache.path === p) return _modelCatalogCache.parsed;
    return {};
  }
}

/** 取单个 model 的能力规格; catalog miss 返回 DEFAULT_SPEC. */
export function getModelSpec(model: string): ModelSpec {
  const catalog = loadModelCatalog();
  return catalog[model] ?? DEFAULT_SPEC;
}
