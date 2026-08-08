/** Semantic browser for the live ForgeaX editor UI — the agent walks the product
 *  the way a person does, one visible step at a time, and every step is a call to
 *  a door the product already publishes.
 *
 * FIVE VERBS: `look` (what is on screen), `open` (go one level deeper AND make it
 * visible), `act` (one op through the gateway), `find` (locate on the static
 * function table), `verify` (once per QA round, check the OUTPUT against the world).
 *
 * An earlier revision also carried `back`/`whereami` over a per-session focus
 * stack, plus a rev/selection/layout staleness check before every leaf. A 38-call
 * production trace killed all of it: `back` was never called, `whereami` never
 * once succeeded, and the staleness check fired zero times while costing an extra
 * relay round-trip on every entity read and every act — and it was a fake CAS
 * anyway, since calibrate and dispatch are separate HTTP calls with a window in
 * between. If real staleness protection is ever wanted, pass `expectedRev` into
 * the page program so the compare happens inside one page turn.
 *
 * `verify` is NOT that check coming back. The dead one ran BEFORE every leaf and
 * asked "is my view stale?" — per-step, unconditional, and it never once fired.
 * This one runs ONCE at the end of a QA round and asks a question no per-step
 * return can answer: "does what I am about to TELL THE USER match what the world
 * actually holds?" The 2026-08-04 trace that motivates it had 40 calls and ZERO
 * failures while the user's tree never changed colour — every per-step check
 * passed, because every step really did land somewhere. Only a round-end check
 * against the ledger, the disk state and the visible-change column catches that.
 * Cost discipline is structural, not a prompt: with no act/open since the last
 * verify it returns immediately without touching the relay, so over-calling is
 * free — the opposite failure mode from the one that killed the staleness check.
 *
 * TWO DOORS, because there are two publishers. Shell-level moves (activity rail,
 * workspace mode) go through the interface's own dual-modality UI surface bus:
 * server-side, mode-independent, running the SAME handler a human click runs.
 * Editor-level reads and writes go through the editor's gateway relay. This is not
 * a workaround for the relay — it is each layer projecting what it already
 * publishes. (It does also sidestep a real coupling: the relay executor is an
 * Update system on the editor world, so leaving scene mode unmounts it and every
 * relay call then hangs to its timeout. Measured 2026-08-04: scene 24ms → AI
 * workspace 25s timeout → back to scene 24ms.)
 *
 * TRUST-GATE CONTRACT: the gate classifies tool names by SUBSTRING, and this name
 * already contains `edit`. Measured, not assumed (2026-08-04): `editor_ui_browse`
 * classifies as `write` — own tier → allow, imported tier → fail-closed deny for
 * want of a scopable path. An earlier version of this comment claimed the tool sat
 * in the `other` bucket; it never did. Renaming still matters, just in the other
 * direction: adding `eval`, `delete`, or an exec word (`sh`, `run`, `command`) moves
 * it into a bucket that asks or denies on the OWN tier too — which is the tier the
 * product actually runs on, so that change would be felt immediately.
 *
 * KNOWN DEBT: the page programs below are JS built as template strings — no type
 * checking, no lint, only a test asserting each one parses. That is the right
 * trade while the recipes still change daily (hand-walked against the live editor
 * 2026-08-03/04); it stops being the right trade the moment a second team needs to
 * reuse them. Then: real modules injected once into a `__uiBrowse` namespace.
 */
import type { HostToolRunCtx, HostToolSpec } from '@forgeax/orchestrator/orchestration-seams';
import { dispatchAndWait, getSurfaceSnapshot, listSurfaces } from '@forgeax/orchestrator/api/bus';
import { catalogAll } from '@forgeax/orchestrator/kernel/action-catalog';
import { findVisibleDoor } from '@forgeax/orchestrator/kernel/action-door';
import { getExtensionSnapshot } from '@forgeax/orchestrator/extensions/registry';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  relayBaseUrl,
  relayEval,
  type EditorGatewayHostToolsDeps,
} from './editor-gateway-host-tools';

type BrowseVerb = 'look' | 'open' | 'act' | 'find' | 'verify';

/** The shell's own AI door (dual-modality UI surfaces), used for everything that
 *  lives OUTSIDE the editor viewport: the activity rail, the workspace mode.
 *
 *  Why a second transport instead of more page JS: the editor relay's executor —
 *  `__forgeaxEval`, the bridge socket and the queue drain — is registered as an
 *  Update system on the EDITOR world (edit-runtime ViewportComponent). Leaving
 *  scene mode unmounts the viewport, the world stops ticking, and every relay
 *  eval then hangs to its timeout while the socket still reports "connected".
 *  Measured 2026-08-04: scene 24ms → AI workspace 25s timeout → back to scene
 *  24ms. So the one action a user most wants to watch ("open the agents rail")
 *  is precisely the action that would blind a relay-only tool.
 *
 *  The surface bus has none of that coupling: it is server-side, mode
 *  independent, runs the SAME handler a human click runs (ActivityRail's
 *  `selectTab` / `setMode`), and every dispatch lands on the event bus ledger. */
interface ShellSurfaceSlim {
  id: string;
  layer?: string;
  actions?: Array<{ id: string; exposedToAI?: boolean; argsSchema?: unknown }>;
  /** 最近仍在轮询这个 surface 的页面数(orchestrator 按轮询者 id 统计)。 */
  pages?: number;
}

interface ShellDeps {
  dispatch?: (
    surfaceId: string,
    action: string,
    args: unknown,
    timeoutMs?: number,
  ) => Promise<{
    ok: boolean;
    error?: string;
    result?: unknown;
    timedOut?: boolean;
    token?: string;
    /** 命令**可能**已经开始执行。缺省 = 未知,**不是**"确定没开始" —— 两者后果相反:
     *  未知不许回落重派(会把同一命令跑两次),确定没开始才可以。 */
    started?: boolean;
  }>;
  snapshot?: (surfaceId: string) => unknown;
  list?: () => ShellSurfaceSlim[];
  /** ActionCatalog(ui_invoke 的动作清单)。find 用它亮出 headless 能力。 */
  actions?: () => ReadonlyArray<{ id: string; title?: string; description?: string }>;
  /** 已安装 workbench 插件全量(extensions registry)。find 用它揪出"孤儿界面"。 */
  plugins?: () => ReadonlyArray<{ id: string; workbenchId?: string; label: string; hidden?: boolean }>;
}

/** 默认实现:进程内读 extensions registry,把 manifest displayName 拍平成可匹配文本。 */
function installedWorkbenchPlugins(): Array<{ id: string; workbenchId?: string; label: string; hidden?: boolean }> {
  try {
    const snap = getExtensionSnapshot();
    const names = new Map<string, string>();
    for (const wrapper of snap.manifests as Array<{ manifest?: { id?: unknown; displayName?: unknown } }>) {
      const manifest = wrapper.manifest;
      if (!manifest || typeof manifest.id !== 'string') continue;
      const dn = manifest.displayName;
      const label = typeof dn === 'string'
        ? dn
        : dn && typeof dn === 'object'
          ? Object.values(dn as Record<string, unknown>).filter((value): value is string => typeof value === 'string').join(' / ')
          : manifest.id;
      names.set(manifest.id, label || manifest.id);
    }
    return (snap.kinds.workbench as Array<{ extensionId: string; workbenchId: string; hidden?: boolean }>).map((entry) => ({
      id: entry.extensionId,
      workbenchId: entry.workbenchId,
      label: names.get(entry.extensionId) ?? entry.extensionId,
      ...(entry.hidden ? { hidden: true } : {}),
    }));
  } catch {
    return [];
  }
}

export interface EditorUiBrowseDeps extends EditorGatewayHostToolsDeps {
  shell?: ShellDeps;
}

/** THE GENERIC HALF — this is the part another team copies.
 *
 *  A surface publishes three things when it mounts: an id, a snapshot, and its
 *  AI-callable actions with their argsSchema. That is already a complete
 *  capability tree for that layer: branch = surface, content = snapshot, leaves =
 *  actions. Nothing below invents names, hardcodes an id, or knows what any
 *  particular surface means — a team that registers a surface with `useSurface()`
 *  gets an agent-drivable UI for free, and their argsSchema is the contract.
 *
 *  `open('rail:...')` further down is SUGAR over this, not a second mechanism:
 *  it is ~25 lines that know one product fact (host.sidebar publishes `entries`
 *  and activates them with `selectTab`). Read the generic half for the pattern;
 *  read the sugar for how much local knowledge a nice alias costs. */
function shellSurfaces(deps: EditorUiBrowseDeps): ShellSurfaceSlim[] {
  const list = deps.shell?.list ?? listSurfaces;
  try {
    return (list() as ShellSurfaceSlim[]).filter((surface) => typeof surface?.id === 'string');
  } catch {
    return [];
  }
}

/** AI-callable actions only: a surface may keep some actions human-only. */
function aiActions(surface: ShellSurfaceSlim): Array<{ id: string; argsSchema?: unknown }> {
  return (surface.actions ?? []).filter((action) => action?.exposedToAI !== false);
}

/** 有几个页面在听同一个 surface。>1 时这扇门的落点是不确定的:surface id 是
 *  "这类界面"的名字而不是"哪个页面"的名字,两个 ForgeaX 标签页共用同一条 pending
 *  队列和同一份 snapshot —— 派发落在哪一页取决于谁先轮询到,而回读 snapshot 又
 *  必然"验证成功"(那份 snapshot 正是执行了动作的那一页 PUT 上来的)。于是工具会
 *  向用户断言一个他根本看不见的变化(2026-08-04 事故的同一个病、另一扇门)。
 *
 *  这里只做**检测**:知道有几页 ≠ 知道用户在看哪一页(那需要页面上报焦点 + 按页
 *  分队列,是协议级改动)。检测到多页就把断言降级成"我不能确定是哪一页动了"。 */
function multiPageWarning(deps: EditorUiBrowseDeps, surfaceId: string): string | null {
  const pages = shellSurfaces(deps).find((surface) => surface.id === surfaceId)?.pages;
  if (typeof pages !== 'number' || pages <= 1) return null;
  return `⚠️ 现在有 ${pages} 个 ForgeaX 页面同时连着,而这扇门不带页面身份 ——`
    + '这次动作**可能执行在用户没在看的那一页上**,回读到的状态变化也可能来自那一页。'
    + '**不要向用户声称界面已经变了**,如实告诉他:检测到多个页面,无法确认是哪一个响应了,'
    + '请他只保留一个 ForgeaX 页面并刷新,然后重试。';
}

function readSurfaceSnapshot(deps: EditorUiBrowseDeps, surfaceId: string): unknown {
  const read = deps.shell?.snapshot ?? getSurfaceSnapshot;
  try {
    return read(surfaceId) ?? null;
  } catch {
    return null;
  }
}

/** Dispatch any action any surface published, then wait for that surface's OWN
 *  snapshot to move before claiming anything changed.
 *
 *  The settle wait is not politeness: the ack fires inside the action handler,
 *  BEFORE React re-renders and PUTs the new snapshot, so reading it on the next
 *  line reliably returns the pre-change state and we would report a false
 *  "nothing happened" for a move the user just watched land. */
async function dispatchShellAction(
  deps: EditorUiBrowseDeps,
  surfaceId: string,
  action: string,
  args: unknown,
  settled?: (snapshot: unknown) => boolean,
): Promise<{ ok: true; before: unknown; after: unknown; reached: boolean; token?: string } | BrowseFailure> {
  const before = readSurfaceSnapshot(deps, surfaceId);
  const send = deps.shell?.dispatch ?? dispatchAndWait;
  let acked: Awaited<ReturnType<typeof send>>;
  try {
    acked = await send(surfaceId, action, args, SHELL_DISPATCH_TIMEOUT_MS);
  } catch (error) {
    return failure('SHELL_DISPATCH_FAILED', `派发到 ${surfaceId}.${action} 失败:${error instanceof Error ? error.message : String(error)}`);
  }
  if (!acked.ok) {
    const fail = failure(
      'SHELL_DISPATCH_FAILED',
      `${surfaceId}.${action} 没有回执${acked.timedOut ? '(超时)' : `:${acked.error ?? '未知原因'}`}。`
      + '动作已上 ledger 但界面未必变了 —— 不要向用户声称它生效了。',
    );
    // 超时 ≠ 没执行:页面可能已在租约内取走并跑完,只是 ack 没赶上。消费方(咽喉
    // 回落判定)必须能区分"确定没跑"(页面回执了错误)与"跑没跑未知"(超时)。
    fail.error.timedOut = acked.timedOut === true;
    // started 与 timedOut 同类:都决定"能不能回落重试"。此前只有专用的 menubar invoke
    // 路径消费它,通用 act 路径漏了 —— 而同一个 host.menubar/invoke 两条路都能到达,
    // 于是走通用路径时"已开始执行"的信号凭空消失,上游照样回落重派(2026-08-07,
    // 由本轮新增的钉子发现)。**有值才带键**:缺席=未知,不能补成 false。
    if (acked.started !== undefined) fail.error.started = acked.started;
    // token 是 ui-events.jsonl 里这次派发那条记录的唯一键;超时时它是"页面到底
    // 跑没跑"唯一能回查的线索,失败体也必须带。
    if (acked.token) fail.error.token = acked.token;
    return fail;
  }
  const reachedBy = settled ?? ((snapshot: unknown) => JSON.stringify(snapshot) !== JSON.stringify(before));
  let after = readSurfaceSnapshot(deps, surfaceId);
  for (let waited = 0; waited < SHELL_SETTLE_TIMEOUT_MS && !reachedBy(after); waited += SHELL_SETTLE_POLL_MS) {
    await new Promise((resolve) => setTimeout(resolve, SHELL_SETTLE_POLL_MS));
    after = readSurfaceSnapshot(deps, surfaceId);
  }
  return { ok: true, before, after, reached: reachedBy(after), ...(acked.token ? { token: acked.token } : {}) };
}

/** The one product fact the rail sugar is allowed to know. */
const SHELL_SURFACE = 'host.sidebar';
/** The menubar's own projection: snapshot = menu tree, `invoke` = the same
 *  commands.execute a human click runs (Radix items ignore synthetic DOM
 *  events — measured 2026-08-04: click / pointer sequence / focus+Enter all
 *  no-ops — so the ONLY correct execution door from outside the page is the
 *  command bus behind the item, which is exactly what invoke dispatches). */
const MENUBAR_SURFACE = 'host.menubar';

interface MenuTreeNode {
  id: string;
  label: string;
  kind: 'command' | 'submenu' | 'placeholder';
  commandId?: string;
  /** 派发给 commands.execute 的参数(投影里带)—— 面板开关靠 args.id 认面板。 */
  args?: unknown;
  keybinding?: string;
  dynamic?: boolean;
  children?: MenuTreeNode[];
}

function readMenuTree(deps: EditorUiBrowseDeps): Record<string, MenuTreeNode[]> | null {
  const read = deps.shell?.snapshot ?? getSurfaceSnapshot;
  try {
    const raw = read(MENUBAR_SURFACE) as { menus?: unknown } | null;
    if (!raw || typeof raw !== 'object' || !raw.menus || typeof raw.menus !== 'object') return null;
    return raw.menus as Record<string, MenuTreeNode[]>;
  } catch {
    return null;
  }
}
const SHELL_DISPATCH_TIMEOUT_MS = 8_000;
/** How long to let the shell's published snapshot catch up with an acked action
 *  before reporting that nothing visibly changed. */
const SHELL_SETTLE_TIMEOUT_MS = 2_500;
const SHELL_SETTLE_POLL_MS = 100;

interface ShellState {
  mode: 'scene' | 'ai';
  workbenchTab: string;
  entries: Array<{ id: string; label: string; kind?: string }>;
}

/** Read what the shell itself publishes: current mode, current rail tab, and the
 *  rail's own entry list. This IS the shell's slice of the capability tree — no
 *  DOM scraping, no invented names, and it keeps working while the editor is
 *  unmounted. */
function readShell(deps: EditorUiBrowseDeps): ShellState | null {
  const read = deps.shell?.snapshot ?? getSurfaceSnapshot;
  let raw: unknown;
  try {
    raw = read(SHELL_SURFACE);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const snapshot = raw as { mode?: unknown; workbenchTab?: unknown; entries?: unknown };
  if (snapshot.mode !== 'scene' && snapshot.mode !== 'ai') return null;
  const entries = Array.isArray(snapshot.entries)
    ? snapshot.entries.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return [];
        const row = entry as { id?: unknown; label?: unknown; kind?: unknown };
        if (typeof row.id !== 'string' || !row.id) return [];
        return [{
          id: row.id,
          label: typeof row.label === 'string' && row.label ? row.label : row.id,
          ...(typeof row.kind === 'string' ? { kind: row.kind } : {}),
        }];
      })
    : [];
  return {
    mode: snapshot.mode,
    workbenchTab: typeof snapshot.workbenchTab === 'string' ? snapshot.workbenchTab : '',
    entries,
  };
}




type BrowseFailure = {
  ok: false;
  error: {
    code: string;
    hint: string;
    candidates?: Array<{ node: string; label: string; where: string }>;
    recoveryActions?: Array<{ node: string; label?: string }>;
    [key: string]: unknown;
  };
};

const mintedAssetGuids = new Map<string, Set<string>>();
/** Sessions that already received the static table in a look. The table is
 *  ~6KB — worth carrying exactly once per session, not on every glance. */
const staticTableSent = new Set<string>();
/** 每个会话最后一次见到的执行页身份。relay 只认最后连上的页面(last-connection-wins)
 *  且不带身份 —— 于是"agent 成功操作了一个没人在看的页面"完全静默。
 *  2026-08-04 实测:用户两次修改之间冒出第二个页面,第二刀落在别处,磁盘与屏幕都
 *  没有用户要的结果,而工具全程返回 ok。页面身份一变就必须喊出来。 */
