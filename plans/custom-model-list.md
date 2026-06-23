# 计划：自定义模型 —— .env 一处填全，网页端可切换

## Context（为什么改）

forge agent 选模型走 `resolveModelsConfig`，只读 `agent.json::models.model`，不读 env；`auto-resolver`
只按 model 名前缀路由，任意名字的自定义端点必然 miss → throw。学长要在 **`.env` 一处填全**自定义模型
的完整信息（模型名 + base url + key），不用再去编辑 `~/.forgeax/key/models.json`；该模型在 Studio
ModelPicker 像预制模型一样列出、可切换，forge agent 直接路由到声明的端点。

约束（学长定）：**只支持单个 custom 模型**；上下文窗口默认 1M，仅手动覆盖才变。

## 方案（已实现）

### 1. ModelSpec 扩字段（`core/types.ts`）
加可选 `displayName?` / `api?` / `baseUrl?` / `apiKey?`。预制条目不带 → 行为不变。

### 2. env → custom 解析（`llm/custom-model-env.ts`，新建）
`parseCustomModelFromEnv(env)` 读：
- `FORGEAX_CUSTOM_MODEL`（模型 id，必填；有它即启用，缺省关闭）
- `FORGEAX_CUSTOM_BASE_URL`（端点，必填，触发查表）
- `FORGEAX_CUSTOM_API_KEY`（可选，缺省空串）
- `FORGEAX_CUSTOM_API`（可选 adapter，缺省 openai-compat；非法值落回 openai-compat）
- `FORGEAX_CUSTOM_NAME`（可选显示名，缺省 id）
- `FORGEAX_CUSTOM_CONTEXT_WINDOW`（可选，缺省 **1_000_000**；非正/非法落回 1M）

返回 `{id, spec}` 或 `null`。

### 3. catalog 合并（`llm/model-catalog.ts` + `builtin/commands/models.ts`）
- `loadModelCatalog`（路由侧）：磁盘 catalog + env custom 合并，**env 同 id 覆盖磁盘**（最新显式意图）。
- `loadModelsCatalog`（UI 侧 list_models）：env custom 最优先列出，`source:"custom"`，**豁免 live 剔除**
  （用户显式端点不被 proxy live 列表否决）。

### 4. auto-resolver custom 查表（已有，`llm/auto-resolver.ts`）
优先级：deepseek 直连 > **custom 查表（显式声明）** > proxy > vendor 前缀 > throw。custom 条目（带
baseUrl）按声明的 api/apiKey/baseUrl 路由。env custom 经 catalog 注入后天然命中此分支。

### 5. 安全：apiKey 不外泄
list_models 出口两处过滤：`loadDiskCatalog` `delete apiKey`、`loadModelsCatalog` 注入 env custom 时
解构剔除 `apiKey`。路由侧 `loadModelCatalog` 保留 apiKey（仅 server 内部路由用）。

### 6. UI（已有，无需改）
ModelPicker 读 list_models（含 env custom），条目 id 自然列出 + 可选 → agent.json → ConsciousAgent →
createProvider → resolveModelAdapter → custom 查表 → 声明端点。

## 改动文件（forgeax-server，全在 submodule 内，主仓库零接触）

1. `src/core/types.ts` — ModelSpec 加 4 可选字段。
2. `src/llm/custom-model-env.ts` — 新建，env→custom 解析（单模型）。
3. `src/llm/model-catalog.ts` — 新建（catalog 抽离）+ 合并 env custom。
4. `src/llm/provider.ts` — 删本地 catalog，re-export getModelSpec。
5. `src/llm/auto-resolver.ts` — custom 查表提前 + 可选 catalog 参数 + glm-* 路由。
6. `builtin/commands/models.ts` — list_models 合并 env custom（source:"custom"，豁免 live 剔除）+ apiKey 过滤。
7. `test/auto-resolver.test.ts` + `test/custom-model-env.test.ts` — 共 16 例。

## 用法（学长场景，本机 `.env`，无需碰 models.json）

```
FORGEAX_CUSTOM_MODEL=glm-5.2
FORGEAX_CUSTOM_BASE_URL=https://open.bigmodel.cn/api/anthropic
FORGEAX_CUSTOM_API_KEY=<智谱token>
FORGEAX_CUSTOM_API=anthropic-messages
# FORGEAX_CUSTOM_NAME=GLM 5.2 (智谱)        # 可选显示名
# FORGEAX_CUSTOM_CONTEXT_WINDOW=200000      # 可选, 缺省 1M
```
（`.env` 在 superproject 根、git 已忽略；`.env.example` 属 superproject，未改以保持主仓库零接触。）

重启 server 后 Composer 的 ModelPicker 出现 `glm-5.2`（或显示名），选中即生效。

## fork 工作流（只在自己 fork，不碰主）

- fork `lagdads/forgeax-server`（已完成），`feat/custom-model-list` 分支 + push。
- 不建 PR/MR，superproject submodule 指针不动。

## 验证

- 单测：`custom-model-env.test.ts` + `auto-resolver.test.ts` **16 pass**（解析/缺省 1M/缺省字段/非法落回
  + 前缀路由 + custom 查表/优先级/枚举/端到端 env→catalog→resolve）。
- typecheck：改动文件 0 错误。
- 端到端：本机 `.env` 填 custom → `loadModelCatalog()` 含该 id 且带 baseUrl/apiKey → 经智谱返回该模型。
- 回归：env 未设 → catalog = 纯磁盘，行为不变。`list-models.test.ts` 的 1 fail 为既有（与本改无关）。
