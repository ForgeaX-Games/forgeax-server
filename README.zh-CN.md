# ForgeaX Studio — forgeax-server

[English](./README.md) · [简体中文](./README.zh-CN.md) · [↑ studio](https://github.com/ForgeaX-Games/forgeax-studio)

> **运行时核心 —— 一个 Bun 进程,编排整个 studio、进程内托管 agent 内核,并通过 HTTP + WebSocket 把一切桥接到 UI。**

`@forgeax/server` 是 ForgeaX Studio 背后唯一的运行时进程。它监听 **`:18900`**,是 UI 的唯一入口。
它拉起并守护 engine 与 interface 子进程,**进程内**装载 agent 内核(`forgeax-cli`),暴露完整的
Workbench API,并运行把 agent 的代码改动变成实时预览的文件系统 / HMR 桥。无需 Docker、没有微服务
的繁杂——一个进程,几秒起完。

## 它为何重要

- **一个进程,即时启动。** 整个 studio 运行时就是单个 Bun + Hono server。没有实例供给步骤,没有
  容器要等——`bun fx start` 一下就活了。
- **agent 内核进程内运行。** server 不是通过 socket 跟一个独立 agent 守护进程对话,而是直接 import
  内核,把它的 `ChatEvent` 以 SSE / WebSocket 直接流给 UI。更少的活动部件、更低的延迟、推理一个
  回合只需看一处。
- **文件系统即真相。** `/api/files`(读写)加上一个把 `file-event` 经 WebSocket 推送的 chokidar
  watcher,正是让闭环成立的接缝:Forge 把游戏代码写到磁盘,watcher 通知,引擎热重载,你立刻看到。
  同一套 disk-SSOT 接缝让 Play 与 Edit 保持同步。
- **进程守护。** orchestrator 拉起 interface(`:18920`)与 engine(`:15173`)子进程并监控存活,
  按需重启——因此某个界面崩溃不会拖垮整个会话。
- **一份源,三种运行形态。** 同一份 server 代码,仅靠注入的环境变量(资源根 / 项目根 / 端口)即可
  以 web/dev、桌面/dev、打包桌面 app 运行——运行时无需分别构建。

## 架构(src/)

| 区域 | 职责 |
|:--|:--|
| `core` / `runtime` | server 引导、生命周期、子进程编排 |
| `agent` / `agents` / `cli` / `cli-providers` | 进程内托管 agent 内核 + driver 层 |
| `api` | Hono HTTP 路由(Workbench + Studio 的 API 表面) |
| `ws` | WebSocket 处理器(chat-stream / file-event / agent-status 推送) |
| `fs` | `/api/files` 读写 + chokidar watcher → `file-event` |
| `packs` / `plugins` / `skills` / `commands` / `tools` / `kits` | UI 与 agent 消费的能力 + 内容表面 |
| `events` / `message` / `ledger` / `context-window` | 事件总线、回合消息、执行账本 |
| `brand` / `prefs` / `permissions` / `observatory` | 品牌、设置、权限、遥测 |

## API 表面(节选)

`/api/chat` · `/api/sessions` · `/api/threads` · `/api/files` · `/api/projects` · `/api/assets`
· `/api/game-assets/:slug/*` · `/api/workbench` · `/api/packs` · `/api/plugins` · `/api/skills`
· `/api/commands` · `/api/tools` · `/api/llm` · `/api/brand` · `/api/usage` · `/api/health`。
UI 所需的一切,都只隔着一个 HTTP/WS 端点。

## 关键概念

`:18900`(唯一入口)· 进程内 agent 内核 → `ChatEvent` → SSE/WS · disk-SSOT 文件桥 + chokidar
`file-event` · 被编排的子进程(engine `:15173`、interface `:18920`)· 环境注入的运行形态
(web / 桌面 / 打包)。

## 运行(独立)

```bash
bun install
bun dev        # server 在 :18900(拉起 interface :18920 + engine :15173)
```

正常使用下你不直接运行它——studio 的 `bun fx start` 会在仓库根目录代劳。

---

本仓是 **ForgeaX Studio** 的一个子模块,隶属
[`ForgeaX-Games/forgeax-studio`](https://github.com/ForgeaX-Games/forgeax-studio) ——
用 `--recurse-submodules` 克隆超级仓即可运行完整 studio。许可:Apache-2.0。