const lastSeenRev = new Map<string, number>();
const lastSeenPage = new Map<string, string>();
/** 上一次 verify 的时刻 —— 本轮调用账从这里往后算。 */
const lastVerifyAt = new Map<string, number>();
/** 本轮有没有产生过实际动作。没有就不必再核一遍,让重复调用零成本。 */
const roundDirty = new Set<string>();
/** 本轮实际动过手的次数(内存计数,**独立于磁盘 metrics**)。
 *
 *  verify 的调用账全部来自 `.forgeax/ui-browse-metrics.jsonl`,而写入端整个包在
 *  `catch {}` 里(设计如此:诊断文件绝不能改变工具语义)。问题是**读端就是 verify
 *  的唯一账源**:项目根只读 / 磁盘满 / 路径被占 → 写入静默失败 → calls 为空 →
 *  concerns 为空 → verify 在零条记录上宣告"每一步都观察到了界面变化"。防幻觉的
 *  最后一道防线自己 fail-open(2026-08-06 自探)。有了这个内存计数,"账是空的"
 *  与"这一轮什么都没干"就能分开。 */
const roundActCount = new Map<string, number>();
/** Ops the gateway correlates by caller-minted requestId (gateway.ts:1158). Kept
 *  in sync with that list — a kind missing here is dispatched without a requestId
 *  and can never be awaited to a terminal state.
 *
 *  ⚠️ 这是一张**手抄的清单**,没有 parity 校验 —— 网关那边新增一个异步 kind 而这里
 *  没跟上,症状是**静默 ok:true 而操作还在跑**,不是编译错误。2026-08-06 用户实测已
 *  经付过一次学费:`createMaterial` 用的是另一套完成契约(不进 operationRun,而是
 *  editor-core 的目录可见性屏障),两边都没盖到它,于是目录提交失败只进了控制台,
 *  工具照回 ok:true,agent 对用户说"已经调暗并保存好了"。
 *
 *  所以 compileAct 里对 createMaterial 单独做了**目录回读**把关。新增异步 kind 时:
 *  先问它属于哪套完成契约(operationRun / 目录屏障 / 别的),再决定加进这张表还是
 *  写一条专门的把关 —— 只往表里加名字不一定盖得住。 */
const ASYNC_OPERATION_KINDS = new Set([
  'saveDocToDisk',
  'deleteSourceFile',
  'importAsset',
  'reimportAsset',
  'addSceneAssetToScene',
  'previewImportedScene',
  'promoteImportedScene',
  'bindAssetRef',
  'createSceneFile',
  'setDefaultScene',
  'deleteScene',
  'captureFrame',
]);

const DESCRIPTION =
  "Drive ForgeaX the way the user does: locate a function on the static map, then walk to it step by visible step through each layer's own door. "
  + "WORKFLOW: find(query) FIRST — one call returns the static function table (full menu tree incl. submenus, rail tabs, surface actions) with the exact chain to open; "
  + "then open('menu:<top>/<item>/...') walks the whole static prefix in ONE call, visibly expanding each level. If the chain ends on a command item it executes through the menu's own command bus (same entry a human click uses) and the menus close. "
  + "Dynamic content (recent games, entities, assets) is not in the table: expand its parent level first (e.g. open('menu:file/\u6253\u5f00\u6700\u8fd1') reveals the recent-game list), then append the revealed text to the chain and call open again. "
  + "Other opens: panel:<id-or-title> (panel:ep:assets lists every asset with a readable identity — colour for materials — and who uses it; never eval the catalog), entity:<handle-or-name>, rail:<tab-or-label>. "
  + "look = what is on screen right now, plus the entity roster (names!) and — on its FIRST call each session — the full static table, so you rarely need find separately. "
  + "act(op) = one EditorOp through the gateway as origin 'ai' (undo/ledger), or {surface, action, args} for any published surface action. "
  + "MULTI-STEP EDITS: submit ONE act with {kind:'transaction', label:'...', commands:[op, op, ...]} — the gateway's own batch primitive: atomic (all or none), ONE undo entry, one repaint. Prefer it whenever a task changes more than one field or entity WITH DOCUMENT OPS: setComponent, spawnEntity, destroyEntity, duplicateEntity, rename, reparent, setHidden, addComponent, removeComponent, setSceneOverride, removeSceneOverride, instantiateSceneAsset, applyVisualQualityPreset, destroyAsset, renameAsset, duplicateAsset. "
  + "It CANNOT carry asset-binding or disk ops — bindAssetRef, createMaterial, saveDocToDisk, importAsset and friends run in a different domain and the gateway rejects the whole batch with UNKNOWN_OP (nothing is applied, so the refusal is safe but the batch is wasted). Recolouring N objects is therefore N separate acts, each individually undoable; say so to the user up front, because undoing that job takes N undos rather than one. "
  + "act's return (rev, after, ledger) IS the verification for editor edits — do NOT re-open the entity, enter Play, read consoles or take screenshots to confirm a field change. "
  + "open('entity:...') walks the exact human path: SELECTS the entity (hierarchy highlight) AND brings the 物体属性 inspector panel to front, then returns per-field ready-to-submit `affordance.op` — the same fields the user now sees on screen; copy, edit the value, submit with act and the panel updates live. "
  + "PERSISTENCE: a successful act lands in the live document and undo ledger, not on disk; the scene/pack file lags until someone saves — that is normal. Persist with act({kind:'saveDocToDisk'}). Never read or edit scene/pack files to check or force anything. "
  + "Every open verifies visually and returns `visible_change`; only claim something opened when it is non-null. "
  + "verify() = ONCE per QA round, right before you report to the user — never per step. It answers what a per-step return cannot: how many steps failed, which ones reported success but never showed a visible change, what the ledger actually holds, whether the edits are still unsaved, and whether you stayed in one world. Compare its `concerns` against the sentences you are about to say; if they disagree, change what you say. With no act/open since the last verify it returns instantly and costs nothing, so there is no reason to skip it. "
  + "editor_gateway_eval is a last-resort escape hatch, not a first choice.";

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    verb: { enum: ['look', 'open', 'act', 'find', 'verify'] },
    node: { type: 'string' },
    query: { type: 'string' },
    op: { type: 'object' },
    includeTransient: { type: 'boolean' },
  },
  required: ['verb'],
  additionalProperties: false,
} as const;

/** 唯一一处"不要绕过这扇门"的措辞。之前它在 5 个地方各写了一遍,措辞还各不相同
 *  —— 提示词一旦复制就会各自漂移。结构性约束(persistence.saveOp / recoveryActions /
 *  断路器)才是主防线,这句话是最后一层;既然是最后一层,就只该有一份。 */
const NO_SIDE_DOOR =
  '不要改磁盘上的场景/资产文件,不要开自动化浏览器,不要用系统级点击去操作界面 ——'
  + '那些改动不进账本、用户撤销不掉,而且再开一个页面只会把执行权抢得更乱。';

function failure(code: string, hint: string): BrowseFailure {
  return { ok: false, error: { code, hint } };
}

/** "回到编辑器"是工作区模式切换,不是 rail tab —— shell 把它作为 `setMode` 动作
 *  发布,而不是 entries 里的一项。这两个字面量都来自 shell 自己:`editor` 是 rail
 *  按钮的 data-rail-action 值,`scene` 是 setMode argsSchema 的枚举值。**不要**往这里
 *  加中文同义词——那就成了会腐烂的映射表。泛化 shell 门(按 action 名直接派发)之后
 *  这个集合会整体消失。 */
const EDITOR_RAIL_ALIASES = new Set(['editor', 'scene']);

/** Guard every editor-side verb: the relay only answers while the editor viewport
 *  is mounted, so refuse in one round-trip with the way back instead of letting
 *  the caller hang for the relay timeout. */
function editorForegroundFailure(deps: EditorUiBrowseDeps): BrowseFailure | undefined {
  const shell = readShell(deps);
  // No shell surface registered (headless probe, older build) — say nothing and
  // let the relay itself answer, exactly as before this door existed.
  if (!shell || shell.mode === 'scene') return undefined;
  return {
    ok: false,
    error: {
      code: 'EDITOR_NOT_FOREGROUND',
      // 2026-08-06 外审 B1:不再指路 open('rail:editor') —— rail 门无发布者,那条
      // 路必死。此闸只有在 shell 面真实注册时才会触发(readShell 非空),届时 rail
      // 门也随之复活,可以恢复指路;在那之前如实请用户自己点。
      hint: `工作区当前在 AI 侧(rail tab: ${shell.workbenchTab || '未知'}),编辑器视口没有挂载,读写编辑器的通道此刻不通。`
        + '两条路都不丢改动:①请用户点左上 rail 的 Scene 页签(他看得见);'
        + '②你自己用 ui_act_app_set_mode({mode:"scene"}) 后台切 —— 活的,但屏幕不展示切换过程,用了要如实说明。先问用户选哪条。',
      retryable: true,
      shell: { mode: shell.mode, workbenchTab: shell.workbenchTab },
    },
  };
}

/** Resolve a rail query against the rail's OWN published entries. Matching uses
 *  only text the shell registered (tab id + label). */
function resolveRailTarget(
  shell: ShellState,
  queryText: string,
): { action: 'setMode'; args: { mode: 'scene' }; label: string }
  | { action: 'selectTab'; args: { tab: string }; label: string }
  | BrowseFailure {
  const needle = queryText.trim().toLocaleLowerCase();
  if (EDITOR_RAIL_ALIASES.has(needle)) {
    return { action: 'setMode', args: { mode: 'scene' }, label: '编辑器' };
  }
  const exact = shell.entries.filter(
    (entry) => entry.id.toLocaleLowerCase() === needle || entry.label.toLocaleLowerCase() === needle,
  );
  const matches = exact.length
    ? exact
    : shell.entries.filter(
        (entry) => entry.id.toLocaleLowerCase().includes(needle) || entry.label.toLocaleLowerCase().includes(needle),
      );
  if (matches.length > 1) {
    return {
      ok: false,
      error: {
        code: 'AMBIGUOUS_REFERENT',
        hint: 'rail 名称命中多个候选;请指定其一或问用户',
        candidates: matches.map((entry) => ({ node: `rail:${entry.id}`, label: entry.label, where: '一步可达' })),
      },
    };
  }
  if (matches.length === 0) {
    return {
      ok: false,
      error: {
        code: 'NOT_FOUND',
        kind: 'rail',
        hint: `没有 rail 项匹配 ${queryText}`,
        candidates: shell.entries.map((entry) => ({ node: `rail:${entry.id}`, label: entry.label, where: '一步可达' })),
      },
    };
  }
  return { action: 'selectTab', args: { tab: matches[0]!.id }, label: matches[0]!.label };
}

/** Drive the rail through the shell's own door and then read the shell's own
 *  snapshot back, so `visible_change` reports what actually rendered rather than
 *  what we asked for. */
/** Resolve the invoke target for a leaf reached through `path` (labels).
 *  Static items resolve to their stable id; a leaf under a dynamic submenu has
 *  no id in the tree, so it goes as {parentId, label} and the page-side
 *  registry resolves it against the freshly evaluated dynamic children. */
function resolveInvokeTarget(
  tree: Record<string, MenuTreeNode[]> | null,
  path: string[],
  leafLabel: string,
): { itemId: string } | { parentId: string; label: string } | { label: string } {
  if (!tree) return { label: leafLabel };
  let level: MenuTreeNode[] | undefined = tree[path[0]!];
  let dynamicParent: MenuTreeNode | null = null;
  for (let index = 1; index < path.length - 1 && level; index++) {
    const segment: string = path[index]!;
    const node: MenuTreeNode | undefined = level.find((candidate) => candidate.label === segment || candidate.id === segment);
    if (!node) { level = undefined; break; }
    if (node.dynamic) dynamicParent = node;
    level = node.children;
  }
  // 精确优先;都不精确时取**最长**前缀。单趟 `find(a || b)` 会让先出现的短标签抢走
  // 长标签的叶子 —— 同层「复制」/「复制路径」/「复制 GUID」(en: Save / Save All)是
  // 真实存在的碰撞,而叶子文本带快捷键(MenuBar.tsx:274 把 combo 渲染在 menuitem 内),
  // 所以前缀分支是常态路径。问「复制路径」执行「复制」这种事必须在这里堵死。
  const leaf = level?.find((candidate) => candidate.label === leafLabel)
    ?? level?.filter((candidate) => leafLabel.startsWith(candidate.label))
      .sort((a, b) => b.label.length - a.label.length)[0];
  if (leaf) return { itemId: leaf.id };
  if (dynamicParent) return { parentId: dynamicParent.id, label: leafLabel };
  return { label: leafLabel };
}

/** 按稳定 itemId 在菜单投影里反查 commandId —— 只为让账本两侧同形,查不到就
 *  不带(账本里缺一个键,好过写一个猜的)。 */
function findMenuCommandId(tree: Record<string, MenuTreeNode[]> | null, itemId: string): string | undefined {
  if (!tree) return undefined;
  const walk = (nodes: MenuTreeNode[]): string | undefined => {
    for (const node of nodes) {
      if (node.id === itemId && typeof node.commandId === 'string') return node.commandId;
      const hit = node.children ? walk(node.children) : undefined;
      if (hit) return hit;
    }
    return undefined;
  };
  for (const nodes of Object.values(tree)) {
    const hit = walk(nodes);
    if (hit) return hit;
  }
  return undefined;
}

/** Walk `menu:a/b/c`: expand the static prefix visually in ONE relay hop; if the
 *  last segment is a command leaf, execute it through host.menubar.invoke (the
 *  human door) and close the menus. */
async function runOpenMenuChain(
  segments: string[],
  deps: EditorUiBrowseDeps,
): Promise<unknown> {
  const walked = await relayAsyncCode(compileMenuChain(segments), deps);
  if (isFailure(walked)) return walked;
  const result = walked as {
    path: string[];
    leaf: { text: string; disabled: boolean } | null;
    items: Array<{ text: string; sub: boolean; disabled: boolean }>;
    menusOpen: number;
  };
  if (!result.leaf) {
    return {
      ok: true,
      path: result.path,
      items: result.items,
      visible_change: `${result.path.join(' → ')} 已逐级展开,菜单保持打开`,
      hint: '要执行其中某一项,把它的文本接到链尾再调一次 open。',
    };
  }
  if (result.leaf.disabled) {
    return {
      ok: false,
      error: {
        code: 'ITEM_DISABLED',
        hint: `「${result.leaf.text}」当前是禁用/未接线的占位项,人也点不动它。`,
        candidates: result.items.filter((item) => !item.disabled)
          .map((item) => ({ node: `menu:${result.path.slice(0, -1).join('/')}/${item.text}`, label: item.text, where: '同层' })),
      },
    };
  }
  // 先合拢菜单,再执行命令。人点菜单项时 Radix 也是先关菜单再跑 onSelect;
  // 反过来(先执行后关)会让"关菜单"这一步落在命令产生的新界面上。
  const target = resolveInvokeTarget(readMenuTree(deps), result.path, result.leaf.text);
  // 派发体里带上解析到的 commandId(若已知),让 AI 这条记录与人点击那条同形 ——
  // 人记 { itemId, commandId },AI 只记 itemId 的话,同一个动作在账本里是两个名字,
  // 离线比对"人和 AI 做的是不是同一件事"还得回查菜单注册表(2026-08-05 实测)。
  const targetCommandId = 'itemId' in target
    ? findMenuCommandId(readMenuTree(deps), target.itemId)
    : undefined;
  const dispatchArgs = targetCommandId ? { ...target, commandId: targetCommandId } : target;
  const closedBefore = await relayAsyncCode(compileCloseMenus(), deps);
  const before = await relayAsyncCode(compileScreenFingerprint(), deps);
  const send = deps.shell?.dispatch ?? dispatchAndWait;
  // 不手抄一份形状 —— 手抄的迟早与正式契约漂移(2026-08-07:ShellDeps 扩了 started,
  // 这两处局部标注却把它挡回去了)。跟着 send 的真实返回类型走。
  let acked: Awaited<ReturnType<typeof send>>;
  try {
    acked = await send(MENUBAR_SURFACE, 'invoke', dispatchArgs, SHELL_DISPATCH_TIMEOUT_MS);
  } catch (error) {
    return failure('SHELL_DISPATCH_FAILED', `menubar.invoke 派发失败:${error instanceof Error ? error.message : String(error)}`);
  }
  if (!acked.ok) {
    // 2026-08-05 实测:两个页面同时在线时,invoke 会被租约派给"最先轮询到"的那个 ——
    // 可能是没 warm 过最近列表的冷页面,于是动态子项解析 not found。失败必须自带
    // 这条事实,否则 agent 只会看到一个莫名其妙的 not found 然后绕去别的工具。
    const manyPages = multiPageWarning(deps, MENUBAR_SURFACE);
    // 页面侧把"根本没启动"(解析不到 / 禁用)与"启动后才失败"分开标记 —— 后者
    // **绝不能**被上游当成"确定没执行"而回落无头路径重派一次:写了一半就抛错的
    // file.save、后置步骤失败的新建游戏都会因此跑两次(2026-08-06 自探)。
    // 只信结构化回执。**不留子串兜底** —— 留着等于错误文案仍然是隐式协议,
    // 下一个人不知道哪条才算数(2026-08-07 外审 N3)。
    const started = acked.started === true;
    const fail = failure('SHELL_DISPATCH_FAILED',
      started
        ? `menubar.invoke(${JSON.stringify(target)}) **已经开始执行但中途失败**:${acked.error}。`
          + '命令可能已经产生了部分效果 —— 不要重试、不要换别的路径重派(那会让它再跑一次);'
          + '先 look/verify 核对实际状态,再如实告诉用户哪一步没走完。'
        : `menubar.invoke(${JSON.stringify(target)}) 没有${acked.timedOut ? '在超时前回执 —— 命令跑没跑未知,不要重试也不要声称已执行,先 look 核对' : `成功:${acked.error ?? '未知原因'}。菜单项没有被执行 —— 不要向用户声称已执行`}。`);
    fail.error.timedOut = acked.timedOut === true;
    if (started) fail.error.started = true;
    if (acked.token) fail.error.token = acked.token;
    if (manyPages) fail.error.multiplePages = manyPages;
    return fail;
  }
  const menusOpen = !isFailure(closedBefore) && closedBefore && typeof closedBefore === 'object'
    ? (closedBefore as { menusOpen?: number }).menusOpen ?? null : null;

  // 命令执行成功 ≠ 用户看得见变化。面板/rail 早就做了回读校验,菜单命令叶子却一直
  // 靠推断下结论 —— 2026-08-04 用户实测:agent 说"已帮你打开快捷键面板",屏幕上
  // 什么都没有。指纹取两次,差异才是可见性的证据;没差异就如实说没看见。
  await new Promise((resolve) => setTimeout(resolve, SCREEN_SETTLE_MS));
  const after = await relayAsyncCode(compileScreenFingerprint(), deps);
  const changes = describeScreenChange(before, after);
  const trail = `已沿 ${result.path.join(' → ')} 走到「${result.leaf.text}」并执行(与人点击同一命令入口)`;
  // 菜单链尤其容易被劈开:可见的逐级展开走 relay(认最后连上的页面),而命令执行
  // 走 menubar 门(认最先轮询到的页面)—— 两条规则不一样,可能落在不同的两页上。
  const manyPages = multiPageWarning(deps, MENUBAR_SURFACE);
  // 前后指纹落在不同页面 —— 差异全是伪差异,但病因也不是"命令没接线"。分开说。
  const swapped = fingerprintPageSwap(before, after);
  return {
    ok: true,
    path: result.path,
    invoked: (acked.result as { invoked?: string; commandId?: string } | undefined) ?? null,
    // token = ui-events.jsonl 里这次派发那条记录的唯一键。不带的话,agent 侧工具
    // 结果与人机同账文件之间除时间戳外无键可连(2026-08-06 实测 0 命中)。
    ...(acked.token ? { token: acked.token } : {}),
    visible_change: changes && !manyPages ? `${trail};${changes}` : null,
    ...(manyPages ? { multiplePages: `${manyPages} 注意:菜单的可见展开与命令的实际执行走的是两条不同的选页规则,这一次可能被劈在两个页面上。` } : {}),
    ...(swapped
      ? { hint: `${trail},但取前后指纹的是**两个不同的页面**(中继认最后连上的那个,不带身份)——`
          + '前后对比因此不成立,这次**测不到**可见性,而不是"没有变化"。'
          + '不要向用户声称已生效,也不要说这一项没接线;请他只保留一个 ForgeaX 页面后再核。',
          measurable: false }
      : changes
        ? {}
        : { hint: `${trail},但执行前后界面指纹没有差异 —— 不要向用户声称"已打开/已改变"。`
            + '可能是该命令只改了内部状态、目标本来就是当前状态,或这一项虽然可点却尚未真正接线。'
            + '如实告诉用户你没有观察到界面变化,并请他确认。' }),
    ...(menusOpen === 0 ? {} : { menusStillOpen: menusOpen }),
  };
}

