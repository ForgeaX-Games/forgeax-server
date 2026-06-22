# 计划：自定义模型列表（custom model list）— 网页端可切换

## Context（为什么改）

forge agent（server `ConsciousAgent`）选模型走 `resolveModelsConfig`，只读 `agent.json::models.model`
链（默认 `claude-opus-4-8`），不读 env。`auto-resolver` 又只按 model 名前缀（claude-/glm-/gpt-）路由，
任意名字的自定义端点必然 miss → throw。学长要在 Studio 网页端像预制模型一样管理/切换**自定义模型**
（每个带 model id + base url + api key）。

目标：让 `~/.forgeax/key/models.json` 支持 custom 条目（带 baseUrl/apiKey/api），UI ModelPicker 天然
列出（已读 models.json），`auto-resolver` 用声明的端点/凭证路由。

## 方案（已实现）

### 1. ModelSpec 扩字段（`core/types.ts`）
加可选 `displayName?` / `api?` / `baseUrl?` / `apiKey?`。预制条目不带 → 行为不变。

### 2. 抽离 `model-catalog.ts`（破循环依赖）
从 `provider.ts` 搬 `loadModelCatalog`/`getModelSpec`/`DEFAULT_SPEC`/mtime 缓存到独立模块（只依赖
path-manager + fs）。`provider` 与 `auto-resolver` 共用，避免 provider ↔ auto-resolver 循环。

### 3. auto-resolver custom 查表（优先级提前）
`resolveModelAdapter` 优先级：**deepseek 直连例外 > custom 查表（显式声明）> proxy > vendor 前缀
（claude/glm/gpt/gemini/deepseek）> throw**。custom 条目（带 baseUrl）优先，让任意名字的自定义端点
（含与前缀同名）按声明走，不被 proxy catch-all 吞掉或前缀覆盖。加可选 `catalog` 参数供测试注入。

### 4. 安全：apiKey 不外泄（`builtin/commands/models.ts`）
`loadDiskCatalog` 出口 `delete apiKey`——custom 的 apiKey 仅供 server 内部路由（auto-resolver 查表）用，
**绝不透传到 list_models API 响应**（防明文泄露到前端浏览器）。路由侧 `model-catalog.loadModelCatalog`
读同文件仍保留 apiKey，互不干扰。

### 5. UI（已有，无需改）
ModelPicker 读 models.json（loadDiskCatalog 透传），custom 条目 id 自然列出 + 可选。选中 → agent.json →
ConsciousAgent → createProvider → resolveModelAdapter → custom 查表 → 声明端点。

## 改动文件（forgeax-server）

1. `src/core/types.ts` — ModelSpec 加 4 个可选字段。
2. `src/llm/model-catalog.ts` — 新建（catalog 读取抽离）。
3. `src/llm/provider.ts` — 删本地 catalog，import + re-export getModelSpec。
4. `src/llm/auto-resolver.ts` — custom 查表提前 + 可选 catalog 参数 + glm-* 路由。
5. `builtin/commands/models.ts` — loadDiskCatalog 过滤 apiKey（安全）。
6. `test/auto-resolver.test.ts` — 新建，10 例（前缀路由 + custom 查表/优先级/枚举/边界）。

## 不改

- `forgeax-native.ts` / `claude-code.ts`（CLI driver，独立路径）。
- `forgeax-cli` models.json 模板（用户手编 `~/.forgeax/key/models.json` 加 custom）。
- superproject submodule 指针（主仓库零接触）。

## 用法（学长场景）

编辑 `~/.forgeax/key/models.json` 加 custom 条目（带 baseUrl/apiKey/api），Studio ModelPicker 出现该
条目 → 选中 → forge agent 用该端点。

## fork 工作流（只在自己 fork，不碰主）

- fork `forgeax-server` → `lagdads/forgeax-server`（已完成）。
- `feat/custom-model-list` 分支 + push。
- **不建 PR/MR**，superproject 不动。

## 验证（已通过）

- 单测：`auto-resolver.test.ts` **10 pass**（前缀路由 claude/glm/gpt/deepseek + custom 查表/优先级
  /openai-responses 枚举/无 baseUrl 边界）。
- `cross-package-import-lint` 4 pass（新模块不触跨包边界）。
- typecheck：改动文件 0 错误（仓内其余 tsc 报错全为 pre-existing，与本改动无关）。
- smoke：import 链无循环（provider ↔ auto-resolver 破除）+ 前缀路由保留 + catalog 读取（19 条）+
  re-export 生效。
- 注：`list-models.test.ts` 有 1 既有 fail（stash 验证与本 feature 无关，是 models.ts disk/live 合并
  逻辑与测试期望不同步）。
