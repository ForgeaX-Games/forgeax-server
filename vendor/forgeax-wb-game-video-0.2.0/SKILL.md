---
name: wb-game-video:author-guide
description: 视频游戏（玩法优先）蓝图编辑、素材生成与运行时调用指南
trigger: /wb-game-video
---

# 视频游戏工坊 · AI Skill

`@forgeax/wb-game-video` 编辑和运行 `GraphLibraryDocument`。根 `graph` 是运行入口，`manifest.mainPackId` 指向主蓝图，`manifest.packs` 保存主/子蓝图。修改后应通过 `src/runtime/validate/validate.ts` 校验。

## 工具

| tool id | 用途 |
|---|---|
| `wb-game-video:get-graph` | 读取当前游戏的完整蓝图；无文件时返回 `project: null` |
| `wb-game-video:save-graph` | 覆盖写入 `blueprint.json`；`title` 当前忽略；成功返回空 `versions` |
| `wb-game-video:list-videos` | 列出扩展内置视频的 `media.ref` |
| `wb-game-video:generate-shot-script` | 为节点生成镜头脚本文本 |
| `wb-game-video:generate-keyframe` | 生成关键帧或分镜图并登记素材 |
| `wb-game-video:generate-video` | 生成不超过 15 秒的单段视频 |
| `wb-game-video:generate-node-video` | 为长节点拆段并连续生成视频 |
| `wb-game-video:list-assets` | 按类型、生产方式或节点查询共享素材 |
| `wb-game-video:get-asset` | 查询一条素材的状态、文件或错误 |
| `wb-game-video:import-character-refs` | 只读导入角色参考图 |
| `wb-game-video:import-scene-refs` | 只读导入场景参考图 |

## 编辑闭环

```text
wb-game-video:get-graph({})
  → 修改 project.graph / project.manifest.packs
  → 校验节点、边、变量、素材和组件引用
  → wb-game-video:save-graph({ project })
```

如果 `get-graph` 返回 `project: null`，先创建空的 `GraphLibraryDocument`；不要自动注入 demo。Nodia demo 只用于用户显式重置。
游戏身份始终来自宿主绑定；所有 11 个工具都不接受 `gameSlug` 或其它游戏选择参数。

## 视频生产闭环

```text
import-character-refs + import-scene-refs
  → generate-shot-script
  → generate-keyframe
  → generate-video 或 generate-node-video
  → 把返回的 asset.id 绑定到节点 media.ref
```

素材写入宿主绑定工作区的逻辑目录 `assets/`。蓝图写入 `blueprint.json`，首次保存补
`project.json`；物理目录布局由宿主决定。

本扩展不替代纯叙事影片、BGM、低模 3D 或 ECS 游戏工具；它专注于视频承载的玩法交互。

## 宿主契约

发布时需要 `@forgeax/extension-platform@0.0.2` 与
`@forgeax/workbench-host@0.1.0`。宿主加载 `@forgeax/wb-game-video/host` 的 `host`
导出，并注入游戏工作区、版本、媒体与模型 capability。所有工具和扩展 HTTP 路由共享同一
`WorkbenchExtensionContext`；不支持根据 URL、进程环境、全局 active game 或工具参数选择游戏。
浏览器必须等待 nonce-bound handshake，并只使用 handshake 返回的游戏身份和端点。版本与游戏
组件是可选 capability；缺失时不得猜测或拼接备用 URL。