/** 前后两趟指纹是不是落在了不同页面上。true = 这次根本没测到,而非"没变化"。 */
function fingerprintPageSwap(before: unknown, after: unknown): boolean {
  if (isFailure(before) || isFailure(after)) return false;
  const a = (before ?? {}) as ScreenFingerprint;
  const b = (after ?? {}) as ScreenFingerprint;
  return typeof a.pageId === 'string' && typeof b.pageId === 'string' && a.pageId !== b.pageId;
}

/** 命令落点渲染需要一帧以上;取后置指纹前给界面一点时间。 */
const SCREEN_SETTLE_MS = 700;

interface ScreenFingerprint {
  overlay?: string | null;
  dialogs?: number;
  fullscreen?: boolean;
  panels?: string[];
  tab?: string | null;
  menus?: number;
  /** 世界代际。编辑类菜单命令(撤销/复制/删除)只动它,不动屏幕结构。 */
  rev?: number | null;
  /** 选中集的序列化形态。选中变化对用户完全可见(层级树高亮 + 属性面板换内容),
   *  但同样不改浮层/面板集合。 */
  selection?: string | null;
  /** 取指纹的那个页面的身份。relay 是 last-connection-wins 且不带身份 —— 前后两趟
   *  可能落在**不同页面**上,那时 rev/selection/面板集的差异全部是伪差异。 */
  pageId?: string | null;
}

/** 把前后指纹差异翻成人话;完全没差异 → null(=不能声称可见)。 */
function describeScreenChange(before: unknown, after: unknown): string | null {
  if (isFailure(before) || isFailure(after)) return null;
  const a = (before ?? {}) as ScreenFingerprint;
  const b = (after ?? {}) as ScreenFingerprint;
  // 前后两趟落在不同页面 = 一切差异都是伪差异。relay 认最后连上的页面且不带身份,
  // 用户中途开第二个标签页就会这样。尤其是 rev:它在两个页面之间本来就不同,
  // 拿来当"场景内容已改变"的证据 = 对一条什么都没干的命令宣称成功
  // (2026-08-06 自探;rev 是同日新加的判据,这个洞是随它一起开的)。
  if (typeof a.pageId === 'string' && typeof b.pageId === 'string' && a.pageId !== b.pageId) return null;
  const notes: string[] = [];
  if ((a.dialogs ?? 0) < (b.dialogs ?? 0)) notes.push(`弹出了${b.overlay ? `「${b.overlay}」` : ''}浮层`);
  if ((a.dialogs ?? 0) > (b.dialogs ?? 0)) notes.push('浮层已关闭');
  if (a.overlay !== b.overlay && b.overlay && (a.dialogs ?? 0) === (b.dialogs ?? 0)) notes.push(`浮层切到「${b.overlay}」`);
  if (a.fullscreen !== b.fullscreen) notes.push(b.fullscreen ? '进入全屏' : '退出全屏');
  if (a.tab !== b.tab && b.tab) notes.push(`工作台切到 ${b.tab}`);
  const beforePanels = new Set(a.panels ?? []);
  const afterPanels = new Set(b.panels ?? []);
  const added = [...afterPanels].filter((id) => !beforePanels.has(id));
  const removed = [...beforePanels].filter((id) => !afterPanels.has(id));
  if (added.length) notes.push(`新增面板 ${added.join('、')}`);
  if (removed.length) notes.push(`关闭面板 ${removed.join('、')}`);
  // 世界代际与选中集:编辑类菜单命令的落点就在这两处,屏幕结构一动不动。
  // 只按结构判"没变化",等于对撤销/复制/删除这一整类命令系统性诬告。
  if (typeof a.rev === 'number' && typeof b.rev === 'number' && a.rev !== b.rev) {
    notes.push(b.rev > a.rev
      ? `场景内容已改变(世界代际 ${a.rev} → ${b.rev})`
      : `世界代际回退 ${a.rev} → ${b.rev}(撤销,或换到了另一个页面)`);
  }
  if (a.selection !== undefined && b.selection !== undefined && a.selection !== b.selection) {
    notes.push('选中的对象变了(层级树高亮与物体属性面板随之更新)');
  }
  return notes.length ? notes.join(',') : null;
}

async function runOpenRail(
  queryText: string,
  deps: EditorUiBrowseDeps,
): Promise<unknown> {
  const shell = readShell(deps);
  if (!shell) {
    // 2026-08-06 外审 B1:当前版本 rail(host.sidebar)**从未接入 surface 总线**
    // (上游 Page 重构后无发布者)—— 走到这里几乎总是版本事实,不是用户没开页面。
    // 旧文案"先让用户打开页面"会让 agent 对着开着的页面说胡话。
    return failure(
      'SHELL_SURFACE_UNAVAILABLE',
      `shell 面 ${SHELL_SURFACE} 未接入 surface 总线(当前版本 rail 门不可用)—— 这不是用户没开页面,`
      + '**不要**请用户"打开页面"。如实告知:rail 页签在界面上可点,但 AI 暂时无法代为点击;'
      + '需要的话请用户自己点,或改走菜单门/后台调用并说明屏幕不会展示切换过程。',
    );
  }
  const target = resolveRailTarget(shell, queryText);
  if (isFailure(target)) return target;

  // Already there. An agent that has been refused once starts guarding every step
  // with open('rail:editor') — 2026-08-04 measured 8 such calls in one task, each a
  // real dispatch plus settle wait (400-770ms) that changed nothing. Answer for free.
  const alreadyThere = target.action === 'setMode'
    ? shell.mode === 'scene'
    : shell.mode === 'ai' && shell.workbenchTab === target.args.tab;
  if (alreadyThere) {
    return {
      ok: true,
      via: `${SHELL_SURFACE}.${target.action}`,
      mode: shell.mode,
      workbenchTab: shell.workbenchTab,
      stateChanged: false,
      alreadyThere: true,
      visible_change: null,
      hint: target.action === 'setMode'
        ? '编辑器本来就在前台,没有派发任何动作 —— 直接继续读写场景即可。'
        : `${target.label} 本来就是当前工作台,没有派发任何动作。`,
    };
  }

  const wanted = (raw: unknown): boolean => {
    const state = raw as { mode?: unknown; workbenchTab?: unknown } | null;
    return target.action === 'setMode'
      ? state?.mode === 'scene'
      : state?.mode === 'ai' && state?.workbenchTab === target.args.tab;
  };
  const moved = await dispatchShellAction(deps, SHELL_SURFACE, target.action, target.args, wanted);
  if (isFailure(moved)) return moved;

  const after = readShell(deps) ?? shell;
  const manyPages = multiPageWarning(deps, SHELL_SURFACE);
  return {
    ok: true,
    via: `${SHELL_SURFACE}.${target.action}`,
    ...(moved.token ? { token: moved.token } : {}),
    mode: after.mode,
    workbenchTab: after.workbenchTab,
    stateChanged: after.mode !== shell.mode || after.workbenchTab !== shell.workbenchTab,
    // 多页时 moved.reached 证明不了"用户那一页动了" —— 它只证明**某一页**动了。
    visible_change: moved.reached && !manyPages
      ? (target.action === 'setMode' ? '编辑器工作区已切回前台,场景视口重新显示' : `${target.label} 工作台已在左侧显示`)
      : null,
    ...(manyPages ? { multiplePages: manyPages } : {}),
    ...(moved.reached || manyPages
      ? {}
      : { hint: `已回执,但 shell 回读到的是 mode=${after.mode} tab=${after.workbenchTab},与目标不符 —— 不要向用户声称已打开。` }),
    ...(target.action === 'setMode' ? {} : { editorRelayOffline: true }),
    // 门内边界:wb: 插件的内部还没发布 agent 可读接口。墙必须看得见,否则 agent
    // 会用截图/DOM/源码/别的浏览器去翻(2026-08-04 三次实测,最长一次折腾 20+ 调用)。
    ...(target.action === 'selectTab' && target.args.tab.startsWith('wb:')
      ? { interior: '插件内部尚未发布 agent 可读接口:嵌入画布截图呈黑色、a11y 树到 iframe 为止,都是边界不是故障。可用信息=manifest 描述(workbench.list_plugins)+ 用户亲眼所见;不足以深入讲解时,如实说"深度文档未发布"并停下,不要用其他工具翻墙。' }
      : {}),
  };
}

function sessionKey(ctx: HostToolRunCtx): string {
  return `${ctx.sid ?? 'no-sid'}:${ctx.agentId}`;
}



function normalizeRelayValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** Preserve the first visual occurrence of each menu label. */
export function dedupeMenuItems(items: readonly string[]): string[] {
  return [...new Set(items)];
}

function isFailure(value: unknown): value is BrowseFailure {
  if (!value || typeof value !== 'object' || !('ok' in value)) return false;
  const candidate = value as { ok?: unknown; error?: unknown };
  return candidate.ok === false && !!candidate.error && typeof candidate.error === 'object';
}

function compileLook(): string {
  return `(async () => {
  const gamesRes = await fetch('/api/workbench/games').then(r=>r.json());
  const slug = gamesRes.activeSlug ?? 'default';
  const wb = JSON.parse(localStorage.getItem(\`forgeax:project:\${slug}:workbenches\`)||'{}');
  const activeId = wb.activeId ?? 'scene';
  const layoutRaw = localStorage.getItem(\`forgeax:project:\${slug}:workbench-layout:\${activeId}\`) || '';
  let openPanels = [], activePanel = null, panels = [];
  try {
    const api = window.__dockApi;
    openPanels = api.panels.map(p=>p.id);
    activePanel = api.activePanel?.id ?? null;
    panels = api.panels.map(p => {
      const slotName = 'DockPanel:' + p.id.replace(/^ep:/, '');
      const el = document.querySelector(\`[data-fx-slot="\${CSS.escape(slotName)}"]\`);
      let region = null;
      if (el) {
        const r = el.getBoundingClientRect();
        const cx = (r.x + r.width/2) / window.innerWidth, cy = (r.y + r.height/2) / window.innerHeight;
        const h = cx < 0.34 ? 'left' : cx > 0.66 ? 'right' : 'center';
        const v = cy < 0.34 ? 'top' : cy > 0.66 ? 'bottom' : 'middle';
        region = { label: v + '-' + h, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      }
      return { id: p.id, title: p.title ?? p.id, region };
    });
  } catch {}
const uiBrowsePageId = () => { try { return window.__uiBrowsePageId || (window.__uiBrowsePageId = 'p' + Math.random().toString(36).slice(2,9)); } catch (e) { return null; } };
  const menus = [...document.querySelectorAll('[data-menu]')].map(e => e.getAttribute('data-menu'));
  let rail = null;
  try { const s = window.__dev.getState(); rail = { active: s.workbenchTab, sidebarCollapsed: s.sidebarCollapsed }; } catch {}
  let unsavedOnDisk = null;
  try { unsavedOnDisk = typeof gateway.hasPendingDiskSave === 'function' ? gateway.hasPendingDiskSave() : null; } catch {}
  // 实体花名册:中文指代("树干")对英文注册名(TreeTrunk)是常态。花名册在手,
  // 模型第一跳就能翻译,省掉 NOT_FOUND→重试那一对调用。~400B,每次都带。
  let entities = [];
  try { const named = query({ with: ['Name'] }); if (named.ok) entities = named.rows.map((row) => ({ handle: row.entity, name: String(row.Name?.value ?? '') })).filter((row) => row.name); } catch {}
  return JSON.stringify({ slug, mode: activeId==='scene'?'scene':'ai', openPanels, activePanel, panels, menus, rail, entities,
    selection: gateway.selectionReadModel(), gatewayMode: gateway.mode, rev: gateway.rev, pageId: uiBrowsePageId(),
    layoutLen: layoutRaw.length,
    liveTruth: { source:'live editor document', authoritative:true, unsavedOnDisk,
      note:'场景状态一律以本工具的返回为准;磁盘上的 scene/pack 文件可能落后,不要读它来核对。' } });
})()`;
}

