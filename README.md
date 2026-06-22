# ForgeaX Studio — forgeax-server

[English](./README.md) · [简体中文](./README.zh-CN.md) · [↑ studio](https://github.com/ForgeaX-Games/forgeax-studio)

> **The runtime core — one Bun process that orchestrates the studio, hosts the agent kernel in-process, and bridges everything to the UI over HTTP + WebSocket.**

`@forgeax/server` is the single runtime process behind ForgeaX Studio. It listens on
**`:18900`** and is the UI's only entrypoint. It spawns and supervises the engine and interface
subprocesses, loads the agent kernel (`forgeax-cli`) **in-process**, exposes the entire
Workbench API, and runs the filesystem/HMR bridge that turns the agent's code edits into a live
preview. No Docker, no microservice sprawl — one process, started in seconds.

## Why it matters

- **One process, instant boot.** The whole studio runtime is a single Bun + Hono server. There
  is no instance-provisioning step and no container to wait on — `start.sh` and you're live.
- **The agent kernel runs in-process.** Rather than talking to a separate agent daemon over a
  socket, the server imports the kernel directly and streams its `ChatEvent`s straight to the UI
  as SSE / WebSocket. Fewer moving parts, lower latency, one place to reason about a turn.
- **Filesystem is the source of truth.** `/api/files` (read/write) plus a chokidar watcher that
  pushes `file-event`s over WebSocket is the seam that makes the loop work: Forge writes game
  code to disk, the watcher notifies, the engine hot-reloads, you see it. The same disk-SSOT seam
  keeps Play and Edit in sync.
- **Process supervision.** The orchestrator spawns the interface (`:18920`) and engine
  (`:15173`) subprocesses and watches their liveness, restarting as needed — so a crash in one
  surface doesn't take the session down.
- **One source, three runtime forms.** The same server code runs as web/dev, desktop/dev, and a
  packaged desktop app purely by injected environment (resource root / project root / ports) —
  no separate builds of the runtime.

## Architecture (src/)

| Area | Role |
|:--|:--|
| `core` / `runtime` | server bootstrap, lifecycle, subprocess orchestration |
| `agent` / `agents` / `cli` / `cli-providers` | in-process host of the agent kernel + driver layer |
| `api` | the Hono HTTP routes (the Workbench + Studio API surface) |
| `ws` | WebSocket handlers (chat-stream / file-event / agent-status push) |
| `fs` | `/api/files` read/write + chokidar watcher → `file-event` |
| `packs` / `plugins` / `skills` / `commands` / `tools` / `kits` | the capability + content surfaces the UI and agents consume |
| `events` / `message` / `ledger` / `context-window` | event bus, turn messages, the execution ledger |
| `brand` / `prefs` / `permissions` / `observatory` | branding, settings, permissioning, telemetry |

## The API surface (selected)

`/api/chat` · `/api/sessions` · `/api/threads` · `/api/files` · `/api/projects` · `/api/assets`
· `/api/game-assets/:slug/*` · `/api/workbench` · `/api/packs` · `/api/plugins` · `/api/skills`
· `/api/commands` · `/api/tools` · `/api/llm` · `/api/brand` · `/api/usage` · `/api/health`.
Everything the UI needs is one HTTP/WS endpoint away.

## Key concepts

`:18900` (the only entrypoint) · in-process agent kernel → `ChatEvent` → SSE/WS · disk-SSOT
file bridge + chokidar `file-event` · orchestrated subprocesses (engine `:15173`, interface
`:18920`) · env-injected runtime forms (web / desktop / packaged).

## Run (standalone)

```bash
bun install
bun dev        # server on :18900 (spawns interface :18920 + engine :15173)
```

In normal use you don't run this directly — the studio's `start.sh` does, from the repo root.

---

Part of the **ForgeaX Studio** monorepo. This repo is a submodule of
[`ForgeaX-Games/forgeax-studio`](https://github.com/ForgeaX-Games/forgeax-studio) — clone that
with `--recurse-submodules` to run the full studio. License: Apache-2.0.