function compileAssetPageHelpers(): string {
  return `const uiBrowseRawHandle = (value) => {
    if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
    if (value && typeof value === 'object' && typeof value.raw === 'number') return value.raw;
    return null;
  };
  const uiBrowseSharedTarget = (type) => {
    const match = /^shared<([^<>]+)>$/.exec(type) || /^array<shared<([^<>]+)>(?:\\s*,\\s*\\d+)?>$/.exec(type);
    return match?.[1] ?? null;
  };
  const uiBrowseSharedHandles = (value) => {
    const values = Array.isArray(value) ? value : [value];
    return values.map(uiBrowseRawHandle).filter((handle) => handle !== null && handle > 0);
  };
  const uiBrowseUsage = (() => {
    const usage = new Map();
    const desc = gateway.describeComponent('MeshRenderer');
    const fields = desc.ok ? Object.entries(desc.schema).filter(([, type]) => uiBrowseSharedTarget(type)) : [];
    const result = query({ with: ['MeshRenderer', 'Name'] });
    if (!result.ok) return usage;
    for (const row of result.rows) {
      const label = String(row.Name?.value ?? ('entity:' + row.entity));
      for (const [field] of fields) {
        for (const handle of uiBrowseSharedHandles(row.MeshRenderer?.[field])) {
          const names = usage.get(handle) ?? [];
          if (!names.includes(label)) names.push(label);
          usage.set(handle, names);
        }
      }
    }
    return usage;
  })();
  const uiBrowseColorSummary = (baseColor) => {
    if (!Array.isArray(baseColor) || baseColor.length < 3) return null;
    const rgb = baseColor.slice(0, 3).map((value) => {
      const numeric = Number(value);
      return Math.max(0, Math.min(255, Math.round(numeric <= 1 ? numeric * 255 : numeric)));
    });
    const palette = [
      ['黑', [20,20,20]], ['白', [240,240,240]], ['灰', [128,128,128]],
      ['红', [210,45,45]], ['橙', [230,130,35]], ['黄', [225,205,45]],
      ['绿', [55,150,70]], ['青', [45,170,170]], ['蓝', [55,95,205]],
      ['紫', [145,70,175]], ['棕', [139,90,43]],
    ];
    let nearest = palette[0];
    let distance = Infinity;
    for (const candidate of palette) {
      const d = candidate[1].reduce((sum, value, index) => sum + (value - rgb[index]) ** 2, 0);
      if (d < distance) { distance = d; nearest = candidate; }
    }
    return 'rgb(' + rgb.join(',') + ') ' + nearest[0];
  };
  const uiBrowseSafeMeta = (meta) => {
    const sanitize = (value, depth) => {
      if (depth > 4) return undefined;
      if (value == null || ['string','number','boolean'].includes(typeof value)) return value;
      if (Array.isArray(value)) return value.slice(0, 16).map((item) => sanitize(item, depth + 1)).filter((item) => item !== undefined);
      if (!value || typeof value !== 'object') return undefined;
      // A vertex/index buffer that already lost its TypedArray identity arrives as
      // a plain object with numeric keys, so isHeavyBuffer no longer catches it.
      // Summaries exist to identify an asset to a human — replace the payload with
      // its size instead of emitting hundreds of indexed floats.
      const entries = Object.entries(value);
      if (entries.length > 24 && entries.every(([key]) => /^\\d+$/.test(key))) return '[' + entries.length + ' 个数值]';
      return Object.fromEntries(entries.flatMap(([key, child]) => {
        if (/(?:path|url|file|source|package)/i.test(key)) return [];
        const safe = sanitize(child, depth + 1);
        return safe === undefined ? [] : [[key, safe]];
      }));
    };
    return sanitize(meta, 0) ?? {};
  };
  const uiBrowseAssetSummary = (desc) => {
    // 内部错误原文当摘要是噪音;调用方只需要知道这条读不到属性。
    if (!desc?.ok) return '未加载(该 guid 当前不在世界里,读不到属性)';
    const baseColor = desc.meta?.values?.baseColor ?? desc.meta?.baseColor;
    if (desc.kind === 'material') return uiBrowseColorSummary(baseColor) ?? 'material (baseColor unavailable)';
    const safe = uiBrowseSafeMeta(desc.meta);
    const text = JSON.stringify(safe);
    return text === '{}' ? desc.kind : text.slice(0, 240);
  };
  // Distrust shows up while VERIFYING, not only while writing: on 2026-08-04 an
  // agent read scene.pack.json four times plus three greps to "confirm" what the
  // gateway had just told it. Every state read now states, in band, that it IS
  // the authoritative value and that the file on disk may legitimately lag.
  const uiBrowseLiveTruth = () => {
    let unsavedOnDisk = null;
    try { unsavedOnDisk = typeof gateway.hasPendingDiskSave === 'function' ? gateway.hasPendingDiskSave() : null; } catch {}
    return {
      source: 'live editor document',
      authoritative: true,
      unsavedOnDisk,
      note: '以上是实时编辑器文档里的权威值;磁盘上的 scene/pack 文件可能落后。要验证就再调一次本工具,不要读那个文件。',
    };
  };
  const uiBrowseIdentity = (handle, described) => {
    const desc = described ?? gateway.describeAsset(handle);
    return {
      handle,
      guid: desc.ok ? (desc.guid ?? null) : null,
      kind: desc.ok ? desc.kind : null,
      summary: uiBrowseAssetSummary(desc),
      usedBy: uiBrowseUsage.get(handle) ?? [],
    };
  };`;
}

function compileEntityBody(
  handleExpression: string,
  includeTransient: boolean,
  inspector: boolean,
  extraExpression = '{}',
): string {
  const emptyResult = inspector
    ? `return JSON.stringify({ ...${extraExpression}, empty:true, hint:'no selection — ask the user to click an entity, or open entity:<handle-or-name> directly' });`
    : '';
  return `${compileAssetPageHelpers()}
  const handle = ${handleExpression};
  ${inspector ? `if (handle == null) { ${emptyResult} }` : ''}
  const compNames = gateway.listComponents();
  const components = {};
  for (const name of compNames) {
    const r = query({ with: [name] });
    if (!r.ok) continue;
    const row = r.rows.find(row => row.entity === handle);
    if (!row || !row[name]) continue;
    const desc = gateway.describeComponent(name);
    const transient = desc.ok ? Object.keys(desc.transient ?? {}) : [];
    const values = {};
    const fields = {};
    const schema = desc.ok ? desc.schema : {};
    for (const [k, type] of Object.entries(schema)) {
      if (!${includeTransient} && transient.includes(k)) continue;
      const value = row[name][k] ?? desc.defaults?.[k];
      values[k] = value;
      if (transient.includes(k)) {
        fields[k] = { value, writable:false, note:'transient derived field; do not author' };
        continue;
      }
      const assetType = uiBrowseSharedTarget(type);
      if (assetType) {
        const handles = uiBrowseSharedHandles(value);
        const identities = handles.map((assetHandle) => uiBrowseIdentity(assetHandle));
        fields[k] = {
          value,
          identity: type.startsWith('array<') ? identities : (identities[0] ?? null),
          affordance: {
            op: { kind:'bindAssetRef', entity:handle, component:name, field:k, assetType, guids:['<在此填目标资产的 guid>'], requestId:'<auto>' },
            async:true,
            note:'把 guids 改成目标资产 guid 后用 act 提交；requestId 的 <auto> 会由工具自动补全',
          },
        };
      } else {
        fields[k] = {
          value,
          affordance: {
            op: { kind:'setComponent', entity:handle, component:name, patch:{ [k]:value } },
            async:false,
            note:'把 patch 里的值改成目标值后，用 act 提交',
          },
        };
      }
    }
    components[name] = { values, fields, schema, transientFields: transient };
  }
  if (!Object.keys(components).length) return JSON.stringify({ ok:false, error:{code:'NOT_FOUND', kind:'entity', hint:\`no components on handle \${handle}; it may be stale — call look to recalibrate\`} });
  return JSON.stringify({ ...${extraExpression}, entity: handle, components, liveTruth: uiBrowseLiveTruth() });`;
}

function compileResolveEntity(queryText: string): string {
  return `(() => {
  const raw = ${JSON.stringify(queryText)};
  const numeric = Number(raw);
  if (raw && Number.isSafeInteger(numeric) && numeric >= 0) return JSON.stringify({ ok:true, handle:numeric, node:'entity:' + numeric, label:'entity ' + numeric });
  const result = query({ with: ['Name'] });
  if (!result.ok) return JSON.stringify(result);
  const needle = raw.trim().toLocaleLowerCase();
  const rows = result.rows.map((row) => ({ handle:row.entity, label:String(row.Name?.value ?? '') })).filter((row) => row.label);
  const exact = rows.filter((row) => row.label.toLocaleLowerCase() === needle);
  const matches = exact.length ? exact : rows.filter((row) => row.label.toLocaleLowerCase().includes(needle));
  if (matches.length > 1) return JSON.stringify({ ok:false, error:{ code:'AMBIGUOUS_REFERENT', hint:'实体名称命中多个候选；请指定其一或问用户', candidates:matches.map((row) => ({ node:'entity:' + row.handle, label:row.label, where:'现视野' })) } });
  // 用户说"树干",实体注册的名字是 TreeTrunk —— 中英文对不上是常态,不是异常。
  // 别的节点类型撞到未命中都会把清单甩回去让调用方自己认;实体这条曾经只说"你去
  // 开 hierarchy 面板",于是每次都多跑一趟(2026-08-04 实测 3 次调用才拿到实体)。
  // 给清单,不建同义词表 —— 认出 TreeTrunk 就是"树干"是模型的活,不是映射表的活。
  if (matches.length === 0) return JSON.stringify({ ok:false, error:{ code:'NOT_FOUND', kind:'entity',
    hint:'没有名称或 handle 精确匹配 ' + raw + ';下面是场景里所有实体,按语义挑一个再试(名字可能是英文)',
    candidates:rows.slice(0, 60).map((row) => ({ node:'entity:' + row.handle, label:row.label, where:'场景树' })) } });
  return JSON.stringify({ ok:true, handle:matches[0].handle, node:'entity:' + matches[0].handle, label:matches[0].label });
})()`;
}

function compileOpenEntity(handle: number, includeTransient: boolean): string {
  // 像人一样"点开"这个实体:先真的选中它 —— 层级树高亮、Inspector 跟随、视口给
  // gizmo,用户看得见 agent 手里拿的是哪个对象。2026-08-05 实测:改色任务全程零
  // 选中,用户只见结果不见过程 —— 实体是 open 契约("深入一层并使之可见")里唯一
  // 没兑现可见性的节点类型。setSelection 是 session op:进账本(origin 'ai')、
  // 不进 undo 栈(gateway.ts auditLog 注释明言),不会污染用户的 Ctrl+Z。
  return `(() => {
  const uiBrowseTarget = ${handle};
  const uiBrowseVis = [];
  try {
    if (gateway.selectionReadModel().primary !== uiBrowseTarget) {
      const uiBrowseSel = gateway.dispatch({ kind:'setSelection', id: uiBrowseTarget }, 'ai');
      if (uiBrowseSel?.ok && gateway.selectionReadModel().primary === uiBrowseTarget) {
        uiBrowseVis.push('已在场景中选中该实体(层级树高亮)');
      }
    }
  } catch (e) {}
  // 人的下半步:看着**物体属性**面板改参数。把它切到前台,用户盯着的才是人用的
  // 同一块表面;后续 act 的字段修改会实时反映在这块面板里(同一个读模型)。
  // 面板不在布局里则不强开(人点实体也不会凭空生出面板),如实报告即可。
  let uiBrowseInspectorNote = null;
  try {
    const uiBrowseDock = window.__dockApi;
    const uiBrowseInspector = uiBrowseDock?.getPanel('ep:inspector');
    if (uiBrowseInspector) {
      if (uiBrowseDock.activePanel?.id !== 'ep:inspector') {
        uiBrowseInspector.api.setActive();
        if (uiBrowseDock.activePanel?.id === 'ep:inspector') uiBrowseVis.push('物体属性面板已切到前台');
      }
    } else {
      uiBrowseInspectorNote = '物体属性面板当前不在布局里 —— 修改仍会生效并可撤销,但用户看不到字段面板;要展示请先 open("panel:ep:inspector")。';
    }
  } catch (e) {}
  ${compileEntityBody(String(handle), includeTransient, false, "{ visible_change: uiBrowseVis.length ? uiBrowseVis.join('，') + ' —— 用户看着的正是人改参数用的同一块面板' : null, ...(uiBrowseInspectorNote ? { hint: uiBrowseInspectorNote } : {}), selection: gateway.selectionReadModel() }")}
})()`;
}

function compileResolveUiReferent(kind: 'panel' | 'menu', queryText: string): string {
  return `(() => {
  const kind = ${JSON.stringify(kind)};
  const raw = ${JSON.stringify(queryText)};
  const needle = raw.trim().toLocaleLowerCase();
  const region = (el) => {
    if (!el) return '一步可达';
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return '一步可达';
    const horizontal = r.x + r.width / 2 < innerWidth / 3 ? '左' : r.x + r.width / 2 > innerWidth * 2 / 3 ? '右' : '中';
    const vertical = r.y + r.height / 2 < innerHeight / 3 ? '上' : r.y + r.height / 2 > innerHeight * 2 / 3 ? '下' : '中';
    return '现视野·' + vertical + horizontal;
  };
  let items = [];
  if (kind === 'panel') {
    const api = window.__dockApi;
    items = (api?.panels ?? []).map((panel) => {
      const id = panel.id;
      const label = String(panel.title ?? id);
      const el = document.querySelector('[data-fx-slot="DockPanel:' + CSS.escape(id.replace(/^ep:/, '')) + '"]');
      return { id, label, node:id, where:region(el) };
    });
  } else if (kind === 'menu') {
    items = [...document.querySelectorAll('[data-menu]')].map((el) => ({ id:el.getAttribute('data-menu'), label:String(el.textContent?.trim() || el.getAttribute('aria-label') || el.getAttribute('data-menu')), node:el.getAttribute('data-menu'), where:region(el) }));
  } else {
    items = [...document.querySelectorAll('[data-menu]')].map((el) => ({ id:el.getAttribute('data-menu'), label:String(el.textContent?.trim() || el.getAttribute('data-menu')), node:el.getAttribute('data-menu'), where:region(el) }));
  }
  const exact = items.filter((item) => item.id?.toLocaleLowerCase() === needle || item.label.toLocaleLowerCase() === needle);
  const matches = exact.length ? exact : items.filter((item) => item.id?.toLocaleLowerCase().includes(needle) || item.label.toLocaleLowerCase().includes(needle));
  if (matches.length > 1) return JSON.stringify({ ok:false, error:{ code:'AMBIGUOUS_REFERENT', hint:kind + ' 名称命中多个候选；请指定其一或问用户', candidates:matches.map((item) => ({ node:kind + ':' + item.node, label:item.label, where:item.where })) } });
  if (matches.length === 1) return JSON.stringify({ ok:true, id:matches[0].id || raw, label:matches[0].label, node:kind + ':' + matches[0].node, matched:true });
  // 未命中就是未命中。放行一个"看起来像 id"的串会让 compileOpenPanel 对不存在的
  // 组件 addPanel,而 Dockview 布局是持久化的(saveWorkbenchLayout → localStorage)
  // —— 一个拼错的面板名会永久留在用户保存的布局里。零副作用不能只对模糊指代成立。
  return JSON.stringify({ ok:false, error:{ code:'NOT_FOUND', kind, hint:'没有已注册的 ' + kind + ' 文案匹配 ' + raw,
    candidates:items.map((item) => ({ node:kind + ':' + item.node, label:item.label, where:item.where })) } });
})()`;
}

function compileOpenPanel(id: string, label: string): string {
  return `(async () => {
  const id = ${JSON.stringify(id)};
  const label = ${JSON.stringify(label)};
  const api = window.__dockApi;
  const before = api.activePanel?.id ?? null;
  const existing = api.getPanel(id);
  if (existing) { existing.api.setActive(); }
  else {
    const ref = api.panels[api.panels.length-1]?.id;
    api.addPanel({ id, component: id, title: label, position: ref?{referencePanel:ref,direction:'right'}:undefined });
  }
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const active = api.activePanel?.id === id && !!api.getPanel(id);
  const el = document.querySelector('[data-fx-slot="DockPanel:' + CSS.escape(id.replace(/^ep:/, '')) + '"]');
  const rect = el?.getBoundingClientRect();
  const visible = active && !!rect && rect.width > 0 && rect.height > 0;
  const horizontal = visible ? (rect.x + rect.width/2 < innerWidth/3 ? '左' : rect.x + rect.width/2 > innerWidth*2/3 ? '右' : '中') : '';
  const vertical = visible ? (rect.y + rect.height/2 < innerHeight/3 ? '上' : rect.y + rect.height/2 > innerHeight*2/3 ? '下' : '中') : '';
  const visual = { ok:true, stateChanged:before !== id, visible_change:visible ? label + ' 面板已在' + vertical + horizontal + '激活' : null, ...(visible ? {} : { hint:'面板状态已更新，但页面上未检测到有尺寸的目标面板，不能向用户声称可见' }) };
  if (id === 'ep:hierarchy') {
    const q = query({ with: ['Name'] });
    const rows = q.ok ? q.rows.map(r=>({id:r.entity,name:r.Name.value})) : [];
    return JSON.stringify({ ...visual, rows });
  }
  if (id === 'ep:inspector') {
    ${compileEntityBody('gateway.selectionReadModel().primary', false, true, 'visual')}
  }
  if (id === 'ep:assets') {
    // {guid, kind, name} 认不出任何东西 —— 这个场景里每个材质的 name 都是
    // "scene.pack.json"。2026-08-04 实测:agent 老老实实开了这个面板,拿到一堆
    // 同名条目,只好翻到 editor_gateway_eval 去反射 gateway 自己拼颜色(5 次逃生舱
    // 调用,其中两次是 Object.keys(gateway) 这种摸墙)。面板给的必须是能认人的东西。
    ${compileAssetPageHelpers()}
    const byHandle = new Map();
    for (const componentName of gateway.listComponents()) {
      const desc = gateway.describeComponent(componentName);
      if (!desc.ok) continue;
      const fields = Object.entries(desc.schema).filter(([, type]) => uiBrowseSharedTarget(type));
      if (!fields.length) continue;
      const rows = query({ with:[componentName] });
      if (!rows.ok) continue;
      for (const row of rows.rows) for (const [field] of fields) for (const handle of uiBrowseSharedHandles(row[componentName]?.[field])) {
        const described = gateway.describeAsset(handle);
        if (described.ok && described.guid) byHandle.set(described.guid, handle);
      }
    }
    const assets = gateway.assetCatalog().map((entry) => {
      const handle = byHandle.get(entry.guid) ?? null;
      const described = handle === null ? gateway.describeAssetByGuid(entry.guid) : gateway.describeAsset(handle);
      return { guid:entry.guid, kind:entry.kind, summary:uiBrowseAssetSummary(described),
        usedBy:handle === null ? [] : (uiBrowseUsage.get(handle) ?? []) };
    });
    return JSON.stringify({ ...visual, assets });
  }
  if (id === 'ep:history') return JSON.stringify({ ...visual, steps:gateway.historySteps().slice(-20) });
  return JSON.stringify({ ...visual, opened:true });
})()`;
}

/** Walk a menu chain visually: open the top menu, click each submenu trigger in
 *  turn (the ONLY synthetic gesture Radix accepts — hover and focus+Enter do
 *  nothing, hand-walked 2026-08-04), harvest the deepest level. A command leaf is
 *  NOT clicked here (Radix ignores it); it is reported back so the caller can
 *  execute it through host.menubar.invoke — the same command bus a human click
 *  lands on. Menus stay open so the user sees the path. */
function compileMenuChain(segments: string[]): string {
  return `(async () => {
  const segs = ${JSON.stringify(segments)};
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // 归零:上一次调用可能把菜单留在任意展开深度(保持打开是给用户看路径的设计),
  // 从残留状态续走会迷路 —— 整链重放零成本,且用户每次都看到完整路径。
  for (const openBtn of document.querySelectorAll('[data-menu][aria-expanded="true"]')) {
    openBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true }));
    openBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles:true }));
    openBtn.click();
  }
  if (document.querySelectorAll('[role="menu"]').length > 0) await sleep(300);
  const top = document.querySelector('[data-menu="' + CSS.escape(segs[0]) + '"]')
    || [...document.querySelectorAll('[data-menu]')].find((el) => el.textContent?.trim() === segs[0]);
  if (!top) return JSON.stringify({ ok:false, error:{ code:'NOT_FOUND', kind:'menu',
    hint:'没有顶层菜单匹配 ' + segs[0],
    candidates:[...document.querySelectorAll('[data-menu]')].map((el) => ({ node:'menu:' + el.getAttribute('data-menu'), label:el.textContent?.trim() || el.getAttribute('data-menu'), where:'菜单栏' })) } });
  if (top.getAttribute('aria-expanded') !== 'true') {
    top.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true }));
    top.dispatchEvent(new PointerEvent('pointerup', { bubbles:true }));
    top.click();
    await sleep(400);
  }
  const layer = () => {
    const menus = [...document.querySelectorAll('[role="menu"]')];
    return menus.at(-1) ?? null;
  };
  const harvest = () => {
    const scope = layer();
    return scope ? [...scope.querySelectorAll('[role="menuitem"]')].map((el) => ({
      text: el.textContent?.trim() ?? '',
      sub: el.getAttribute('aria-haspopup') === 'menu',
      disabled: el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('data-disabled'),
    })) : [];
  };
  const path = [segs[0]];
  let leaf = null;
  for (let i = 1; i < segs.length; i++) {
    const target = segs[i];
    const scope = layer();
    if (!scope) return JSON.stringify({ ok:false, error:{ code:'INVALID_PAGE_STATE', hint:'菜单层意外关闭,重新调用同一条链' } });
    const rows = [...scope.querySelectorAll('[role="menuitem"]')];
    const el = rows.find((r) => r.textContent?.trim() === target)
      ?? rows.find((r) => r.textContent?.trim().startsWith(target))
      ?? rows.find((r) => r.textContent?.includes(target));
    if (!el) return JSON.stringify({ ok:false, error:{ code:'NOT_FOUND', kind:'menu-item',
      hint:'这一层没有 ' + target + ';下面是它实际有的项',
      candidates: harvest().map((row) => ({ node:'menu:' + path.join('/') + '/' + row.text, label:row.text, where:'第' + i + '层' })) } });
    if (el.getAttribute('aria-haspopup') === 'menu') {
      if (el.getAttribute('data-state') !== 'open') {
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true }));
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles:true }));
        el.click();
        await sleep(450);
      }
      path.push(el.textContent?.trim() ?? target);
      continue;
    }
    leaf = { text: el.textContent?.trim() ?? target,
      disabled: el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('data-disabled') };
    path.push(leaf.text);
    break;
  }
  return JSON.stringify({ ok:true, path, leaf, items: harvest(),
    menusOpen: document.querySelectorAll('[role="menu"]').length });
})()`;
}

/** 收尾核对的世界快照:一趟 relay 取齐 rev / 页面身份 / 落盘状态 / 选择集 /
 *  账本尾巴 / 屏幕现状。之所以要账本(而不只是工具自己的调用记录):调用成功
 *  只说明"我发出去的那一刀被接住了",账本才说明**世界里真的留下了什么**。
 *  2026-08-04 那个会话 40 次调用零失败,而用户屏幕上什么都没变。 */
function compileVerifySnapshot(): string {
  return `(() => {
  const uiBrowsePageId = () => { try { return window.__uiBrowsePageId || (window.__uiBrowsePageId = 'p' + Math.random().toString(36).slice(2,9)); } catch (e) { return null; } };
  let unsavedOnDisk = null;
  try { unsavedOnDisk = typeof gateway.hasPendingDiskSave === 'function' ? gateway.hasPendingDiskSave() : null; } catch {}
  let ledgerTail = [];
  try { ledgerTail = gateway.auditLog().slice(-25).map((entry) => ({ kind: entry.op?.kind ?? null, origin: entry.origin ?? null })); } catch {}
  let overlay = null, tab = null;
  try { const s = window.__dev.getState(); tab = s.workbenchTab ?? null; overlay = s.activeOverlay ?? null; } catch {}
  let panels = [];
  try { panels = window.__dockApi.panels.map((p) => p.id).sort(); } catch {}
  let selection = null;
  try { selection = gateway.selectionReadModel(); } catch {}
  return JSON.stringify({ rev: gateway.rev, pageId: uiBrowsePageId(), unsavedOnDisk, selection, ledgerTail,
    screen: { overlay, tab, panels, dialogs: document.querySelectorAll('[role=\"dialog\"]').length, fullscreen: !!document.fullscreenElement } });
})()`;
}

/** 界面指纹:命令执行前后各取一次,用差异回答"用户看得见的东西变了吗"。
 *  覆盖浮层/对话框、面板集、rail tab、全屏,**以及世界代际 rev 与选中集**。
 *
 *  为什么必须带 rev/selection(2026-08-06 探测):只按屏幕结构取指纹,整个 Edit
 *  菜单类命令(撤销/重做/复制/粘贴/删除/复制路径)都是系统性假阴性 —— 它们改的是
 *  世界或选中,不改浮层面板,指纹必然"无差异",于是工具建议 agent 说"这一项虽然
 *  可点却尚未真正接线"。**把正常工作的功能报成产品缺陷**,比漏报更坏。
 *  rev 与 selection 在同一趟 relay 里就能取到(compileVerifySnapshot 早就在取),
 *  零额外往返。 */
function compileScreenFingerprint(): string {
  return `(() => {
  const uiBrowsePageId = () => { try { return window.__uiBrowsePageId || (window.__uiBrowsePageId = 'p' + Math.random().toString(36).slice(2,9)); } catch (e) { return null; } };
  let overlay = null, tab = null;
  try { const s = window.__dev.getState(); tab = s.workbenchTab ?? null; overlay = s.activeOverlay ?? null; } catch {}
  let panels = [];
  try { panels = window.__dockApi.panels.map((p) => p.id).sort(); } catch {}
  let rev = null, selection = null;
  try { rev = gateway.rev; } catch {}
  try { const sel = gateway.selectionReadModel(); selection = sel ? JSON.stringify(sel) : null; } catch {}
  return JSON.stringify({
    pageId: uiBrowsePageId(),
    overlay,
    dialogs: document.querySelectorAll('[role="dialog"]').length,
    fullscreen: !!document.fullscreenElement,
    panels,
    tab,
    menus: document.querySelectorAll('[role="menu"]').length,
    rev,
    selection,
  });
})()`;
}

/** `panel:` 只能寻址**已在布局里**的面板 —— 关掉的面板不在 `__dockApi.panels` 里,
 *  解析必然 NOT_FOUND。但它并非不可达:窗口菜单的面板开关(`app.panel.toggle`,
 *  见 interface `builtin-menus.ts` WINDOW 段)就是人重新打开它的那扇门,而且是
 *  一条已经支持的可见路径。
 *
 *  2026-08-06 探测:此前这里只回一句"没有已注册的 panel 匹配 X",agent 拿到的
 *  是"这东西不存在",于是要么放弃、要么绕去无头路径 —— 而屏幕上那扇门就开着。
 *  失败必须自带活路:在菜单投影里按 `app.panel.toggle` 的 args.id 反查,命中就把
 *  链地址交出去。 */
function panelNotFoundWithMenuDoor(
  failed: BrowseFailure,
  queryText: string,
  deps: EditorUiBrowseDeps,
): BrowseFailure {
  if (failed.error.code !== 'NOT_FOUND') return failed;
  const menus = readMenuTree(deps);
  if (!menus) return failed;
  const needle = queryText.trim().toLocaleLowerCase();
  let hit: { chain: string; label: string } | null = null;
  for (const [menuId, nodes] of Object.entries(menus)) {
    const walk = (list: MenuTreeNode[], prefix: string[]): void => {
      for (const node of list) {
        const argsId = (node.args as { id?: unknown } | undefined)?.id;
        if (!hit && node.commandId === 'app.panel.toggle' && typeof argsId === 'string'
          && (argsId.toLocaleLowerCase() === needle
            || argsId.replace(/^ep:/, '').toLocaleLowerCase() === needle
            || node.label.toLocaleLowerCase() === needle)) {
          hit = { chain: `menu:${menuId}${[...prefix, node.label].map((p) => `/${p}`).join('')}`, label: node.label };
        }
        if (Array.isArray(node.children)) walk(node.children, [...prefix, node.label]);
      }
    };
    walk(Array.isArray(nodes) ? nodes : [], []);
    if (hit) break;
  }
  if (!hit) return failed;
  const door = hit as { chain: string; label: string };
  return {
    ok: false,
    error: {
      ...failed.error,
      hint: `「${queryText}」当前不在布局里(panel: 只能寻址已打开的面板),但它有一扇可见的门:`
        + `open('${door.chain}') —— 窗口菜单里的「${door.label}」开关,正是人重新打开它的那一项。`
        + '**不要**告诉用户这个面板不存在。',
      recoveryActions: [{ node: door.chain, label: `打开「${door.label}」` }],
    },
  };
}

/** Close whatever menus are open and report whether the screen is clean again. */
function compileCloseMenus(): string {
  // 绝不用 Escape 收尾。全局快捷键把 Escape 串成一条链:关菜单 → 退全屏 →
  // **关浮层**。菜单项刚打开一个浮层(如 help.shortcuts → overlay.open)时,
  // 补一发 Escape 就把它当场关掉 —— 2026-08-04 用户实测"快捷键页面闪了一下就没了"。
  // 只对菜单按钮本身做 toggle;若某层菜单顽固不关,如实上报,不用广谱键盘事件收场。
  return `(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (const btn of document.querySelectorAll('[data-menu][aria-expanded="true"]')) {
    btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true }));
    btn.dispatchEvent(new PointerEvent('pointerup', { bubbles:true }));
    btn.click();
  }
  await sleep(300);
  return JSON.stringify({ menusOpen: document.querySelectorAll('[role="menu"]').length });
})()`;
}

function compileOpenMenu(id: string, label: string): string {
  return `(async () => {
  const id = ${JSON.stringify(id)};
  const label = ${JSON.stringify(label)};
  const btn = document.querySelector(\`[data-menu="\${id}"]\`);
  if (!btn) return JSON.stringify({ ok:false, error:{ code:'NOT_FOUND', kind:'menu', hint:'menus: ' + [...document.querySelectorAll('[data-menu]')].map(e=>e.getAttribute('data-menu')).join(',') } });
  btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true }));
  btn.dispatchEvent(new PointerEvent('pointerup', { bubbles:true }));
  btn.click();
  await new Promise(resolve => setTimeout(resolve, 350));
  const items = [...new Set([...document.querySelectorAll('[role="menuitem"]')]
    .map(e => e.textContent?.trim())
    .filter(Boolean))];
  const visible = items.length > 0;
  return JSON.stringify({ ok:true, opened:true, stateChanged:true, visible_change:visible ? label + ' 菜单已打开' : null, items, ...(visible ? {} : { hint:'点击已发出，但未检测到可见菜单项，不能向用户声称菜单已打开' }) });
})()`;
}


function compileAct(op: Record<string, unknown>): string {
  return `(async () => {
  ${compileAssetPageHelpers()}
  const op = ${JSON.stringify(op)};
  const readAfter = () => {
    if (typeof op.entity !== 'number' || typeof op.component !== 'string') return {};
    const result = query({ with:[op.component] });
    const row = result.ok ? result.rows.find((candidate) => candidate.entity === op.entity) : null;
    const component = row?.[op.component] ?? {};
    const keys = op.kind === 'setComponent' && op.patch && typeof op.patch === 'object' ? Object.keys(op.patch) : typeof op.field === 'string' ? [op.field] : [];
    // A shared-asset field reads back as a bare handle ([1041]), which says nothing
    // about what got bound — so the caller had to re-open the entity just to see the
    // colour (2026-08-04: two wasted round-trips per bind). Resolve it here instead.
    const desc = gateway.describeComponent(op.component);
    const schema = desc.ok ? desc.schema : {};
    return Object.fromEntries(keys.map((key) => {
      const value = component[key];
      const assetType = uiBrowseSharedTarget(String(schema[key] ?? ''));
      if (!assetType) return [key, value];
      const identities = uiBrowseSharedHandles(value).map((handle) => uiBrowseIdentity(handle));
      return [key, { value, identity: String(schema[key]).startsWith('array<') ? identities : (identities[0] ?? null) }];
    }));
  };
  const finish = (run) => {
    const last = gateway.auditLog().at(-1);
    // A gateway edit lands in the live document and the undo stack — NOT on disk.
    // Report that explicitly: an agent that checks the scene file, sees it
    // unchanged and concludes "the gateway does not persist" will go and hand-edit
    // the file (observed 2026-08-04). The answer is the save op, not a text editor.
const uiBrowsePageId = () => { try { return window.__uiBrowsePageId || (window.__uiBrowsePageId = 'p' + Math.random().toString(36).slice(2,9)); } catch (e) { return null; } };
    let unsavedOnDisk = null, authoringMode = null;
    try { unsavedOnDisk = typeof gateway.hasPendingDiskSave === 'function' ? gateway.hasPendingDiskSave() : null; } catch {}
    try { authoringMode = gateway.sceneAuthoringSession?.().mode ?? null; } catch {}
    return { ok:true, rev:gateway.rev, after:readAfter(), ledger:last ? { kind:last.op.kind, origin:last.origin } : null,
      unsavedOnDisk, authoringMode, pageId: uiBrowsePageId(), ...(run === undefined ? {} : { run }) };
  };
  const r = gateway.dispatch(op, 'ai');
  if (!r.ok) return JSON.stringify(r);
  // createMaterial 的"完成"不是这次同步派发(那只提交了撤销账本)——editor-core 的
  // 契约原文(core/src/session/pack-ops.ts:108):pack 写盘落地 **且** 目录屏障观察到
  // 新 GUID 才算完成,后续 bindAssetRef 必须等它、失败必须放弃绑定,否则会得到一个
  // 永远灰着、贴图 404 的材质。
  // 2026-08-06 用户实测:目录屏障在派发返回之后才失败(控制台 editor-core 那条
  // "create material asset commit failed ... before the visibility deadline"),
  // 而工具早已回 ok:true,agent 于是对用户说"已经调暗并保存好了"。
  // createMaterial 不走 operationRun(不在网关的 request-correlated 名单里),所以
  // 上面那条 run 分支盖不到它 —— 这里按目录**回读**独立把关:目录里查得到才算数。
  if (op.kind === 'createMaterial' && typeof op.guid === 'string') {
    const wanted = op.guid;
    const catalogued = async () => {
      try { return gateway.assetCatalog().some((entry) => entry?.guid === wanted); } catch (e) { return false; }
    };
    let visible = await catalogued();
    for (let waited = 0; waited < 5000 && !visible; waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      visible = await catalogued();
    }
    if (!visible) {
      return JSON.stringify({ ok:false, rev:gateway.rev, error:{ code:'ASSET_NOT_CATALOGUED',
        guid: wanted,
        hint:'材质已写入并进了撤销账本,但资产目录在可见性期限内没有收录这个 GUID —— '
          + '**这一步没有真正完成**。不要绑定它(会得到一个永远灰着、贴图 404 的材质),'
          + '也不要向用户声称已经改好;如实说明这个材质创建失败,并考虑改用已有材质。' } });
    }
  }
  const run = r.result?.operationRun;
  if (run?.requestId) {
    const done = await gateway.waitOperationRun(run.requestId);
    const terminal = done?.value ?? done;
    if (done?.ok === false || terminal?.status === 'failed') return JSON.stringify({ ok:false, error:terminal?.error ?? done?.error ?? { code:'OPERATION_FAILED', hint:'operation run failed' }, run:terminal });
    return JSON.stringify(finish(terminal));
  }
  return JSON.stringify(finish());
})()`;
}










/** Transport-class failures: the relay could not be reached, or reached a page
 *  that never answered. Distinct from a gateway-level failure, which means the
 *  editor DID answer and said no. */
const DEAD_TRANSPORT_CODES = new Set([
  'RELAY_UNAVAILABLE',
  'RELAY_HTTP_ERROR',
  'RELAY_INVALID_RESPONSE',
  'PAGE_NOT_CONNECTED',
  'EVAL_TIMEOUT',
]);

/** Circuit breaker, keyed by relay base URL.
 *
 *  2026-08-04 test round: the relay's executor page stopped draining mid-session
 *  and every later call spent the full timeout before failing. Thirty seconds of
 *  slow suffocation, repeated, is the worst possible signal — the agent read it
 *  as "keep trying something else" and improvised its way around the door for
 *  468s (Playwright, screenshots, Vision OCR, AppleScript, and finally editing
 *  scene.pack.json by hand). A door that is down must say so INSTANTLY and say
 *  what to do about it; the only acceptable failure here is a fast, hard, legible
 *  refusal. */
const relayHealth = new Map<string, { downSince: number; diagnosis: BrowseFailure; nextProbeAt: number }>();

/** Probing costs nothing when the relay answers (it replies PAGE_NOT_CONNECTED
 *  immediately), but costs the probe timeout when a wedged page is holding the
 *  socket. Only in that second case is it worth going quiet for a while. */
const RELAY_PROBE_TIMEOUT_MS = 2_000;
const SLOW_PROBE_MS = 500;
const RELAY_PROBE_COOLDOWN_MS = 5_000;

/** Cheap read timeout. Page-side recipes are all sub-second when the executor is
 *  alive, so anything past this is a wedged page, not a slow one. */
const RELAY_READ_TIMEOUT_MS = 8_000;
/** act may await an OperationRun terminal state, which is legitimately slower. */
const RELAY_ACT_TIMEOUT_MS = 30_000;

export function _resetRelayHealthForTests(): void {
  relayHealth.clear();
  staticTableSent.clear();
  lastSeenRev.clear();
  lastSeenPage.clear();
  lastVerifyAt.clear();
  roundDirty.clear();
}

/** Ask the relay itself whether it even has a page, so the refusal can name the
 *  actual cause instead of a generic timeout. */
async function diagnoseDeadRelay(
  deps: EditorUiBrowseDeps,
  observed: BrowseFailure,
): Promise<BrowseFailure> {
  const base = relayBaseUrl(deps);
  const fetchFn = deps.fetch ?? globalThis.fetch;
  let connected: boolean | null = null;
  try {
    const response = await fetchFn(`${base}/health`, { signal: AbortSignal.timeout(2_000) });
    if (response.ok) {
      const body = (await response.json()) as { pageConnected?: unknown };
      if (typeof body.pageConnected === 'boolean') connected = body.pageConnected;
    }
  } catch {
    connected = null;
  }
  const cause = connected === false
    ? '编辑器页面没有连上中继(relay 报 pageConnected=false)。请打开或刷新 http://localhost:38920 的编辑器标签页。'
    : connected === true
      // 2026-08-06 自探:**先说最常见也最无害的那个病因**。"页面连着但不跑帧循环"
      // 的头号原因是用户此刻待在 AI 工作区(编辑器视口没挂载),点一下 Scene 页签
      // 就好;而旧文案直接让用户"关掉其他页面并刷新" —— 刷新会丢掉尚未落盘的编辑,
      // 而"改动先在文档、磁盘落后"正是这套设计的前提。本该无害的误诊变成有害建议。
      // (前台闸本应先拦住这种情况,但它依赖 host.sidebar 投影,而 rail 至今没有
      // 发布者,所以那道闸在生产里从未触发过 —— 见 pending-team-handoffs H2。)
      ? '有页面连着中继但不响应。**最常见的原因是编辑器视口没有挂载** —— 用户此刻在 AI/工作台一侧,'
        + '编辑器帧循环不在跑。你有两条路,都不会丢失未保存的改动:'
        + '①请用户点左上 rail 的 Scene 页签切回编辑器(他看得见这一步);'
        + '②你自己用 ui_act_app_set_mode({mode:"scene"}) 后台切回去 —— 这条是活的、不依赖 rail 投影,'
        + '但屏幕上不会展示切换过程,用它就必须如实说明"我在后台切的,你没看到点击动作"。'
        + '默认先问用户选哪条,别默认替他决定。若他确认已经在编辑器里,再考虑第二种可能:'
        + '开了不止一个 ForgeaX 页面(另一个窗口/应用内浏览器/自动化浏览器抢走了执行权)——'
        + '**那时才**请他只保留一个页面。刷新会丢掉尚未落盘的编辑,不要一上来就让他刷新。'
      : `无法连上中继 ${base}。开发栈或中继可能没在跑。`;
  return {
    ok: false,
    error: {
      code: 'EDITOR_TRANSPORT_DOWN',
      hint: `${cause} 在页面恢复之前,编辑器读写一律不可用。【不要绕路】${NO_SIDE_DOOR}`
        + ' 正确做法:把上面这句话原样告诉用户,请他修好页面,然后重试同一个调用。',
      retryable: true,
      owner: 'user',
      observed: observed.error.code,
      pageConnected: connected,
    },
  };
}

function transportFailure(value: unknown): value is BrowseFailure {
  return isFailure(value) && DEAD_TRANSPORT_CODES.has(value.error.code);
}

/** Close the last mile of a write. A gateway op lands in the live document and
 *  the undo stack; the scene file on disk only changes when someone saves. Left
 *  unsaid, that gap reads to an agent as "the gateway did not really work" — on
 *  2026-08-04 an agent dispatched bindAssetRef correctly, verified it through the
 *  gateway, then re-read scene.pack.json, saw the old value and hand-edited the
 *  file to "make it stick". So every successful write now carries where it lives
 *  and the exact op that persists it. */
function annotatePersistence(acted: unknown, op: Record<string, unknown>): unknown {
  if (!acted || typeof acted !== 'object' || Array.isArray(acted)) return acted;
  const result = acted as Record<string, unknown>;
  if (result.ok !== true || op.kind === 'saveDocToDisk') return acted;
  const unsaved = result.unsavedOnDisk;
  if (unsaved !== true) return acted;
  const authored = result.authoringMode === null || result.authoringMode === 'authored';
  return {
    ...result,
    persistence: {
      appliedTo: 'live editor document + undo ledger',
      onDisk: false,
      ...(authored
        ? {
            saveOp: { kind: 'saveDocToDisk', requestId: '<auto>' },
            note: '改动已在编辑器里生效、用户能撤销,但此刻还没写入磁盘 —— 这是正常的中间态,不代表操作失败。'
              + '要落盘就用 act 提交上面的 saveOp(requestId 工具会自动补);落盘状态以 look 返回的 liveTruth.unsavedOnDisk 为准。'
              + NO_SIDE_DOOR,
          }
        : {
            note: `当前场景处于 ${String(result.authoringMode)} 模式,不能保存到磁盘。改动在编辑器里有效但无法落盘,先把情况告诉用户。`
              + NO_SIDE_DOOR,
          }),
    },
  };
}

async function relayAsyncCode(
  code: string,
  deps: EditorUiBrowseDeps,
  timeoutMs: number = RELAY_READ_TIMEOUT_MS,
  /** act:可能合法地跑很久(大资产导入等)。烧满超时不等于传输死了。 */
  longOp = false,
): Promise<unknown> {
  const base = relayBaseUrl(deps);
  const known = relayHealth.get(base);
  // Already known dead: refuse in microseconds rather than burning another
  // timeout. A probe re-opens the breaker as soon as the page is back.
  if (known) {
    if (Date.now() < known.nextProbeAt) return known.diagnosis;
    const startedAt = Date.now();
    const probe = normalizeRelayValue(await relayEval('1', deps, RELAY_PROBE_TIMEOUT_MS));
    if (transportFailure(probe)) {
      const cost = Date.now() - startedAt;
      known.nextProbeAt = cost > SLOW_PROBE_MS ? Date.now() + RELAY_PROBE_COOLDOWN_MS : 0;
      return known.diagnosis;
    }
    relayHealth.delete(base);
  }
  const startedAt = Date.now();
  const result = await relayOnce(code, deps, timeoutMs);
  if (!transportFailure(result)) return result;
  // A call that burned its whole timeout means a wedged page is holding the
  // socket; probing that page costs the probe timeout too, so go quiet first.
  const elapsed = Date.now() - startedAt;
  const wedged = elapsed > SLOW_PROBE_MS;
  const diagnosis = await diagnoseDeadRelay(deps, result);
  // 长操作烧满了自己的超时,而页面仍连着中继 —— 这不是传输死亡。客户端的 abort
  // 只掐断了 HTTP 等待:中继侧超时更长(实测 120s),code 早已发给页面,页面会继续
  // 执行到完成,迟到的结果被中继丢弃。此时旧路径会返回"编辑器读写一律不可用"并
  // 指示"重试同一个调用" —— 照做就是重复导入/重复创建。宁可说"结果未知"。
  if (longOp && elapsed >= timeoutMs - 1_000 && diagnosis.error.pageConnected === true) {
    return {
      ok: false,
      error: {
        code: 'EDITOR_OP_INDETERMINATE',
        hint: `这个操作等了 ${Math.round(timeoutMs / 1000)} 秒仍无回执,但页面还连着中继(pageConnected=true)。`
          + '中继侧的超时比这里长,所以**页面很可能还在执行它、并且会执行完** —— 只是本次调用不再等了。'
          + '**不要重试这个操作**:重试会让它做两次(重复导入、重复创建)。'
          + '正确做法:等几秒,用 look 或重新打开目标核对它是否已经生效,再决定下一步;'
          + '并如实告诉用户"这一步的结果暂时未知",不要声称成功也不要声称失败。',
        retryable: false,
        owner: 'agent',
        observed: result.error.code,
        waitedMs: elapsed,
      },
    };
  }
  relayHealth.set(base, {
    downSince: Date.now(),
    diagnosis,
    nextProbeAt: wedged ? Date.now() + RELAY_PROBE_COOLDOWN_MS : 0,
  });
  return diagnosis;
}

async function relayOnce(
  code: string,
  deps: EditorUiBrowseDeps,
  timeoutMs: number,
): Promise<unknown> {
  return normalizeRelayValue(await relayEval(code, deps, timeoutMs));
}

function operationWithRequestId(op: Record<string, unknown>): Record<string, unknown> {
  if (
    typeof op.kind !== 'string'
    || !ASYNC_OPERATION_KINDS.has(op.kind)
    || typeof op.requestId === 'string' && op.requestId && op.requestId !== '<auto>'
  ) {
    return op;
  }
  return { ...op, requestId: `ui-browse-${crypto.randomUUID()}` };
}

function correctedOperation(op: Record<string, unknown>): Record<string, unknown> {
  if (typeof op.kind === 'string' && op.kind) return op;
  if (typeof op.id === 'string' && op.id) {
    const { id, ...rest } = op;
    return { kind: id, ...rest };
  }
  return { kind: '<在此填 gateway.listOps 中的操作 kind>', ...op };
}

function invalidOperationFailure(op: Record<string, unknown>, extra = ''): BrowseFailure {
  const corrected = correctedOperation(op);
  const diagnosis = typeof op.id === 'string' && !op.kind ? 'op 需要 kind 而不是 id。' : 'act 需要非空的 op.kind。';
  return failure(
    'INVALID_ARGS',
    `${diagnosis}正确调用:${JSON.stringify({ verb: 'act', op: corrected })}${extra}`,
  );
}

function withActRecovery(
  result: BrowseFailure,
  op: Record<string, unknown>,
  key: string,
): BrowseFailure {
  const corrected = correctedOperation(op);
  let extra = ` 正确调用:${JSON.stringify({ verb: 'act', op: corrected })}`;
  if (op.kind === 'bindAssetRef') {
    const known = mintedAssetGuids.get(key);
    const guids = Array.isArray(op.guids) ? op.guids.filter((value): value is string => typeof value === 'string') : [];
    if (known && guids.some((guid) => known.has(guid))) {
      extra += ' 已知问题(2026-08-03 已报 editor,修复后删除本分支):新铸材质暂不能绑定,绑既有材质可用。';
    }
  }
  return { ...result, error: { ...result.error, hint: `${result.error.hint}${extra}` } };
}

/** The static function table — the map of everything preset in ForgeaX, so an
 *  agent locates its target in ONE call and then walks the same path a human
 *  does. Every branch comes from a layer's OWN projection (menu registry via
 *  host.menubar, rail via host.sidebar, actions via the surface registry) —
 *  nothing here is hand-maintained, so nothing here can rot. Dynamic content
 *  (recent games, scene entities, assets) is deliberately absent: that is what
 *  open/look spend calls on. */
function runFind(args: Record<string, unknown>, deps: EditorUiBrowseDeps): unknown {
  const menus = readMenuTree(deps);
  const shell = readShell(deps);
  const surfaces = shellSurfaces(deps).map((surface) => ({
    id: surface.id,
    actions: aiActions(surface).map((action) => ({ id: action.id, argsSchema: action.argsSchema })),
  }));
  const table = {
    menus,
    rail: shell?.entries ?? [],
    surfaces,
  };
  // 第四路:ActionCatalog。菜单树/rail 都对不上号的 action = headless 能力 ——
  // 前端不存在通往它的界面。这必须在【定位】阶段就亮出来:2026-08-04 三轮实测,
  // agent 只要绕开直调(比如转头打开了相邻的可见插件),"你问的东西没有门"这个
  // 事实就永远没人告诉用户。
  const menuCommandIds = new Set<string>();
  const collectCommands = (nodes: MenuTreeNode[]): void => {
    for (const node of nodes) {
      if (typeof node.commandId === 'string') menuCommandIds.add(node.commandId);
      if (node.children) collectCommands(node.children);
    }
  };
  if (menus) for (const nodes of Object.values(menus)) collectCommands(nodes);
  // door 事实必须带出来:门对账靠它认"同一能力两个名字"(game.switch 的菜单门是
  // game.pick)。不带 = 下面又得自己判一次门,那正是本轮修掉的第二套判断。
  let catalogEntries: ReadonlyArray<{
    id: string; title?: string; description?: string; door?: { menuCommandId?: string };
  }> = [];
  try {
    catalogEntries = (deps.shell?.actions ?? catalogAll)();
  } catch {
    catalogEntries = [];
  }
  // 孤儿界面:已安装、AI 能打开,但 rail/更多插件里没有 —— 人类没有点击路径。
  // 必须在定位阶段亮牌,否则 agent 会向用户教一条不存在的进入路径(2026-08-04 实测)。
  let plugins: ReadonlyArray<{ id: string; workbenchId?: string; label: string; hidden?: boolean }> = [];
  try {
    plugins = (deps.shell?.plugins ?? installedWorkbenchPlugins)();
  } catch {
    plugins = [];
  }
  const railIds = new Set((shell?.entries ?? []).map((entry) => entry.id));
  // 2026-08-05 修正:上一版这里断言"用户自己点不到" —— 只对了 rail 一个账源就下
  // "没有"的结论。经实测,工作台网格(installed − hidden)列出全部插件且 tile 可点:
  // 打开任一插件 → 右上角 × 返回工作台 → 点 tile。"不在 rail"只证明不在 rail。
  const ORPHAN_NOTE = '该插件已安装,但不在 rail 的固定分类清单里 —— rail 和「更多插件」里都看不到它。用户仍可从**工作台网格**点到:打开任一插件后点右上角 × 返回工作台,再点对应 tile。教路径请教这一条真实存在的,不要描述「点更多插件进入」;并把"未收录进 rail 分类"作为产品缺口反馈。';
  // rail 投影缺席(页面没开/刚重启还没重新注册)时不做孤儿指控 —— 空对账源会把
  // 全部插件误判成孤儿(2026-08-04 活验踩到),宁可漏报不冤枉。
  const orphans = railIds.size === 0
    ? []
    : plugins.filter((plugin) => !plugin.hidden && plugin.workbenchId && !railIds.has(`wb:${plugin.workbenchId}`));

  const HEADLESS_NOTE = '菜单与 rail 的投影里都没有它的入口 —— 大概率是 headless 能力(界面上没有对应控件,人点不出来),只能经 ui_invoke 后台直调。使用前后都要向用户说明:屏幕上不会有任何变化;若用户指出界面上其实有按钮,以用户所见为准。';
  // 排除 workbench.*(门在 rail,action-door 已单独对账)与 app./panel. 命名空间
  // (shell 级动作,门是 rail 页签/侧栏控件,不在菜单树里)。这是 catalog 自己的
  // 命名空间语义,不是同义词表;精确到每个 action 的门位对账是 87 能力映射的正题。
  // 菜单投影缺席时不做 headless 指控 —— 空对账源会把**每一个**有菜单门的 action 都
  // 判成"没有门",等于向用户隐瞒真实的人类路径。与上面 railIds.size === 0 同一条原则:
  // 宁可漏报不冤枉。(2026-08-04 栈重启后 host.menubar 尚未重注册,这条路径就是活的。)
  // 2026-08-06 外审 MODERATE:这里此前自己维护第二套"有没有门"的判断 —— 只收菜单树
  // 里的原始 commandId,认不出 catalog 的 door 别名。于是 game.switch(门在 game.pick)
  // 被判成 headless,而它明明有可见菜单门。同一个"第二套真相"的病这已是第四次犯
  // (rail 表 / ASYNC_OPERATION_KINDS / H1 引用)。改成问唯一那套对账。
  const railEntries = shell?.entries ?? null;
  const isHeadless = (entry: { id: string; door?: { menuCommandId?: string } }): boolean =>
    findVisibleDoor({ menus, rail: railEntries, fact: entry.door }, entry.id).certainty === 'none';
  const headless = menus === null ? [] : catalogEntries
    .filter(isHeadless)
    .map((entry) => ({ actionId: entry.id, title: entry.title ?? entry.id, door: 'none' as const }));

  // 菜单投影缺席 = 这张表**不是**功能全集,而是一张读不到的表。
  // 2026-08-06 自探:上一版只给派生结论(headless/孤儿指控)加了 menus===null 豁免,
  // 主结论没护住 —— 表照发,文案照说"这是 ForgeaX 的静态功能表 / 上表是全部静态
  // 功能",于是栈重启后(surfaces 是纯内存 Map,已开页面不会重新注册,GET /pending
  // 又不做懒注册)agent 会直接告诉用户"ForgeaX 没有这个功能"。
  const PROJECTION_BLIND = menus === null;
  const BLIND_NOTE = '菜单投影当前读不到(页面没打开,或栈刚重启、页面尚未重新注册)——'
    + '**这张表不是功能全集,而是一张空表**。绝对不要据此告诉用户"没有这个功能/没有入口";'
    + '如实说明功能表暂时读不到,请用户刷新一次 ForgeaX 页面后重试。';

  const query = typeof args.query === 'string' ? args.query.trim().toLocaleLowerCase() : '';
  if (!query) {
    if (PROJECTION_BLIND) {
      return { ok: false, error: { code: 'PROJECTION_UNAVAILABLE', hint: BLIND_NOTE } };
    }
    return { ok: true, table: { ...table,
      headlessActions: { note: HEADLESS_NOTE, items: headless },
      railUnlisted: { note: ORPHAN_NOTE, items: orphans.map((plugin) => ({ extensionId: plugin.id, label: plugin.label })) } },
      hint: '这是 ForgeaX 的静态功能表(菜单树/rail/各面动作)。定位到目标后,用 open("menu:<top>/<项>/...") 沿人类路径逐级打开;链尾是命令项则会经菜单自己的命令入口执行。动态内容(最近游戏、场景实体、资产)不在表里,展开对应层级后才可见。' };
  }
  const matches: Array<{ node: string; label: string; kind: string; keybinding?: string }> = [];
  const walkMenu = (menuId: string, nodes: MenuTreeNode[], prefix: string[]): void => {
    for (const node of nodes) {
      const hit = node.label.toLocaleLowerCase().includes(query) || node.id.toLocaleLowerCase().includes(query);
      const chain = `menu:${menuId}${prefix.length ? '/' + prefix.join('/') : ''}/${node.label}`;
      if (hit) {
        matches.push({ node: node.kind === 'submenu' && prefix.length === 0 && nodes.length === 1 ? chain : chain,
          label: node.label, kind: node.kind, ...(node.keybinding ? { keybinding: node.keybinding } : {}) });
      }
      if (node.children) walkMenu(menuId, node.children, [...prefix, node.label]);
    }
  };
  if (menus) for (const [menuId, nodes] of Object.entries(menus)) walkMenu(menuId, nodes, []);
  for (const entry of shell?.entries ?? []) {
    if (entry.label.toLocaleLowerCase().includes(query) || entry.id.toLocaleLowerCase().includes(query)) {
      matches.push({ node: `rail:${entry.id}`, label: entry.label, kind: 'rail-tab' });
    }
  }
  for (const surface of surfaces) {
    for (const action of surface.actions) {
      if (action.id.toLocaleLowerCase().includes(query) || surface.id.toLocaleLowerCase().includes(query)) {
        matches.push({ node: `act {surface:'${surface.id}', action:'${action.id}'}`, label: `${surface.id}.${action.id}`, kind: 'surface-action' });
      }
    }
  }
  for (const plugin of orphans) {
    if (!`${plugin.id} ${plugin.label}`.toLocaleLowerCase().includes(query)) continue;
    matches.push({
      node: `ui_invoke {actionId:'workbench.open_plugin', args:{extensionId:'${plugin.id}'}}`,
      label: plugin.label,
      kind: 'rail-unlisted-plugin',
      door: ORPHAN_NOTE,
    } as never);
  }
  // 门对账算出来的 path 不能丢(2026-08-06 外审 MODERATE):上一版只把结果当布尔用,
  // 于是 find("切换游戏") 不再误报 headless(对了),但 matches 直接空了(更没用)——
  // 用户问的正是"这功能从界面怎么进",而入口明明已经算出来了。每个条目只对账一次。
  for (const entry of catalogEntries) {
    const text = `${entry.id} ${entry.title ?? ''} ${entry.description ?? ''}`.toLocaleLowerCase();
    if (!text.includes(query)) continue;
    if (menus === null) continue; // 同上:菜单投影缺席时不指控 headless
    const door = findVisibleDoor({ menus, rail: railEntries, fact: entry.door }, entry.id);
    if (door.certainty === 'none') {
      matches.push({
        node: `ui_invoke {actionId:'${entry.id}'}`,
        label: entry.title ?? entry.id,
        kind: 'headless-action',
        door: HEADLESS_NOTE,
      } as never);
      continue;
    }
    if ((door.certainty === 'found' || door.certainty === 'declared') && door.path) {
      matches.push({
        node: `open('${door.path.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')`,
        label: entry.title ?? entry.id,
        kind: 'catalog-action-with-door',
        door: door.hint,
      } as never);
      continue;
    }
    // unknown / 有门但拿不到 path(如 argsDiffer):照样进 matches,hint 已经写明
    // "门位未知,不要说没有入口"。空着比说错好,但"什么都不给"是第三种错。
    matches.push({
      node: `ui_invoke {actionId:'${entry.id}'}`,
      label: entry.title ?? entry.id,
      kind: 'catalog-action',
      door: door.hint,
    } as never);
  }
  return {
    ok: true,
    matches,
    ...(matches.length === 0
      ? PROJECTION_BLIND
        ? { table, projectionUnavailable: true, hint: BLIND_NOTE }
        : { table, hint: `没有静态功能匹配「${args.query}」。上表是全部静态功能。动态内容不在表里:场景实体(如"树干")直接用 look —— 它自带全部实体的名字花名册;游戏在 open("menu:file/打开最近") 展开后可见;资产在 open("panel:ep:assets")。` }
      : {}),
  };
}

async function runLook(key: string, deps: EditorUiBrowseDeps): Promise<unknown> {
  // The shell half is a local read that works in either mode, so it answers even
  // when the editor viewport is gone. Ask it first and skip the relay entirely
  // when the editor is not in front — otherwise every look in the AI workspace
  // would burn the full relay timeout to learn what the shell already knows.
  const shell = readShell(deps);
  const surfaces = shellSurfaces(deps).map((surface) => ({
    id: surface.id,
    layer: surface.layer,
    actions: aiActions(surface).map((action) => ({ id: action.id, argsSchema: action.argsSchema })),
  }));
  if (shell && shell.mode !== 'scene') {
    return {
      shell: { ...shell, surface: SHELL_SURFACE, surfaces },
      editor: null,
      // 2026-08-06 外审 B1:不再指路 open('rail:editor')(rail 门无发布者,必死)。
      hint: `工作区在 AI 侧(rail tab: ${shell.workbenchTab || '未知'}),编辑器视口没有挂载,读不到场景。要看/改场景请用户点左上 rail 的 Scene 页签切回编辑器。`,
    };
  }
  const looked = await relayAsyncCode(compileLook(), deps);
  if (isFailure(looked)) return looked;
  if (!looked || typeof looked !== 'object') return looked;
  // First look of a session carries the whole static map, so most tasks need no
  // separate find call at all: locate on the map, then walk.
  let staticTable: unknown;
  if (!staticTableSent.has(key)) {
    staticTableSent.add(key);
    staticTable = { menus: readMenuTree(deps), rail: shell?.entries ?? [], surfaces,
      note: '静态功能表(仅本会话首次 look 附带;之后用 find 查询)。定位后用 open("menu:<top>/<项>/...") 沿人类路径逐级打开。' };
  }
  return { ...(looked as Record<string, unknown>),
    ...(shell ? { shell: { ...shell, surface: SHELL_SURFACE, surfaces } } : {}),
    ...(staticTable ? { staticTable } : {}) };
}

async function runOpen(
  args: Record<string, unknown>,
  key: string,
  deps: EditorUiBrowseDeps,
): Promise<unknown> {
  if (typeof args.node !== 'string' || !args.node) {
    return failure('INVALID_ARGS', 'open requires node "panel:<id-or-title>", "entity:<handle-or-name>", "menu:<id-or-label>", or "rail:<tab-or-label>"');
  }
  // 资产没有独立的 open 分支 —— 这个前缀曾出现在错误提示里但从未实现,agent 会按
  // 提示试、失败、再试(2026-08-05 实测两连败)。给一条明确的真路,别让它猜。
  if (args.node.startsWith('asset:')) {
    return failure('INVALID_ARGS',
      "资产没有 asset: 前缀的 open。看全量资产(含颜色/被谁使用)用 open('panel:ep:assets');"
      + '要改某实体引用的资产,用 open("entity:<名字>") 拿 affordance.op(bindAssetRef)后 act 提交。');
  }
  if (!args.node.startsWith('rail:')) {
    const blocked = editorForegroundFailure(deps);
    if (blocked) return blocked;
  }
  if (args.node.startsWith('panel:')) {
    const queryText = args.node.slice('panel:'.length);
    if (!queryText) return failure('INVALID_ARGS', 'open panel requires a non-empty panel id or title');
    const resolved = await relayAsyncCode(compileResolveUiReferent('panel', queryText), deps);
    if (isFailure(resolved)) return panelNotFoundWithMenuDoor(resolved, queryText, deps);
    const target = resolved as { id?: unknown; label?: unknown; node?: unknown };
    if (typeof target.id !== 'string' || typeof target.label !== 'string') return failure('INVALID_PAGE_STATE', 'panel resolver returned no id or label');
    const opened = await relayAsyncCode(compileOpenPanel(target.id, target.label), deps);
    return opened;
  }
  if (args.node.startsWith('entity:')) {
    const queryText = args.node.slice('entity:'.length);
    if (!queryText) return failure('INVALID_ARGS', 'open entity requires a non-empty handle or Name');
    const resolved = await relayAsyncCode(compileResolveEntity(queryText), deps);
    if (isFailure(resolved)) return resolved;
    const target = resolved as { handle?: unknown; node?: unknown };
    if (typeof target.handle !== 'number') return failure('INVALID_PAGE_STATE', 'entity resolver returned no numeric handle');
    const handle = target.handle;
    const opened = await relayAsyncCode(compileOpenEntity(handle, args.includeTransient === true), deps);
    return opened;
  }
  if (args.node.startsWith('menu:')) {
    const chainText = args.node.slice('menu:'.length);
    if (!chainText) return failure('INVALID_ARGS', 'open menu requires "menu:<top>" or a chain "menu:<top>/<item>/..."');
    const segments = chainText.split('/').map((segment) => segment.trim()).filter(Boolean);
    if (segments.length === 0) return failure('INVALID_ARGS', 'open menu requires at least a top-level menu id or label');
    if (segments.length > 1) return await runOpenMenuChain(segments, deps);
    const resolved = await relayAsyncCode(compileResolveUiReferent('menu', segments[0]!), deps);
    if (isFailure(resolved)) return resolved;
    const target = resolved as { id?: unknown; label?: unknown; node?: unknown };
    if (typeof target.id !== 'string' || typeof target.label !== 'string') return failure('INVALID_PAGE_STATE', 'menu resolver returned no id or label');
    const opened = await relayAsyncCode(compileOpenMenu(target.id, target.label), deps);
    if (isFailure(opened)) return opened;
    if (!opened || typeof opened !== 'object' || !Array.isArray((opened as { items?: unknown }).items)) return opened;
    const menuResult = opened as { items: unknown[] } & Record<string, unknown>;
    return {
      ...menuResult,
      items: dedupeMenuItems(menuResult.items.filter((item): item is string => typeof item === 'string')),
    };
  }
  // The rail lives outside the editor viewport, so it goes through the shell's
  // own door rather than the editor relay. Falls back to the page recipe only
  // when no shell surface is registered at all.
  if (args.node.startsWith('rail:')) {
    const queryText = args.node.slice('rail:'.length);
    if (!queryText) return failure('INVALID_ARGS', 'open rail requires a non-empty tab id or label');
    return await runOpenRail(queryText, deps);
  }
  return failure('INVALID_ARGS', 'open requires node "panel:<id-or-title>", "entity:<handle-or-name>", "menu:<id-or-label>", or "rail:<tab-or-label>"');
}

async function runSingleAct(
  op: Record<string, unknown>,
  key: string,
  deps: EditorUiBrowseDeps,
): Promise<unknown> {
  if (typeof op.kind !== 'string' || !op.kind) {
    return invalidOperationFailure(op);
  }
  const blocked = editorForegroundFailure(deps);
  if (blocked) return blocked;
  const acted = await relayAsyncCode(compileAct(operationWithRequestId(op)), deps, RELAY_ACT_TIMEOUT_MS, true);
  if (isFailure(acted)) return withActRecovery(acted, op, key);

  const withPersistence = annotatePersistence(acted, op);
  if (op.kind === 'createMaterial' && typeof op.guid === 'string' && op.guid) {
    const known = mintedAssetGuids.get(key) ?? new Set<string>();
    known.add(op.guid);
    mintedAssetGuids.set(key, known);
  }
  return annotateWorldVisibility(withPersistence, op, deps);
}

/** 世界写路径的可见性注解(2026-08-06 外审 B2)。
 *
 *  可见性护栏此前只装在 shell 门:gateway act(改场景/改材质)的返回体没有
 *  `visible_change` 键 → metrics 记 null → verify 的 silent-call 检测(=== false)
 *  对世界写入**永不触发**,而 charter 却把该字段承诺成 act 返回的一部分 ——
 *  08-04 树冠事故(40 调用零失败、颜色没变)走的正是这条没有护栏的路。
 *
 *  测量对象如实标注:这里测的是**编辑器文档本身**(rev 前进 + `after` 字段回读),
 *  不是视口像素。多页在线时连"用户那一页"都证明不了 → 降级 null + 多页事实。 */
function annotateWorldVisibility(result: unknown, op: Record<string, unknown>, deps: EditorUiBrowseDeps): unknown {
  if (!result || typeof result !== 'object' || isFailure(result)) return result;
  const r = result as Record<string, unknown>;
  if ('visible_change' in r) return r;
  const manyPages = multiPageWarning(deps, MENUBAR_SURFACE);
  if (manyPages) {
    return { ...r, visible_change: null, multiplePages: manyPages };
  }
  const rev = r.rev;
  const after = r.after;
  // 回读**有没有真的发生**:`compileAct` 的 readAfter() 对不带 entity/component 的
  // op(transaction / deleteEntity / createMaterial / saveDocToDisk / createSceneFile)
  // 第一行就 `return {}` —— 空对象是"没读",不是"读到了空"。只判 typeof object 的话,
  // `{}` 会通过,于是对着零回读宣称"after=字段回读值"。而 transaction 正是工具主动
  // 推荐的多步路径,charter 又教 agent"act 的返回就是验证" —— 三者叠起来就是
  // 08-04 树冠事故的完整形状,只是换了个入口(2026-08-06 自探,本轮 B2 修复引入)。
  const readBack = !!after && typeof after === 'object' && Object.keys(after as object).length > 0;
  if (typeof rev === 'number' && readBack) {
    return {
      ...r,
      visible_change: `编辑器文档已按 ${String(op.kind)} 变更(rev=${rev},after=字段回读值)`
        + '—— 这是文档级测量,属性面板与视口由同一文档驱动;不是视口像素比对。',
    };
  }
  if (typeof rev === 'number') {
    // 有代际、无逐字段回读:代际前进是**真证据**(网关确实改了文档),但它证明不了
    // 改成了什么。如实分级,别冒领字段级确认。
    const ledgerKind = (r.ledger as { kind?: unknown } | undefined)?.kind;
    return {
      ...r,
      visible_change: `编辑器文档已变更(rev=${rev}${typeof ledgerKind === 'string' ? `,账本记为 ${ledgerKind}` : ''})`
        + ` —— 本 op(${String(op.kind)})不做逐字段回读,只证明"文档动了",**证明不了每一项都改成了你要的值**。`
        + '要向用户确认具体结果,请 look 或 open 目标实体回读。',
      fieldReadback: false,
    };
  }
  // 连代际都没有(如异步操作尚未回灌):按"测过、没变"从严 —— 宁可逼一次 verify,
  // 也不许 agent 据 ok:true 向用户宣称"改好了"。
  return { ...r, visible_change: null };
}

/** A shell-surface op: `{surface, action, args}`. Any surface, any action it
 *  published — no allow-list here, because the allow-list is the surface's own
 *  `exposedToAI` flag and its argsSchema. This is the generic write path other
 *  teams get for free once they register a surface. */
async function runShellAct(
  op: Record<string, unknown>,
  deps: EditorUiBrowseDeps,
): Promise<unknown> {
  const surfaceId = String(op.surface);
  const action = typeof op.action === 'string' ? op.action : '';
  const surfaces = shellSurfaces(deps);
  const surface = surfaces.find((candidate) => candidate.id === surfaceId);
  if (!surface) {
    return {
      ok: false,
      error: {
        code: 'NOT_FOUND',
        kind: 'surface',
        hint: `没有注册名为 ${surfaceId} 的面`,
        candidates: surfaces.map((candidate) => ({ node: `surface:${candidate.id}`, label: candidate.id, where: '已注册' })),
      },
    };
  }
  const actions = aiActions(surface);
  const chosen = actions.find((candidate) => candidate.id === action);
  if (!chosen) {
    return {
      ok: false,
      error: {
        code: 'NOT_FOUND',
        kind: 'action',
        hint: `面 ${surfaceId} 没有发布名为 ${action || '(空)'} 的 AI 可调动作`,
        candidates: actions.map((candidate) => ({ node: `${surfaceId}.${candidate.id}`, label: candidate.id, where: '已发布' })),
        argsSchemas: Object.fromEntries(actions.map((candidate) => [candidate.id, candidate.argsSchema])),
      },
    };
  }
  const moved = await dispatchShellAction(deps, surfaceId, action, op.args ?? {});
  if (isFailure(moved)) return moved;
  const manyPages = multiPageWarning(deps, surfaceId);
  return {
    ok: true,
    via: `${surfaceId}.${action}`,
    ...(moved.token ? { token: moved.token } : {}),
    snapshot: moved.after,
    stateChanged: moved.reached,
    visible_change: moved.reached && !manyPages ? `${surfaceId} 的状态已按 ${action} 更新` : null,
    ...(manyPages ? { multiplePages: manyPages } : {}),
    ...(moved.reached || manyPages
      ? {}
      : { hint: `${surfaceId} 已回执,但它发布的 snapshot 没有变化 —— 不要向用户声称界面变了。` }),
  };
}

async function runAct(
  args: Record<string, unknown>,
  key: string,
  deps: EditorUiBrowseDeps,
): Promise<unknown> {
  if (args.op && typeof args.op === 'object' && !Array.isArray(args.op) && 'surface' in args.op) {
    return await runShellAct(args.op as Record<string, unknown>, deps);
  }
  if (!args.op || typeof args.op !== 'object' || Array.isArray(args.op)) {
    return failure('INVALID_ARGS', 'act 要一个 EditorOp 对象。正确调用:{"verb":"act","op":{"kind":"setSelection","id":null}}。一次只提交一个 op —— 多步就多调用几次,每次都是原子的、单独可撤销的。');
  }
  return await runSingleAct(args.op as Record<string, unknown>, key, deps);
}


async function appendBrowseMetric(
  ctx: HostToolRunCtx,
  verb: unknown,
  node: unknown,
  result: unknown,
  durationMs: number,
): Promise<void> {
  try {
    const directory = join(ctx.projectRoot, '.forgeax');
    await mkdir(directory, { recursive: true });
    const failed = isFailure(result);
    const errorCode = failed ? result.error.code : null;
    // visible_change 是"用户看得见吗"的观测结论。三态(2026-08-06 外审 B2):
    //   true  = 测到了变化;
    //   false = **测过、没变**(silent-call 检测的输入);
    //   null  = **没能测**(字段缺席,或多页在线导致"用户那页"不可证)。
    // 此前 null 与 false 混同:多页降级会被当"测到没变"报给 agent(把好功能说成
    // 没接线),而字段缺席的世界写入永远进不了 silent 集。
    const rawVisible = !failed && result && typeof result === 'object' && 'visible_change' in result
      ? (result as { visible_change?: unknown }).visible_change
      : undefined;
    const unmeasurable = rawVisible === null
      && !!(result as { multiplePages?: unknown } | null | undefined)?.multiplePages;
    const visibleChange = rawVisible === undefined || unmeasurable ? null : rawVisible !== null;
    await appendFile(join(directory, 'ui-browse-metrics.jsonl'), `${JSON.stringify({
      ts: new Date().toISOString(),
      sid: ctx.sid ?? null,
      agentId: ctx.agentId,
      // 连接键(2026-08-06 外审):这份旁账此前只有 sid+agent+时间戳,"哪次用户请求
      // 导致了哪次 UI 操作"只能靠时间猜。callId 与工具审计账、agent 事件账本的
      // hook:toolCall.payload.callId 逐字相等。**有值才带键** —— 消费方据"有没有
      // 这个键"判断能不能 join,写 null 会让它以为能 join 然后连到错的地方。
      ...(ctx.callId ? { callId: ctx.callId } : {}),
      // 租用内核(codex 经 MCP)那条路上,内核 callId 结构上过不来,这一行只有它可连:
      // 它随工具结果的 structuredContent 回给内核,编排层据此绑回主账本的 callId。
      ...(ctx.toolExecutionId ? { toolExecutionId: ctx.toolExecutionId } : {}),
      verb: typeof verb === 'string' ? verb : null,
      node: typeof node === 'string' ? node : null,
      ok: !failed,
      errorCode,
      visibleChange,
      durationMs,
    })}\n`, 'utf8');
  } catch {
    // Metrics are diagnostic only. A read-only/full/unavailable project root
    // must never change editor tool semantics.
  }
}

/** 世界代际连续性检查 —— 零额外往返,只看本来就在返回体里的 `rev`。
 *
 *  rev 单调递增于一个已加载的文档;**倒退**只可能是文档重新加载,或者中继把调用
 *  路由到了另一个页面(last-connection-wins,且中继不带页面身份)。两种情况的后果
 *  是同一个,而且都必须让用户知道:你先前那几刀可能不在用户眼前这个页面上。
 *  2026-08-04 实测:用户两次改色之间 rev 从 7 掉回 1,第二刀落到了别的页面,
 *  磁盘和屏幕都没有他要的结果,而工具全程返回 ok。 */
function annotateContinuity(result: unknown, key: string): unknown {
  if (!result || typeof result !== 'object') return result;
  const { rev, pageId } = result as { rev?: unknown; pageId?: unknown };
  if (typeof rev !== 'number') return result; // 只有带 rev/pageId 的返回体(look / act)能对账

  const priorPage = lastSeenPage.get(key);
  if (typeof pageId === 'string') lastSeenPage.set(key, pageId);
  const priorRev = lastSeenRev.get(key);
  lastSeenRev.set(key, rev);

  // 主判据:执行页换了。中继只认最后连上的页面,而它不带身份 —— 用户开第二个
  // ForgeaX 标签页就足以让后续调用悄悄落到他没在看的那一页上。
  const swapped = typeof pageId === 'string' && priorPage !== undefined && pageId !== priorPage;
  // 次判据:同一页但 rev 倒退 = 文档被重新加载,之前的改动连同 undo 栈一起没了。
  const reloaded = !swapped && priorRev !== undefined && rev < priorRev;
  if (!swapped && !reloaded) return result;

  const cause = swapped
    ? '中继把这次调用发到了**另一个 ForgeaX 页面**(它只认最后连上的那个,且不带页面身份)'
    : `编辑器文档被**重新加载**了(rev ${priorRev} → ${rev},undo 栈同时清空)`;
  return {
    ...(result as Record<string, unknown>),
    worldReloaded: `⚠️ ${cause}。**你先前几步的改动可能已经不在用户眼前这一页上。**`
      + '这次调用本身的结果是真的,但它作用的世界不是之前那个。'
      + '必须把这件事告诉用户:请他只留一个 ForgeaX 页面、刷新,然后你重新 look 确认当前状态再继续 ——'
      + '在此之前不要声称早先的改动还在。',
  };
}

interface BrowseMetricRow {
  ts?: string; sid?: string | null; agentId?: string;
  verb?: string | null; node?: string | null;
  ok?: boolean; errorCode?: string | null; visibleChange?: boolean | null;
}

/** 本轮的调用账 —— 从工具自己写的指标文件里读回来,零 relay 成本。
 *
 *  `available` 区分"读到了、本轮没有行"与"根本没读到"。两者此前都是空数组,而
 *  verify 会在空数组上宣告"每一步都观察到了界面变化" —— 防幻觉的最后一道防线
 *  自己 fail-open(2026-08-06 自探)。
 *
 *  轮界 `since` **优先从文件里取**:上一次 verify 自己也写了一行(见
 *  appendBrowseMetric 无差别记账)。此前只用模块级内存的 lastVerifyAt,dev 栈一
 *  重启它就归零 → since=0 → 该 session 的**全部历史行**都被算成"本轮",verify 于是
 *  播报几小时前的失败并叫 agent"现在必须更正"真实成果(实测该文件里最大一组
 *  93 行跨 3 小时、含 17 行 ok:false)。文件是跨重启存活的那一份真相。 */
async function roundCalls(
  ctx: HostToolRunCtx,
  sinceInMemory: number,
): Promise<{ rows: BrowseMetricRow[]; available: boolean }> {
  let raw: string;
  try {
    raw = await readFile(join(ctx.projectRoot, '.forgeax', 'ui-browse-metrics.jsonl'), 'utf8');
  } catch {
    return { rows: [], available: false };
  }
  const mine = raw.split('\n').slice(-400).flatMap((line) => {
    if (!line.trim()) return [];
    let row: BrowseMetricRow;
    try { row = JSON.parse(line) as BrowseMetricRow; } catch { return []; }
    if ((row.sid ?? null) !== (ctx.sid ?? null) || row.agentId !== ctx.agentId) return [];
    return [row];
  });
  const lastVerifyTs = mine.reduce((acc, row) => {
    if (row.verb !== 'verify') return acc;
    const ts = Date.parse(row.ts ?? '');
    return Number.isFinite(ts) && ts > acc ? ts : acc;
  }, 0);
  const since = Math.max(sinceInMemory, lastVerifyTs);
  return {
    rows: mine.filter((row) => row.verb !== 'verify' && Date.parse(row.ts ?? '') > since),
    available: true,
  };
}

/** 一轮 QA 收尾时的产出核对 —— **一次调用**,不是每步都调。
 *
 *  它不问"我的调用成功了吗"(那个每步的返回体已经答过了),它问的是三件调用返回
 *  答不了的事:①这一轮我实际做了几步、哪几步失败、哪几步声称成功却没观察到界面
 *  变化;②世界里真的留下了什么(账本、rev、落盘状态);③我这一轮是不是一直待在
 *  同一个世界里。2026-08-04 那个会话 40 次调用零失败、屏幕上一棵树都没变色 ——
 *  逐步核对全部通过,收尾核对才会发现不对。
 *
 *  自限流:上次 verify 之后没有任何实际动作 → 直接返回,不发 relay。所以"多调
 *  几次"是免费的,不需要靠模型自律去克制。旧的 staleness 校准死于反面的毛病 ——
 *  每个叶子前都强制多一趟 relay,而它一次都没触发过。 */
async function runVerify(key: string, ctx: HostToolRunCtx, deps: EditorUiBrowseDeps): Promise<unknown> {
  const since = lastVerifyAt.get(key) ?? 0;
  const { rows: calls, available: ledgerAvailable } = await roundCalls(ctx, since);
  // 早退必须**内存与磁盘都**说本轮没动过手(2026-08-06 外审 MODERATE)。roundDirty 是
  // 模块级内存,dev 栈一重启就空,而磁盘账里明明有本轮的 act/open —— 旧条件会在
  // 最该核对的时候返回"上一次的结论仍然有效"。
  const memoryShowsMutation = roundDirty.has(key);
  // **任何** act/open 行都禁止 no-op 早退,失败的也算 —— 与内存标脏同语义。
  // 上一轮我在这里写了 `row.ok !== false`,恰好把最需要核对的那一类排除掉:超时/
  // 结果未知的失败语义正是"可能已经执行、世界可能已变"(同文件 roundDirty 那段
  // 注释就是为它写的)。重启后内存为空、磁盘只剩失败行 → verify 返回 no-op,
  // 在最该核对的时刻拒绝核对(2026-08-06 外审实跑复现)。确定没执行的失败多核
  // 一次只花一趟 relay,而漏核一次可能让 agent 对用户宣称一个没发生的结果。
  const ledgerShowsMutation = calls.some((row) => row.verb === 'act' || row.verb === 'open');
  const rebuiltRoundFromLedger = !memoryShowsMutation && ledgerShowsMutation;
  if (!memoryShowsMutation && ledgerAvailable && !ledgerShowsMutation) {
    return {
      ok: true,
      skipped: 'no-op',
      callsThisRound: calls.length,
      hint: '上次核对之后没有产生任何实际动作(act / open),没有新东西可核 —— 上一次的结论仍然有效。'
        + 'verify 是一轮 QA 收尾时调一次的,不要每步都调。',
    };
  }
  // 内存计数与磁盘账对不上 = 账本不可信。roundDirty 已经证明这一轮动过手,
  // 若账里一行都没有,那是**读不到账**,不是"什么都没发生"。
  const actedThisRound = roundActCount.get(key) ?? 0;
  const ledgerBlind = !ledgerAvailable || (actedThisRound > 0 && calls.length === 0);
  lastVerifyAt.set(key, Date.now());
  roundDirty.delete(key);
  roundActCount.delete(key);

  const failedCalls = calls.filter((row) => row.ok === false);
  const silentCalls = calls.filter((row) => row.ok !== false && row.visibleChange === false);
  const priorPage = lastSeenPage.get(key);

  const blocked = editorForegroundFailure(deps);
  const world = blocked ? null : await relayAsyncCode(compileVerifySnapshot(), deps);
  const worldOk = world !== null && !isFailure(world) && !!world && typeof world === 'object';
  const w = worldOk ? world as {
    rev?: number; pageId?: string; unsavedOnDisk?: boolean | null;
    selection?: unknown; ledgerTail?: Array<{ kind: string | null; origin: string | null }>; screen?: unknown;
  } : null;

  const concerns: string[] = [];
  if (rebuiltRoundFromLedger) {
    concerns.push('本轮范围是从磁盘账重建的(进程重启过,内存轮界已丢失)——'
      + '统计可能把重启前尚未核对的步骤算进来,逐条对照时以你实际做过的为准。');
  }
  if (ledgerBlind) {
    concerns.push(`调用账读不到(内存记着本轮动过 ${actedThisRound} 次手,账里却是 ${calls.length} 行)——`
      + '**这一轮的"失败为零/每步都可见"无从谈起**。不要把"没有发现问题"说成"一切正常";'
      + '如实告诉用户核对账不可用,并逐条回忆你实际做过什么请他确认。');
  }
  if (failedCalls.length) {
    concerns.push(`本轮有 ${failedCalls.length} 步失败(${[...new Set(failedCalls.map((row) => row.errorCode ?? '未知'))].join('、')})——`
      + '如果你已经把它们当成功讲给了用户,现在必须更正。');
  }
  if (silentCalls.length) {
    concerns.push(`本轮有 ${silentCalls.length} 步返回成功但**没有观察到界面变化**(${[...new Set(silentCalls.map((row) => row.node ?? row.verb ?? '?'))].join('、')})——`
      + '不要向用户声称这些步骤"打开了/改好了",如实说你没看见变化并请他确认。');
  }
  if (w?.unsavedOnDisk === true) {
    concerns.push('改动还**没有落盘**(unsavedOnDisk=true)。要么用 act({kind:"saveDocToDisk"}) 保存,'
      + '要么明确告诉用户"改动在编辑器里生效了但还没保存" —— 不要默认用户知道。');
  }
  if (typeof w?.pageId === 'string' && priorPage !== undefined && w.pageId !== priorPage) {
    concerns.push('收尾时读到的执行页与本轮之前的不是同一个 —— 你这一轮的改动可能不在用户眼前这一页上,先请他只留一个页面刷新再复核。');
  }
  const manyPages = multiPageWarning(deps, SHELL_SURFACE);
  if (manyPages) concerns.push(manyPages);
  if (blocked) {
    concerns.push('编辑器视口当前不在前台,这次核对只覆盖了工具调用账,**没有读到场景状态** —— 不要据此断言场景里的东西是好的。');
  } else if (!worldOk) {
    concerns.push('读不到世界状态(中继无响应),这次核对只覆盖了工具调用账 —— 不要据此断言场景状态。');
  }

  return {
    ok: true,
    // 账本可信度如实标注 —— 免检单只有在账真的读到时才作数。
    ...(ledgerBlind ? { ledgerAvailable: false, actedThisRound } : {}),
    round: {
      calls: calls.length,
      byVerb: calls.reduce<Record<string, number>>((acc, row) => {
        const verb = row.verb ?? '?';
        acc[verb] = (acc[verb] ?? 0) + 1;
        return acc;
      }, {}),
      failed: failedCalls.map((row) => ({ verb: row.verb, node: row.node, errorCode: row.errorCode })),
      noVisibleChange: silentCalls.map((row) => ({ verb: row.verb, node: row.node })),
      // 测不到 ≠ 测到没变:act/open 里可见性没能测量的步数(多页降级等)单独报,
      // 不混进 noVisibleChange 的指控里。
      ...(calls.some((row) => row.ok !== false && (row.verb === 'act' || row.verb === 'open') && row.visibleChange === null)
        ? { unmeasured: calls.filter((row) => row.ok !== false && (row.verb === 'act' || row.verb === 'open') && row.visibleChange === null).length }
        : {}),
    },
    world: w
      ? { rev: w.rev, unsavedOnDisk: w.unsavedOnDisk, selection: w.selection, ledgerTail: w.ledgerTail, screen: w.screen }
      : null,
    concerns,
    hint: concerns.length
      ? '把上面每一条 concern 都和你**准备对用户说的话**逐条对照:对不上的,改口或如实说明,不要报喜。'
        + 'ledgerTail 是世界里真正留下的东西 —— 以它为准,不是以你记得自己做过什么为准。'
      : '本轮没有发现自相矛盾之处:失败为零、每一步都观察到了界面变化、世界代际连续。'
        + '仍然请把 ledgerTail 与你要汇报的内容对一遍再开口 —— 调用成功不等于用户拿到了他要的东西。',
  };
}

async function runBrowse(
  args: Record<string, unknown>,
  ctx: HostToolRunCtx,
  deps: EditorUiBrowseDeps,
): Promise<unknown> {
  const verb = args.verb as BrowseVerb | undefined;
  if (!['look', 'open', 'act', 'find', 'verify'].includes(verb ?? '')) {
    return failure('INVALID_ARGS', 'verb must be look, open, act, find, or verify');
  }
  const key = sessionKey(ctx);
  if (verb === 'find') return runFind(args, deps);
  if (verb === 'verify') return annotateContinuity(await runVerify(key, ctx, deps), key);
  const result = verb === 'look'
    ? await runLook(key, deps)
    : verb === 'open'
      ? await runOpen(args, key, deps)
      : await runAct(args, key, deps);
  // 只有真的动过东西才需要收尾核对;look 不算。
  // 标脏 = "本轮动过东西,收尾该核一遍"。成功当然算;**超时/结果未知也必须算** ——
  // 那类失败的语义正是"可能已经执行、世界可能已变",工具自己的提示也写着"先用
  // look/verify 核对实际状态"。若不标脏,agent 照提示调 verify 会得到"没有新动作、
  // 上次结论仍有效",在最该核对的时刻拒绝核对,还可能诱导它重试(重试即双跑)。
  // 2026-08-05 终审发现。
  const indeterminate = isFailure(result)
    && (result.error.timedOut === true || String(result.error.code ?? '').includes('INDETERMINATE'));
  if ((verb === 'act' || verb === 'open') && (!isFailure(result) || indeterminate)) {
    roundDirty.add(key);
    roundActCount.set(key, (roundActCount.get(key) ?? 0) + 1);
  }
  return annotateContinuity(result, key);
}

/** Register the semantic editor navigation surface over the live gateway. */
export function editorUiBrowseHostTools(deps: EditorUiBrowseDeps = {}): HostToolSpec[] {
  return [
    {
      name: 'editor_ui_browse',
      description: DESCRIPTION,
      inputSchema: INPUT_SCHEMA,
      run: async (args, ctx) => {
        const startedAt = performance.now();
        let result: unknown;
        try {
          result = await runBrowse(args, ctx, deps);
          return result;
        } catch (error) {
          result = failure('UNCAUGHT_ERROR', error instanceof Error ? error.message : String(error));
          throw error;
        } finally {
          await appendBrowseMetric(ctx, args.verb, args.node, result, Math.max(0, Math.round(performance.now() - startedAt)));
        }
      },
    },
  ];
}
