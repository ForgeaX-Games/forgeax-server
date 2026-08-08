import { afterEach, describe, expect, test } from 'bun:test';
import type { HostToolRunCtx } from '@forgeax/orchestrator/orchestration-seams';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetRelayHealthForTests,
  dedupeMenuItems,
  editorUiBrowseHostTools,
} from '../src/game/editor-ui-browse-host-tools';

const relay = 'http://127.0.0.1:15295';
const temporaryRoots: string[] = [];

function ctx(sid: string, agentId = 'forge', projectRoot = '/tmp'): HostToolRunCtx {
  return { sid, agentId, projectRoot };
}

function signal(rev = 1, selection: unknown = { primary: null, ids: [] }, layoutRaw = 'layout') {
  return JSON.stringify({ rev, selection, layoutRaw, alive: {} });
}

function value(value: unknown) {
  return { ok: true, value: typeof value === 'string' ? value : JSON.stringify(value) };
}

function toolsFor(
  respond: (code: string, index: number) => unknown,
  calls: Array<{ url: string; code: string }> = [],
) {
  const tools = editorUiBrowseHostTools({
    bridgeUrl: relay,
    fetch: async (url, init) => {
      const code = String(JSON.parse(String(init?.body)).code);
      calls.push({ url: String(url), code });
      return new Response(JSON.stringify(respond(code, calls.length - 1)), { status: 200 });
    },
  });
  return { tools, calls };
}

function uiResolution(code: string): unknown {
  const kind = /const kind = "([^"]+)"/.exec(code)?.[1];
  const raw = /const raw = "([^"]+)"/.exec(code)?.[1] ?? '';
  if (!kind) return undefined;
  return value({ ok: true, id: raw, label: raw, node: `${kind}:${raw}`, matched: true });
}

afterEach(async () => {
  // The relay circuit breaker is module-level and keyed by bridge URL, which every
  // test here shares — leave it tripped and the next test refuses before it starts.
  _resetRelayHealthForTests();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('editorUiBrowseHostTools', () => {
  test('exposes exactly five verbs under the fixed trust-gate name', () => {
    const { tools } = toolsFor(() => ({ ok: true, value: null }));

    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('editor_ui_browse');
    // find-first workflow: the static table gives the chain, open walks it.
    expect(tools[0]?.description).toContain('find(query) FIRST');
    expect(tools[0]?.description).toContain("open('menu:<top>/<item>/...')");
    expect(tools[0]?.description).toContain('ready-to-submit `affordance.op`');
    // 收尾核对是一轮一次,不是每步一次 —— 描述必须把这条说死。
    expect(tools[0]?.description).toContain('ONCE per QA round');
    expect(tools[0]?.description).toContain('never per step');
    expect(tools[0]?.inputSchema).toEqual({
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
    });
  });

  test('rejects a missing verb without reaching the relay', async () => {
    const { tools, calls } = toolsFor(() => ({ ok: true, value: null }));

    await expect(tools[0]!.run!({}, ctx('missing-verb'))).resolves.toEqual({
      ok: false,
      error: { code: 'INVALID_ARGS', hint: 'verb must be look, open, act, find, or verify' },
    });
    expect(calls).toHaveLength(0);
  });

  test('opening an entity selects it first — the user sees which object the agent holds', async () => {
    // 2026-08-05 实测:改色任务全程零选中,用户只见结果不见过程。实体是 open 契约
    // ("深入一层并使之可见")里唯一没兑现可见性的节点类型。选中走 gateway 单门
    // (origin 'ai'、进账本、不进 undo 栈),与人点击同账。
    const { tools, calls } = toolsFor((code) => {
      if (code.includes('const raw =')) return value({ ok: true, handle: 42, node: 'entity:42', label: 'TreeTrunk' });
      return value({ entity: 42, components: { Transform: {} }, visible_change: '已在场景中选中该实体', selection: { primary: 42 } });
    });

    await tools[0]!.run!({ verb: 'open', node: 'entity:TreeTrunk' }, ctx('entity-select'));

    const opened = calls.find((c) => c.code.includes('uiBrowseTarget'))!;
    expect(opened).toBeDefined();
    // 先选中(且只在未选中时派发),后读组件 —— 顺序即契约。
    expect(opened.code.indexOf("kind:'setSelection'")).toBeGreaterThan(-1);
    expect(opened.code.indexOf("kind:'setSelection'")).toBeLessThan(opened.code.indexOf('listComponents'));
    expect(opened.code).toContain("selectionReadModel().primary !== uiBrowseTarget");
    expect(opened.code).toContain("'ai'");
    // 下半步:物体属性面板切前台 —— 用户盯着的必须是人改参数用的同一块面板。
    expect(opened.code).toContain("getPanel('ep:inspector')");
    expect(opened.code).toContain('setActive');
    expect(opened.code.indexOf('setActive')).toBeLessThan(opened.code.indexOf('listComponents'));
  });

  test('asset: is not a ghost syntax anymore — it points to the real doors instead of teaching itself', async () => {
    // 工具自己的错误提示曾列出 asset:<query>,但分支从未实现 —— agent 按提示试、
    // 失败、再试(2026-08-05 实测两连败)。现在:专门分支给真路,通用提示不再提它。
    const { tools, calls } = toolsFor(() => value({ ok: true }));

    const result = await tools[0]!.run!({ verb: 'open', node: 'asset:白' }, ctx('asset-ghost')) as { ok: boolean; error: { hint: string } };
    expect(result.ok).toBe(false);
    expect(result.error.hint).toContain("panel:ep:assets");
    expect(result.error.hint).toContain('bindAssetRef');
    expect(calls).toHaveLength(0); // 不打 relay,秒拒

    const missing = await tools[0]!.run!({ verb: 'open', node: 'nonsense' }, ctx('asset-ghost-2')) as { ok: boolean; error: { hint: string } };
    expect(missing.error.hint).not.toContain('asset:<query>');
  });

  test('verify with nothing done since last time is free — no relay, no repeat work', async () => {
    // 自限流是结构性的,不靠模型自律。旧的 staleness 校准死于反面的毛病:每个叶子
    // 前强制多一趟 relay,而它一次都没触发过。
    const { tools, calls } = toolsFor(() => ({ ok: true, value: null }));

    const result = await tools[0]!.run!({ verb: 'verify' }, ctx('verify-noop')) as Record<string, unknown>;

    expect(result.skipped).toBe('no-op');
    expect(String(result.hint)).toContain('不要每步都调');
    expect(calls).toHaveLength(0);
  });

  test('verify surfaces steps that reported success but never showed a visible change', async () => {
    // 2026-08-04 的会话:40 次调用、零失败、用户的树一次都没变色。逐步核对全过,
    // 因为每一刀确实都落在了某处。只有收尾对着世界核才抓得到。
    const root = await mkdtemp(join(tmpdir(), 'ui-browse-verify-'));
    const context = ctx('verify-real', 'forge', root);
    const { tools } = toolsFor((code) => (code.includes('ledgerTail')
      ? value({ rev: 7, pageId: 'pAAA', unsavedOnDisk: true, selection: null,
          ledgerTail: [{ kind: 'setComponent', origin: 'ai' }], screen: { overlay: null, tab: null, panels: [], dialogs: 0, fullscreen: false } })
      : uiResolution(code)
        // 菜单点开了,但页面上没有出现可见项 —— 工具如实给 visible_change: null。
        ?? value({ ok: true, opened: true, stateChanged: true, visible_change: null, items: [] })));

    // 一次"成功但没看见变化"的 open,再收尾核对。
    await tools[0]!.run!({ verb: 'open', node: 'menu:file' }, context);
    const result = await tools[0]!.run!({ verb: 'verify' }, context) as {
      round: { calls: number; noVisibleChange: unknown[] };
      world: { unsavedOnDisk: boolean; ledgerTail: unknown[] };
      concerns: string[];
    };

    expect(result.round.noVisibleChange).toHaveLength(1);
    expect(result.concerns.some((note) => note.includes('没有观察到界面变化'))).toBe(true);
    expect(result.concerns.some((note) => note.includes('unsavedOnDisk=true'))).toBe(true);
    expect(result.world.ledgerTail).toEqual([{ kind: 'setComponent', origin: 'ai' }]);

    // 同一轮再调一次:已经核过了,直接说没有新动作。
    const again = await tools[0]!.run!({ verb: 'verify' }, context) as Record<string, unknown>;
    expect(again.skipped).toBe('no-op');
    await rm(root, { recursive: true, force: true });
  });

  test('look compiles the hand-walked Dockview and selection recipe', async () => {
    const calls: Array<{ url: string; code: string }> = [];
    const looked = {
      openPanels: ['ep:hierarchy'],
      activePanel: 'ep:hierarchy',
      panels: [{ id: 'ep:hierarchy', title: 'Hierarchy', region: { label: 'middle-left' } }],
      menus: ['file', 'edit', 'window'],
      rail: { active: 'agents', sidebarCollapsed: false },
    };
    const { tools } = toolsFor(() => value(looked), calls);

    const first = await tools[0]!.run!({ verb: 'look' }, ctx('look')) as Record<string, unknown>;
    expect(first).toMatchObject(looked);
    // First look of a session carries the static map exactly once…
    expect(first.staticTable).toBeDefined();
    const second = await tools[0]!.run!({ verb: 'look' }, ctx('look')) as Record<string, unknown>;
    expect(second.staticTable).toBeUndefined();
    // …and stays one page program per look (the second call above is look #2).
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(`${relay}/eval`);
    expect(calls[0]?.code).toContain('window.__dockApi');
    expect(calls[0]?.code).toContain('CSS.escape(slotName)');
    expect(calls[0]?.code).toContain("document.querySelectorAll('[data-menu]')");
    expect(calls[0]?.code).toContain('window.__dev.getState()');
    expect(calls[0]?.code).toContain('gateway.selectionReadModel()');
  });

  test('dedupeMenuItems preserves the first visual occurrence', () => {
    expect(dedupeMenuItems(['New', 'Open', 'New', 'Save', 'Open'])).toEqual(['New', 'Open', 'Save']);
  });

  test('open menu resolves first, then clicks and returns verified visible_change', async () => {
    const calls: Array<{ url: string; code: string }> = [];
    const { tools } = toolsFor((code) => uiResolution(code) ?? value({
      ok: true,
      opened: true,
      stateChanged: true,
      visible_change: 'file 菜单已打开',
      items: ['New', 'Open', 'New'],
    }), calls);

    await expect(tools[0]!.run!({ verb: 'open', node: 'menu:file' }, ctx('menu'))).resolves.toEqual({
      ok: true,
      opened: true,
      stateChanged: true,
      visible_change: 'file 菜单已打开',
      items: ['New', 'Open'],
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.code).not.toContain('dispatchEvent');
    expect(calls[1]?.code).toContain("new PointerEvent('pointerdown'");
    expect(calls[1]?.code).toContain("document.querySelectorAll('[role=\"menuitem\"]')");
  });

  test('AMBIGUOUS_REFERENT is read-only before panel/menu/rail side effects', async () => {
    const calls: Array<{ url: string; code: string }> = [];
    const ambiguous = {
      ok: false,
      error: {
        code: 'AMBIGUOUS_REFERENT',
        hint: 'panel 名称命中多个候选；请指定其一或问用户',
        candidates: [
          { node: 'panel:ep:history', label: 'History', where: '现视野·左上' },
          { node: 'panel:ep:hierarchy', label: 'Hierarchy', where: '现视野·左下' },
        ],
      },
    };
    const { tools } = toolsFor(() => value(ambiguous), calls);

    await expect(tools[0]!.run!({ verb: 'open', node: 'panel:hi' }, ctx('ambiguous'))).resolves.toEqual(ambiguous);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.code).not.toContain('setActive()');
    expect(calls[0]?.code).not.toContain('addPanel(');
    expect(calls[0]?.code).not.toContain('dispatchEvent');
    expect(calls[0]?.code).not.toContain('setWorkbenchTab(');
  });

  test('panel post-check can return null plus a no-visible-claim hint', async () => {
    const { tools } = toolsFor((code) => uiResolution(code) ?? value({
      ok: true,
      stateChanged: true,
      visible_change: null,
      hint: '面板状态已更新，但页面上未检测到有尺寸的目标面板，不能向用户声称可见',
      rows: [],
    }));
    await expect(tools[0]!.run!({ verb: 'open', node: 'panel:ep:hierarchy' }, ctx('panel-hidden'))).resolves.toMatchObject({
      visible_change: null,
      hint: expect.stringContaining('不能向用户声称可见'),
    });
  });

  test('entity Name resolution returns shared identity, usedBy and real affordance kinds', async () => {
    const calls: Array<{ url: string; code: string }> = [];
    const result = {
      entity: 3,
      components: {
        MeshRenderer: {
          values: { materials: [17] },
          fields: {
            materials: {
              value: [17],
              identity: [{ handle: 17, guid: 'mat-trunk', kind: 'material', summary: 'rgb(138,90,43) 棕', usedBy: ['TreeTrunk', 'Branch'] }],
              affordance: {
                op: { kind: 'bindAssetRef', entity: 3, component: 'MeshRenderer', field: 'materials', assetType: 'MaterialAsset', guids: ['<在此填目标资产的 guid>'], requestId: '<auto>' },
                async: true,
                note: 'tool fills requestId',
              },
            },
          },
        },
        Transform: {
          fields: {
            scale: { value: [1, 1, 1], affordance: { op: { kind: 'setComponent', entity: 3, component: 'Transform', patch: { scale: [1, 1, 1] } }, async: false } },
          },
        },
      },
    };
    const { tools } = toolsFor((code) => {
      if (code.includes('const gamesPromise')) return value(signal());
      if (code.includes("query({ with: ['Name'] })") && code.includes("kind:'entity'")) return value({ ok: true, handle: 3, node: 'entity:3', label: 'TreeTrunk' });
      return value(result);
    }, calls);

    await expect(tools[0]!.run!({ verb: 'open', node: 'entity:treetrunk' }, ctx('entity-name'))).resolves.toEqual(result);
    const resolver = calls.find((call) => call.code.includes("kind:'entity'"))?.code ?? '';
    const entityCode = calls.find((call) => call.code.includes('const compNames'))?.code ?? '';
    expect(resolver).toContain("row.Name?.value");
    expect(resolver).toContain('toLocaleLowerCase() === needle');
    expect(entityCode).toContain("gateway.describeAsset(handle)");
    expect(entityCode).toContain("query({ with: ['MeshRenderer', 'Name'] })");
    expect(entityCode).toContain('usedBy: uiBrowseUsage.get(handle)');
    expect(entityCode).toContain("kind:'setComponent'");
    expect(entityCode).toContain("kind:'bindAssetRef'");
    expect(entityCode).not.toContain("id:'setComponent'");
    expect(entityCode).toContain("requestId:'<auto>'");
  });

  test('无逐字段回读的 op(transaction 等)不许冒领"after=字段回读值"', async () => {
    // 2026-08-06 自探(本轮 B2 修复引入的回归):compileAct 的 readAfter() 对不带
    // entity/component 的 op 第一行就 `return {}` —— 空对象是"没读",不是"读到空"。
    // 只判 typeof object 会让 `{}` 通过,于是对零回读宣称"after=字段回读值",而
    // transaction 正是工具主动推荐的多步路径,charter 又教 agent"act 的返回就是
    // 验证" —— 三者叠起来就是 08-04 树冠事故换个入口重演。
    const acted = { ok: true, rev: 9, after: {}, ledger: { kind: 'transaction', origin: 'ai' } };
    const { tools } = toolsFor((code) => code.includes('gateway.dispatch') ? value(acted) : value(signal(9)));

    const result = await tools[0]!.run!({
      verb: 'act',
      op: { kind: 'transaction', label: '批量调暗', commands: [{ kind: 'setComponent', entity: 3 }] },
    }, ctx('tx-no-readback')) as Record<string, unknown>;

    expect(result.fieldReadback).toBe(false);
    expect(String(result.visible_change)).toContain('证明不了每一项都改成了你要的值');
    expect(String(result.visible_change)).not.toContain('字段回读值');
  });

  test('act dispatches as ai, fills <auto>, and emits after plus audit ledger', async () => {
    const calls: Array<{ url: string; code: string }> = [];
    const acted = { ok: true, rev: 4, after: { materials: [21] }, ledger: { kind: 'setComponent', origin: 'ai' }, run: { status: 'succeeded' } };
    const { tools } = toolsFor((code) => code.includes('gateway.dispatch') ? value(acted) : value(signal(4)), calls);

    // 2026-08-06 外审 B2:世界写路径现在也带 visible_change(文档级测量:rev+after
    // 回读)—— 此前该字段只在 shell 门,gateway act 的 silent-call 检测永不触发,
    // charter 却承诺了它。回退 annotateWorldVisibility 即红。
    await expect(tools[0]!.run!({
      verb: 'act',
      op: { kind: 'bindAssetRef', entity: 3, component: 'MeshRenderer', field: 'materials', guids: ['mat'], requestId: '<auto>' },
    }, ctx('act'))).resolves.toEqual({
      ...acted,
      visible_change: '编辑器文档已按 bindAssetRef 变更(rev=4,after=字段回读值)—— 这是文档级测量,属性面板与视口由同一文档驱动;不是视口像素比对。',
    });
    const actCode = calls.find((call) => call.code.includes('gateway.dispatch'))?.code ?? '';
    expect(actCode).toContain("gateway.dispatch(op, 'ai')");
    expect(actCode).toContain('gateway.waitOperationRun');
    expect(actCode).toContain('gateway.auditLog().at(-1)');
    expect(actCode).toContain('after:readAfter()');
    expect(actCode).toMatch(/"requestId":"ui-browse-[^"]+"/);
  });

  test('act corrects op.id into a complete executable op.kind example', async () => {
    const { tools, calls } = toolsFor(() => value({ ok: true }));
    const wrong = { id: 'setComponent', entity: 3, component: 'Transform', patch: { scale: [4, 6, 4] } };

    await expect(tools[0]!.run!({ verb: 'act', op: wrong }, ctx('wrong-id'))).resolves.toEqual({
      ok: false,
      error: {
        code: 'INVALID_ARGS',
        hint: 'op 需要 kind 而不是 id。正确调用:{"verb":"act","op":{"kind":"setComponent","entity":3,"component":"Transform","patch":{"scale":[4,6,4]}}}',
      },
    });
    expect(calls).toHaveLength(0);
  });

  test('createMaterial 的目录可见性把关写进了程序 —— 同步派发 ok 不等于材质可用', async () => {
    // 2026-08-06 用户实测:调暗 7 个箱子那一轮,editor-core 在派发返回**之后**才报
    // "create material asset commit failed: … before the visibility deadline",
    // 只进了控制台;工具早已回 ok:true,agent 于是对用户说"已经调暗并保存好了"。
    // createMaterial 不走 operationRun(不在网关 request-correlated 名单),ASYNC_
    // OPERATION_KINDS 那张手抄表也盖不到它 —— 完成契约是 editor-core 的目录屏障
    // (core/src/session/pack-ops.ts:108「callers MUST … abort the bind when !ok」)。
    // 这里钉住:派发后必须按目录回读把关,而不是拿同步 ok 当完成。
    const { calls } = toolsFor(() => value({ ok: true, rev: 1, after: {}, ledger: { kind: 'createMaterial', origin: 'ai' } }));
    const tools2 = editorUiBrowseHostTools({
      bridgeUrl: relay,
      fetch: async (url, init) => {
        const code = String(JSON.parse(String(init?.body)).code);
        calls.push({ url: String(url), code });
        return new Response(JSON.stringify(value({ ok: true, rev: 1, after: {}, ledger: { kind: 'createMaterial', origin: 'ai' } })), { status: 200 });
      },
    });
    await tools2[0]!.run!(
      { verb: 'act', op: { kind: 'createMaterial', guid: 'g-1', name: 'dark', baseColor: [0.1, 0.1, 0.1, 1] } },
      ctx('mat-catalog-gate'),
    );
    const actCode = calls.find((call) => call.code.includes('gateway.dispatch'))?.code ?? '';
    expect(actCode).toContain('ASSET_NOT_CATALOGUED');
    expect(actCode).toContain('gateway.assetCatalog()');
    expect(actCode).toContain('不要绑定它');
  });

  test('known newly minted material bind failure warns against disk edits', async () => {
    let dispatches = 0;
    const guid = 'new-material-guid';
    const { tools } = toolsFor((code) => {
      if (!code.includes('gateway.dispatch')) return value(signal(1));
      dispatches++;
      return dispatches === 1
        ? value({ ok: true, rev: 1, after: {}, ledger: { kind: 'createMaterial', origin: 'ai' } })
        : value({ ok: false, error: { code: 'BIND_FAILED', hint: 'material unavailable' } });
    });
    const context = ctx('minted');
    await tools[0]!.run!({ verb: 'act', op: { kind: 'createMaterial', guid, name: 'new', baseColor: [1, 0, 0, 1] } }, context);
    const failed = await tools[0]!.run!({ verb: 'act', op: { kind: 'bindAssetRef', entity: 3, component: 'MeshRenderer', field: 'materials', assetType: 'MaterialAsset', guids: [guid] } }, context);
    expect((failed as { error: { hint: string } }).error.hint).toContain('新铸材质暂不能绑定');
    expect((failed as { error: { hint: string } }).error.hint).toContain('修复后删除本分支');
  });

  test('an unresolvable entity name hands back the scene roster, not a second errand', async () => {
    // 用户说"树干",实体叫 TreeTrunk。别的节点类型未命中都给候选;实体这条以前只说
    // "去开 hierarchy 面板",于是每次都多跑一趟(2026-08-04 实测 3 次调用才拿到实体)。
    const calls: Array<{ url: string; code: string }> = [];
    const { tools } = toolsFor(() => value({
      ok: false,
      error: {
        code: 'NOT_FOUND',
        kind: 'entity',
        hint: '没有名称或 handle 精确匹配 树干;下面是场景里所有实体,按语义挑一个再试(名字可能是英文)',
        candidates: [{ node: 'entity:1', label: 'TreeTrunk', where: '场景树' }],
      },
    }), calls);

    const result = await tools[0]!.run!({ verb: 'open', node: 'entity:树干' }, ctx('entity-miss'));

    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', kind: 'entity' } });
    expect((result as { error: { candidates: unknown[] } }).error.candidates).toHaveLength(1);
    // 候选来自 query({with:['Name']}) 的实时结果 —— 实体自己注册的名字,不是映射表。
    const resolver = calls.find((call) => call.code.includes("kind:'entity'"))!.code;
    expect(resolver).toContain('candidates:rows.slice(0, 60)');
    expect(resolver).toContain("query({ with: ['Name'] })");
  });

  test('the assets panel projects identities a human can tell apart', async () => {
    const calls: Array<{ url: string; code: string }> = [];
    const { tools } = toolsFor((code) => uiResolution(code) ?? value({ ok: true, assets: [] }), calls);

    await tools[0]!.run!({ verb: 'open', node: 'panel:ep:assets' }, ctx('assets-panel'));

    // 每个材质的 catalog name 都是 "scene.pack.json" —— 面板必须给颜色和 usedBy,
    // 否则 agent 只能翻到 editor_gateway_eval 去反射 gateway 自己拼(实测 5 次逃生舱)。
    const program = calls.find((call) => call.code.includes("id === 'ep:assets'"))!.code;
    expect(program).toContain('uiBrowseAssetSummary');
    expect(program).toContain('usedBy');
    expect(program).not.toContain('({guid,kind,name})');
  });

  test('act resolves shared-asset fields in `after`, so nobody re-opens to see what got bound', async () => {
    const calls: Array<{ url: string; code: string }> = [];
    const { tools } = toolsFor(() => value({ ok: true, rev: 2, after: {}, ledger: null, unsavedOnDisk: false }), calls);

    await tools[0]!.run!(
      { verb: 'act', op: { kind: 'bindAssetRef', entity: 3, component: 'MeshRenderer', field: 'materials', assetType: 'MaterialAsset', guids: ['g'] } },
      ctx('act-after'),
    );

    const program = calls.find((call) => call.code.includes('gateway.dispatch'))!.code;
    expect(program).toContain('uiBrowseIdentity');
    expect(program).toContain('uiBrowseSharedTarget');
  });

  test('a swapped executor page and a reloaded document are both reported, not silently accepted', async () => {
    // 2026-08-04 用户实测:两次改色之间 rev 从 7 掉回 1 —— 第二刀落在另一个页面,
    // 磁盘和屏幕都没有他要的结果,而每一步都返回 ok。中继只认最后连上的页面,
    // 用户开着第二个 ForgeaX 标签页就足以复现。
    let rev = 7;
    let pageId = 'pAAA';
    const { tools } = toolsFor((code) => (code.includes('gateway.dispatch')
      ? value({ ok: true, rev, pageId, after: {}, ledger: { kind: 'setSelection', origin: 'ai' }, unsavedOnDisk: false })
      : value({ ok: true })));
    const tool = tools[0]!;
    const context = ctx('continuity');
    const act = async (id: number) => await tool.run!({ verb: 'act', op: { kind: 'setSelection', id } }, context) as Record<string, unknown>;

    expect((await act(1)).worldReloaded).toBeUndefined();

    // 换页:rev 更高也照抓 —— 只看 rev 会漏掉这一种。
    pageId = 'pBBB';
    rev = 99;
    const swapped = String((await act(2)).worldReloaded);
    expect(swapped).toContain('另一个 ForgeaX 页面');
    expect(swapped).toContain('不要声称早先的改动还在');

    expect((await act(3)).worldReloaded).toBeUndefined(); // 稳定在新页 → 不再刷警告

    // 同一页 rev 倒退 = 文档重载,undo 栈也没了。
    rev = 1;
    const reloaded = String((await act(4)).worldReloaded);
    expect(reloaded).toContain('重新加载');
    expect(reloaded).toContain('rev 99 → 1');
  });

  test('a dead transport becomes one hard refusal that forbids going around the door', async () => {
    const envelope = { ok: false, error: { code: 'PAGE_NOT_CONNECTED', hint: 'open the editor' } };
    const { tools } = toolsFor(() => envelope);

    const result = await tools[0]!.run!({ verb: 'open', node: 'panel:viewport' }, ctx('relay-error'));

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'EDITOR_TRANSPORT_DOWN', retryable: true, owner: 'user', observed: 'PAGE_NOT_CONNECTED' },
    });
    const { hint } = (result as { error: { hint: string } }).error;
    expect(hint).toContain('不要改磁盘上的场景/资产文件');
    expect(hint).toContain('不要开自动化浏览器');
  });

  test('a gateway-level failure is NOT treated as a dead transport', async () => {
    // The editor answered and said no — that must reach the caller untouched, or
    // every ordinary refusal would read as "the door is broken, improvise".
    const envelope = { ok: false, error: { code: 'UNKNOWN_COMPONENT', hint: 'no such component' } };
    const { tools } = toolsFor(() => envelope);
    await expect(tools[0]!.run!({ verb: 'open', node: 'panel:viewport' }, ctx('gateway-no'))).resolves.toEqual(envelope);
  });

  test('once the transport is known dead, later calls refuse instantly instead of timing out again', async () => {
    const calls: Array<{ url: string; code: string }> = [];
    const { tools } = toolsFor(() => ({ ok: false, error: { code: 'RELAY_UNAVAILABLE', hint: 'timeout' } }), calls);
    const tool = tools[0]!;

    await tool.run!({ verb: 'look' }, ctx('dead-1'));
    const afterFirst = calls.length;
    const second = await tool.run!({ verb: 'open', node: 'entity:3' }, ctx('dead-2'));

    expect(second).toMatchObject({ ok: false, error: { code: 'EDITOR_TRANSPORT_DOWN' } });
    // Only the cheap liveness probe went out — not the real page program.
    expect(calls.length - afterFirst).toBe(1);
    expect(calls.at(-1)!.code).toBe('1');
  });

  test('every state read declares itself authoritative so nobody verifies against the file', async () => {
    const calls: Array<{ url: string; code: string }> = [];
    const { tools } = toolsFor((code) => {
      if (code.includes('const gamesPromise')) return value(signal(1));
      if (code.includes("kind:'entity'") && code.includes('const raw')) {
        return value({ ok: true, handle: 3, node: 'entity:3', label: 'RedBox' });
      }
      return value({ entity: 3, components: {}, panels: [] });
    }, calls);

    await tools[0]!.run!({ verb: 'look' }, ctx('truth-look'));
    await tools[0]!.run!({ verb: 'open', node: 'entity:3' }, ctx('truth-entity'));

    for (const marker of ['openPanels', 'const compNames']) {
      const program = calls.find((call) => call.code.includes(marker))!;
      expect(program.code).toContain('liveTruth');
      expect(program.code).toContain('hasPendingDiskSave');
      expect(program.code).toMatch(/authoritative:\s*true/);
      expect(program.code).toContain('不要读');
    }
  });

  test('an unsaved write says where it lives and hands over the save op', async () => {
    const { tools } = toolsFor((code) => {
      if (code.includes('gateway.dispatch')) {
        return value({ ok: true, rev: 4, after: { materials: [3] }, ledger: { kind: 'bindAssetRef', origin: 'ai' }, unsavedOnDisk: true, authoringMode: 'authored' });
      }
      return value(signal(1));
    });

    const result = await tools[0]!.run!(
      { verb: 'act', op: { kind: 'bindAssetRef', entity: 3, component: 'MeshRenderer', field: 'materials', assetType: 'MaterialAsset', guids: ['g'] } },
      ctx('persist'),
    ) as { persistence: { onDisk: boolean; saveOp: unknown; note: string } };

    expect(result.persistence.onDisk).toBe(false);
    expect(result.persistence.saveOp).toEqual({ kind: 'saveDocToDisk', requestId: '<auto>' });
    expect(result.persistence.note).toContain('还没写入磁盘');
    expect(result.persistence.note).toContain('不要改磁盘上的场景/资产文件');
    expect(result.persistence.note).toContain('liveTruth.unsavedOnDisk 为准');
  });

  test('a saved write, and the save itself, carry no persistence nag', async () => {
    const { tools } = toolsFor((code) => (code.includes('gateway.dispatch')
      ? value({ ok: true, rev: 5, after: {}, ledger: { kind: 'saveDocToDisk', origin: 'ai' }, unsavedOnDisk: false, authoringMode: 'authored' })
      : value(signal(1))));

    const saved = await tools[0]!.run!({ verb: 'act', op: { kind: 'saveDocToDisk' } }, ctx('saved'));
    expect(saved).not.toHaveProperty('persistence');
  });

  test('saveDocToDisk gets an auto requestId like every other correlated op', async () => {
    const calls: Array<{ url: string; code: string }> = [];
    const { tools } = toolsFor((code) => (code.includes('gateway.dispatch')
      ? value({ ok: true, rev: 6, after: {}, ledger: null, unsavedOnDisk: false })
      : value(signal(1))), calls);

    await tools[0]!.run!({ verb: 'act', op: { kind: 'saveDocToDisk' } }, ctx('save-req'));

    const dispatch = calls.find((call) => call.code.includes('gateway.dispatch'))!;
    expect(dispatch.code).toContain('"requestId":"ui-browse-');
  });

  test('the breaker reopens as soon as a probe gets an answer', async () => {
    let alive = false;
    const { tools } = toolsFor((code) => {
      if (!alive) return { ok: false, error: { code: 'RELAY_UNAVAILABLE', hint: 'timeout' } };
      if (code.includes('const gamesPromise')) return value(signal(1));
      return value({ panels: [], recovered: true });
    });
    const tool = tools[0]!;

    await tool.run!({ verb: 'look' }, ctx('reopen'));
    alive = true;

    await expect(tool.run!({ verb: 'look' }, ctx('reopen'))).resolves.toMatchObject({ recovered: true });
  });

  test('metrics append JSONL and write failures never change the tool result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ui-browse-'));
    temporaryRoots.push(root);
    const looked = { panels: [] };
    const { tools } = toolsFor((code) => code.includes('openPanels') ? value(looked) : value(signal()));
    await expect(tools[0]!.run!({ verb: 'look' }, ctx('metrics-sid', 'metrics-agent', root))).resolves.toMatchObject(looked);
    const line = JSON.parse((await readFile(join(root, '.forgeax/ui-browse-metrics.jsonl'), 'utf8')).trim());
    expect(line).toMatchObject({ sid: 'metrics-sid', agentId: 'metrics-agent', verb: 'look', node: null, ok: true, errorCode: null });
    expect(line.durationMs).toEqual(expect.any(Number));

    const blockedRoot = join(root, 'not-a-directory');
    await writeFile(blockedRoot, 'file');
    await expect(tools[0]!.run!({ verb: 'look' }, ctx('metrics-fail', 'metrics-agent', blockedRoot))).resolves.toMatchObject(looked);
  });

  test('指标行带上连接键 —— 有值才带,缺了就省略', async () => {
    // 2026-08-06 外审:这份旁账此前只有 sid+agent+时间戳,"哪次模型调用导致了哪次 UI 操作"
    // 只能靠时间猜。租用内核(codex 经 MCP)那条路上内核 callId 结构上过不来,只有 shim 自铸的
    // toolExecutionId 可连;原生路径反之。**两个键都缺时必须都省略** —— 写 null 会让消费方
    // 以为能 join 然后连到错的地方。
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ui-browse-keys-'));
    temporaryRoots.push(root);
    const looked = { panels: [] };
    const { tools } = toolsFor((code) => code.includes('openPanels') ? value(looked) : value(signal()));

    await tools[0]!.run!({ verb: 'look' }, {
      ...ctx('keys-sid', 'keys-agent', root),
      callId: 'call_native',
      toolExecutionId: 'fxt-abc',
    });
    await tools[0]!.run!({ verb: 'look' }, ctx('keys-sid', 'keys-agent', root));

    const rows = (await readFile(join(root, '.forgeax/ui-browse-metrics.jsonl'), 'utf8'))
      .split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ callId: 'call_native', toolExecutionId: 'fxt-abc' });
    expect('callId' in rows[1]!).toBe(false);
    expect('toolExecutionId' in rows[1]!).toBe(false);
  });

  test('every generated page program parses as JavaScript', async () => {
    const calls: Array<{ url: string; code: string }> = [];
    const { tools } = toolsFor((code) => {
      const resolved = uiResolution(code);
      if (resolved) return resolved;
      if (code.includes("kind:'entity'")) return value({ ok: true, handle: 3, node: 'entity:3', label: 'TreeTrunk' });
      if (code.includes('const gamesPromise')) return value(signal(1));
      if (code.includes('openPanels')) return value({ panels: [] });
      if (code.includes('const compNames')) return value({ entity: 3, components: {} });
      if (code.includes('gateway.dispatch')) return value({ ok: true, rev: 1, after: {}, ledger: { kind: 'setSelection', origin: 'ai' } });
      return value({ ok: true, opened: true, assets: [] });
    }, calls);
    const tool = tools[0]!;

    await tool.run!({ verb: 'look' }, ctx('parse-look'));
    await tool.run!({ verb: 'open', node: 'panel:ep:hierarchy' }, ctx('parse-panel'));
    await tool.run!({ verb: 'open', node: 'menu:file' }, ctx('parse-menu'));
    await tool.run!({ verb: 'open', node: 'rail:agents' }, ctx('parse-rail'));
    await tool.run!({ verb: 'open', node: 'entity:TreeTrunk' }, ctx('parse-entity'));
    await tool.run!({ verb: 'open', node: 'asset:' }, ctx('parse-asset'));
    await tool.run!({ verb: 'act', op: { kind: 'setSelection', id: 3 } }, ctx('parse-act'));
    await tool.run!({ verb: 'whereami' }, ctx('parse-where'));

    for (const call of calls) expect(() => new Function(call.code)).not.toThrow();
  });
});

/** The shell door: everything outside the editor viewport (the activity rail, the
 *  workspace mode) goes through the dual-modality surface bus instead of the
 *  editor relay, because the relay's executor dies with the viewport. */
describe('editor_ui_browse shell door (host.sidebar surface)', () => {
  const ENTRIES = [
    { id: 'agents', label: 'Agents', kind: 'builtin' },
    { id: 'wb:character', label: 'Character Editor', kind: 'bus' },
    { id: 'wb:anim', label: 'Animation', kind: 'bus' },
  ];

  function shellTools(options: {
    mode?: 'scene' | 'ai';
    workbenchTab?: string;
    /** Shell state observed AFTER a dispatch acks; defaults to the move not landing. */
    after?: { mode: 'scene' | 'ai'; workbenchTab: string };
    ack?: { ok: boolean; error?: string; timedOut?: boolean; result?: unknown; token?: string; started?: boolean };
    snapshot?: (id: string) => unknown;
    list?: () => Array<{ id: string; layer?: string; pages?: number; actions?: Array<{ id: string; exposedToAI?: boolean; argsSchema?: unknown }> }>;
    actions?: () => ReadonlyArray<{ id: string; title?: string; description?: string }>;
    plugins?: () => ReadonlyArray<{ id: string; workbenchId?: string; label: string; hidden?: boolean }>;
    relayRespond?: (code: string, record: { url: string; code: string }) => unknown;
  } = {}) {
    const sent: Array<{ surfaceId: string; action: string; args: unknown }> = [];
    const relayCalls: Array<{ url: string; code: string }> = [];
    let dispatched = false;
    const state = { mode: options.mode ?? 'scene', workbenchTab: options.workbenchTab ?? 'agents' };
    const tools = editorUiBrowseHostTools({
      bridgeUrl: relay,
      fetch: async (url, init) => {
        const code = String(JSON.parse(String(init?.body)).code);
        const record = { url: String(url), code };
        relayCalls.push(record);
        const resolved = options.relayRespond?.(code, record)
          ?? uiResolution(code)
          ?? (code.includes('const gamesPromise') ? value(signal(1)) : undefined)
          ?? (code.includes('openPanels') ? value({ panels: [], mode: 'scene' }) : undefined)
          ?? value({ ok: true });
        return new Response(JSON.stringify(resolved), { status: 200 });
      },
      shell: {
        snapshot: options.snapshot ?? ((id: string) => {
          if (id !== 'host.sidebar') return null;
          const live = dispatched && options.after ? options.after : state;
          return { workbenchTab: live.workbenchTab, mode: live.mode, entries: ENTRIES };
        }),
        dispatch: async (surfaceId, action, args) => {
          sent.push({ surfaceId, action, args });
          dispatched = true;
          return options.ack ?? { ok: true, result: null };
        },
        actions: options.actions ?? (() => []),
        plugins: options.plugins ?? (() => []),
        list: options.list ?? (() => [
          { id: 'host.sidebar', layer: 'host', actions: [
            { id: 'selectTab', argsSchema: { type: 'object', required: ['tab'] } },
            { id: 'setMode', argsSchema: { type: 'object', required: ['mode'] } },
          ] },
          { id: 'host.menubar', layer: 'host', actions: [{ id: 'invoke' }] },
          { id: 'host.toast', layer: 'host', actions: [{ id: 'dismiss' }, { id: 'internal', exposedToAI: false }] },
        ]),
      },
    });
    return { tool: tools[0]!, sent, relayCalls };
  }

  test('two live pages: the shell door stops asserting a visible change and says it cannot tell', async () => {
    // 门的落点由"谁先轮询到"决定,而回读 snapshot 必然通过 —— 那份 snapshot 正是
    // 执行了动作的那一页 PUT 上来的。所以 moved.reached 只证明**某一页**动了,
    // 证明不了用户那一页动了。2026-08-04 事故的同一个病,换到 shell 这扇门上。
    const { tool } = shellTools({
      mode: 'scene',
      workbenchTab: 'agents',
      after: { mode: 'ai', workbenchTab: 'agents' },
      list: () => [
        { id: 'host.sidebar', layer: 'host', pages: 2, actions: [{ id: 'selectTab' }, { id: 'setMode' }] },
      ],
    });

    const result = await tool.run!({ verb: 'open', node: 'rail:agents' }, ctx('multi-page')) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(result.visible_change).toBeNull();
    expect(String(result.multiplePages)).toContain('2 个 ForgeaX 页面');
    expect(String(result.multiplePages)).toContain('不要向用户声称界面已经变了');
  });

  test('a single live page keeps the plain assertion — the warning is not a permanent tax', async () => {
    const { tool } = shellTools({
      mode: 'scene',
      workbenchTab: 'agents',
      after: { mode: 'ai', workbenchTab: 'agents' },
      ack: { ok: true, token: 'host.sidebar-1-railtok' },
      list: () => [
        { id: 'host.sidebar', layer: 'host', pages: 1, actions: [{ id: 'selectTab' }, { id: 'setMode' }] },
      ],
    });

    const result = await tool.run!({ verb: 'open', node: 'rail:agents' }, ctx('single-page')) as Record<string, unknown>;

    expect(result.visible_change).toBe('Agents 工作台已在左侧显示');
    // rail 门与 menubar 门共用 token 穿透:回执 token = ui-events 那条记录的键。
    expect(result.token).toBe('host.sidebar-1-railtok');
    expect(result.multiplePages).toBeUndefined();
  });

  test('open(rail:agents) drives the shell surface, not the editor relay', async () => {
    const { tool, sent, relayCalls } = shellTools({ mode: 'scene', workbenchTab: 'agents', after: { mode: 'ai', workbenchTab: 'agents' } });

    const result = await tool.run!({ verb: 'open', node: 'rail:agents' }, ctx('shell-a'));

    expect(sent).toEqual([{ surfaceId: 'host.sidebar', action: 'selectTab', args: { tab: 'agents' } }]);
    expect(relayCalls).toHaveLength(0);
    expect(result).toMatchObject({
      ok: true,
      via: 'host.sidebar.selectTab',
      mode: 'ai',
      visible_change: 'Agents 工作台已在左侧显示',
      editorRelayOffline: true,
    });
  });

  test('a rail label resolves to the tab id the shell published', async () => {
    const { tool, sent } = shellTools({ after: { mode: 'ai', workbenchTab: 'wb:character' } });

    await tool.run!({ verb: 'open', node: 'rail:Character Editor' }, ctx('shell-label'));

    expect(sent[0]).toMatchObject({ action: 'selectTab', args: { tab: 'wb:character' } });
  });

  test('open(rail:editor) is a mode change back to the scene workspace', async () => {
    const { tool, sent } = shellTools({ mode: 'ai', workbenchTab: 'agents', after: { mode: 'scene', workbenchTab: 'agents' } });

    const result = await tool.run!({ verb: 'open', node: 'rail:editor' }, ctx('shell-back'));

    expect(sent).toEqual([{ surfaceId: 'host.sidebar', action: 'setMode', args: { mode: 'scene' } }]);
    expect(result).toMatchObject({ ok: true, mode: 'scene', visible_change: '编辑器工作区已切回前台,场景视口重新显示' });
    expect(result).not.toHaveProperty('editorRelayOffline');
  });

  test('an ack that does not move the shell reports visible_change null instead of success', async () => {
    const { tool } = shellTools({ mode: 'scene', workbenchTab: 'agents', after: { mode: 'scene', workbenchTab: 'agents' } });

    const result = await tool.run!({ verb: 'open', node: 'rail:agents' }, ctx('shell-stuck')) as Record<string, unknown>;

    expect(result.visible_change).toBeNull();
    expect(String(result.hint)).toContain('不要向用户声称已打开');
  });

  test('超时/结果未知也标脏 —— verify 不能在最该核对时说"没什么可核的"', async () => {
    // 2026-08-05 终审:超时类失败的语义是"可能已执行、世界可能已变",工具自己的
    // 提示写着"先 look/verify 核对";若不标脏,agent 照做却得到"没有新动作,上次
    // 结论仍有效",在最该核对的时刻被拒绝,还可能转身重试(重试即双跑)。
    const { tool } = shellTools({
      ack: { ok: false, error: 'timeout', timedOut: true },
      relayRespond: (code) => (code.includes('ledgerTail')
        ? value({ rev: 1, pageId: 'pAAA', unsavedOnDisk: false, selection: null, ledgerTail: [],
            screen: { overlay: null, tab: null, panels: [], dialogs: 0, fullscreen: false } })
        : value({ ok: true })),
    });
    const context = ctx('verify-after-timeout');

    const timedOut = await tool.run!({ verb: 'open', node: 'rail:agents' }, context) as
      { ok: boolean; error: { timedOut?: boolean } };
    expect(timedOut.ok).toBe(false);
    expect(timedOut.error.timedOut).toBe(true);

    const verified = await tool.run!({ verb: 'verify' }, context) as Record<string, unknown>;
    expect(verified.skipped).toBeUndefined(); // 不许 no-op 跳过
    expect(verified.round).toBeDefined();     // 必须真的读世界、列本轮
  });

  test('a dispatch timeout never claims the rail opened', async () => {
    const { tool } = shellTools({ ack: { ok: false, error: 'timeout', timedOut: true } });

    const result = await tool.run!({ verb: 'open', node: 'rail:agents' }, ctx('shell-timeout'));

    expect(result).toMatchObject({ ok: false, error: { code: 'SHELL_DISPATCH_FAILED' } });
    expect(String((result as { error: { hint: string } }).error.hint)).toContain('不要向用户声称它生效了');
    // 超时必须被标出来:超时 ≠ 没执行(页面可能已取走并跑完,ack 没赶上)。咽喉的
    // 回落判定靠这个 flag 区分"确定没跑"与"跑没跑未知" —— 后者绝不回落再派一次。
    expect((result as { error: { timedOut?: boolean } }).error.timedOut).toBe(true);
  });

  test('AI 派发菜单项时同时带 itemId 与 commandId —— 账本两侧同形', async () => {
    // 人点击记 { itemId, commandId };AI 若只记 itemId,同一个动作在账本里就是两个
    // 名字(help.shortcuts vs overlay.open),离线比对"人和 AI 做的是不是同一件事"
    // 还得回查菜单注册表。2026-08-05 从真实 ui-events.jsonl 里看出来的。
    const { tool, sent } = shellTools({
      snapshot: (id: string) => {
        if (id === 'host.menubar') {
          return { menus: { help: [
            { id: 'help.shortcuts', label: '快捷键', kind: 'command', commandId: 'overlay.open' },
          ] } };
        }
        if (id === 'host.sidebar') return { workbenchTab: 'agents', mode: 'scene', entries: ENTRIES };
        return null;
      },
      relayRespond: (code) => {
        if (code.includes('aria-haspopup')) {
          return value({ ok: true, path: ['help', '快捷键'], leaf: { text: '快捷键', disabled: false }, items: [], menusOpen: 1 });
        }
        if (code.includes('dialogs:')) return value({ overlay: null, dialogs: 0, fullscreen: false, panels: [], tab: null, menus: 0 });
        return value({ menusOpen: 0 });
      },
    });

    await tool.run!({ verb: 'open', node: 'menu:help/快捷键' }, ctx('ledger-symmetry'));

    const invoke = sent.find((entry) => entry.action === 'invoke');
    expect(invoke?.args).toEqual({ itemId: 'help.shortcuts', commandId: 'overlay.open' });
  });

  test('menubar 门的回执 token 穿透进工具结果 —— 与 ui-events 那条派发记录的机械连接键', async () => {
    // ui-events.jsonl 里每条 AI 派发都带 token,但 2026-08-06 实测该键在 agent 侧
    // 账本 0 命中 —— 两套记录之间除时间戳外无键可连。回执把 token 交还工具结果后,
    // hook:toolResult.result.token 与 ui-events 的 payload.token 逐字相等,笨程序可走。
    const { tool } = shellTools({
      ack: { ok: true, result: { invoked: 'help.shortcuts' }, token: 'host.menubar-9-testtok' },
      snapshot: (id: string) => {
        if (id === 'host.menubar') {
          return { menus: { help: [
            { id: 'help.shortcuts', label: '快捷键', kind: 'command', commandId: 'overlay.open' },
          ] } };
        }
        if (id === 'host.sidebar') return { workbenchTab: 'agents', mode: 'scene', entries: ENTRIES };
        return null;
      },
      relayRespond: (code) => {
        if (code.includes('aria-haspopup')) {
          return value({ ok: true, path: ['help', '快捷键'], leaf: { text: '快捷键', disabled: false }, items: [], menusOpen: 1 });
        }
        if (code.includes('dialogs:')) return value({ overlay: null, dialogs: 0, fullscreen: false, panels: [], tab: null, menus: 0 });
        return value({ menusOpen: 0 });
      },
    });

    const result = await tool.run!({ verb: 'open', node: 'menu:help/快捷键' }, ctx('token-thread')) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(result.token).toBe('host.menubar-9-testtok');
  });

  test('编辑类命令只改世界不改屏幕结构,指纹靠 rev 认出变化 —— 不许报成"没接线"', async () => {
    // 2026-08-06 探测:指纹只取 overlay/dialogs/panels/tab 时,撤销/复制/删除这一整类
    // 菜单命令必然"无差异",工具于是建议 agent 说"这一项虽然可点却尚未真正接线"——
    // 把正常工作的功能报成产品缺陷。rev/selection 同一趟 relay 就能取到。
    let fingerprints = 0;
    const { tool } = shellTools({
      snapshot: (id: string) => {
        if (id === 'host.menubar') {
          return { menus: { edit: [
            { id: 'edit.undo', label: '撤销', kind: 'command', commandId: 'editor.undo' },
          ] } };
        }
        if (id === 'host.sidebar') return { workbenchTab: 'agents', mode: 'scene', entries: ENTRIES };
        return null;
      },
      relayRespond: (code) => {
        if (code.includes('aria-haspopup')) {
          return value({ ok: true, path: ['edit', '撤销'], leaf: { text: '撤销', disabled: false }, items: [], menusOpen: 1 });
        }
        if (code.includes('dialogs:')) {
          // 屏幕结构前后完全一致,只有世界代际动了(撤销的真实形态)。
          fingerprints += 1;
          return value({ overlay: null, dialogs: 0, fullscreen: false, panels: [], tab: null, menus: 0,
            rev: fingerprints === 1 ? 7 : 6, selection: null });
        }
        return value({ menusOpen: 0 });
      },
    });

    const result = await tool.run!({ verb: 'open', node: 'menu:edit/撤销' }, ctx('undo-rev')) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(String(result.visible_change)).toContain('世界代际回退 7 → 6');
    expect(result.hint).toBeUndefined(); // 不许出现"尚未真正接线"那套说辞
  });

  test('关着的面板:panel: 解析失败必须交出窗口菜单那扇活门,不许说"不存在"', async () => {
    // panel: 只能寻址已在布局里的面板,关掉的面板必然 NOT_FOUND —— 但窗口菜单的
    // app.panel.toggle 就是人重新打开它的门。失败必须自带活路。
    const { tool } = shellTools({
      snapshot: (id: string) => {
        if (id === 'host.menubar') {
          return { menus: { window: [
            { id: 'window.outline', label: '层级', kind: 'command', commandId: 'app.panel.toggle', args: { id: 'ep:hierarchy' } },
          ] } };
        }
        if (id === 'host.sidebar') return { workbenchTab: 'agents', mode: 'scene', entries: ENTRIES };
        return null;
      },
      relayRespond: (code) => code.includes('kind === \'panel\'') || code.includes('uiBrowseVis')
        ? value({ ok: false, error: { code: 'NOT_FOUND', kind: 'panel', hint: '没有已注册的 panel 文案匹配 ep:hierarchy' } })
        : undefined,
    });

    const result = await tool.run!({ verb: 'open', node: 'panel:ep:hierarchy' }, ctx('closed-panel')) as
      { ok: boolean; error: { hint: string; recoveryActions?: Array<{ node: string }> } };

    expect(result.ok).toBe(false);
    expect(result.error.hint).toContain("open('menu:window/层级')");
    expect(result.error.hint).toContain('不要**告诉用户这个面板不存在');
    expect(result.error.recoveryActions?.[0]?.node).toBe('menu:window/层级');
  });

  test('前后指纹落在不同页面时:测不到 ≠ 没变化,更不是"没接线"', async () => {
    // 2026-08-06 自探(本轮 rev 指纹引入的回归):relay 认最后连上的页面且不带身份,
    // 用户中途开第二个标签页时,前后两趟指纹来自不同页面 —— rev 在两页之间本来就
    // 不同,拿它当"场景内容已改变"就是对一条什么都没干的命令宣称成功。
    let shots = 0;
    const { tool } = shellTools({
      snapshot: (id: string) => {
        if (id === 'host.menubar') {
          return { menus: { edit: [{ id: 'edit.undo', label: '撤销', kind: 'command', commandId: 'editor.undo' }] } };
        }
        if (id === 'host.sidebar') return { workbenchTab: 'agents', mode: 'scene', entries: ENTRIES };
        return null;
      },
      relayRespond: (code) => {
        if (code.includes('aria-haspopup')) {
          return value({ ok: true, path: ['edit', '撤销'], leaf: { text: '撤销', disabled: false }, items: [], menusOpen: 1 });
        }
        if (code.includes('dialogs:')) {
          shots += 1;
          return value(shots === 1
            ? { pageId: 'pAAA', overlay: null, dialogs: 0, fullscreen: false, panels: [], tab: null, menus: 0, rev: 3, selection: null }
            : { pageId: 'pBBB', overlay: null, dialogs: 0, fullscreen: false, panels: [], tab: null, menus: 0, rev: 7, selection: null });
        }
        return value({ menusOpen: 0 });
      },
    });

    const result = await tool.run!({ verb: 'open', node: 'menu:edit/撤销' }, ctx('page-swap-fp')) as Record<string, unknown>;

    expect(result.visible_change).toBeNull();      // rev 3→7 是伪差异,不许当成变化
    expect(result.measurable).toBe(false);
    expect(String(result.hint)).toContain('两个不同的页面');
    expect(String(result.hint)).not.toContain('尚未真正接线'); // 病因不是没接线
  });

  test('a leaf whose label is prefixed by a sibling still invokes ITS OWN command', async () => {
    // 同层「复制」/「复制路径」/「复制 GUID」(en: Save / Save All)是真实存在的前缀
    // 碰撞,而叶子文本带快捷键(MenuBar 把 combo 渲染在 menuitem 内),所以前缀匹配是
    // 常态路径。单趟 find(精确 || 前缀) 会让先出现的短标签抢走长标签的叶子 ——
    // 问「复制路径」执行「复制」,而且返回体里的 path 看上去完全正确。
    const { tool, sent } = shellTools({
      snapshot: (id: string) => {
        if (id === 'host.menubar') {
          return { menus: { edit: [
            { id: 'edit.copy', label: '复制', kind: 'command', commandId: 'editor.copy' },
            { id: 'edit.copyPath', label: '复制路径', kind: 'command', commandId: 'editor.copyPath' },
          ] } };
        }
        if (id === 'host.sidebar') return { workbenchTab: 'agents', mode: 'scene', entries: ENTRIES };
        return null;
      },
      relayRespond: (code) => {
        if (code.includes('aria-haspopup')) {
          return value({ ok: true, path: ['edit', '复制路径'], leaf: { text: '复制路径', disabled: false }, items: [], menusOpen: 1 });
        }
        if (code.includes('dialogs:')) return value({ overlay: null, dialogs: 0, fullscreen: false, panels: [], tab: null, menus: 0 });
        return value({ menusOpen: 0 });
      },
    });

    await tool.run!({ verb: 'open', node: 'menu:edit/复制路径' }, ctx('prefix-collision'));

    const invoke = sent.find((entry) => entry.action === 'invoke');
    // commandId 随派发一并带上(账本两侧同形);这里关心的是 itemId 没被短标签抢走。
    expect(invoke?.args).toMatchObject({ itemId: 'edit.copyPath' });
  });

  test('an absent menu projection accuses nothing of being headless', async () => {
    // 空对账源不是"没有门"的证据。host.menubar 没注册时(页面没开/栈刚重启还没重连)
    // menuCommandIds 为空,旧写法会把**每一个**有菜单门的 action 都标成"只能后台直调",
    // 等于向用户隐瞒真实的人类点击路径。孤儿那一路已按同样原则 fail-open。
    const { tool } = shellTools({
      snapshot: (id: string) => (id === 'host.sidebar'
        ? { workbenchTab: 'agents', mode: 'scene', entries: ENTRIES }
        : null), // host.menubar 缺席
      actions: () => [{ id: 'editor.save', title: '保存' }, { id: 'editor.undo', title: '撤销' }],
    });

    // 2026-08-06 自探加强:投影缺席时 find **整体拒答**,而不是发一张空表。
    // 旧版只护住了派生结论(不指控 headless / 不指控孤儿),主结论没护住 —— 表照发,
    // 文案照说"这是 ForgeaX 的静态功能表 / 上表是全部静态功能",于是栈重启后
    // (surfaces 是纯内存 Map,已开页面不会重新注册)agent 会直接告诉用户
    // "ForgeaX 没有这个功能"。
    const all = await tool.run!({ verb: 'find' }, ctx('headless-blind')) as
      { ok: boolean; error: { code: string; hint: string } };
    expect(all.ok).toBe(false);
    expect(all.error.code).toBe('PROJECTION_UNAVAILABLE');
    expect(all.error.hint).toContain('不是功能全集');

    const hit = await tool.run!({ verb: 'find', query: '保存' }, ctx('headless-blind-q')) as {
      matches: Array<{ kind: string }>; projectionUnavailable?: boolean; hint?: string;
    };
    // 带 query 时仍给候选(菜单以外的账源可能命中),但绝不能说"上表是全部功能"。
    expect(hit.matches.filter((match) => match.kind === 'headless-action')).toEqual([]);
    expect(hit.projectionUnavailable).toBe(true);
    expect(String(hit.hint)).toContain('不要据此告诉用户"没有这个功能/没有入口"');
  });

  test('find returns the static table from the layers\' own projections', async () => {
    const { tool, sent } = shellTools({
      snapshot: (id: string) => {
        if (id === 'host.menubar') {
          return { menus: { file: [
            { id: 'file.newGame', label: '新建游戏…', kind: 'command' },
            { id: 'file.openRecent', label: '打开最近', kind: 'submenu', dynamic: true },
          ] } };
        }
        if (id === 'host.sidebar') return { workbenchTab: 'agents', mode: 'scene', entries: ENTRIES };
        return null;
      },
    });

    const all = await tool.run!({ verb: 'find' }, ctx('find-all')) as { ok: boolean; table: { menus: unknown; rail: unknown[]; surfaces: unknown[] } };
    expect(all.ok).toBe(true);
    expect(all.table.rail).toHaveLength(ENTRIES.length);
    expect((all.table.menus as Record<string, unknown[]>).file).toHaveLength(2);

    const hit = await tool.run!({ verb: 'find', query: '最近' }, ctx('find-hit')) as { matches: Array<{ node: string; label: string; kind: string }> };
    expect(hit.matches).toEqual([{ node: 'menu:file/打开最近', label: '打开最近', kind: 'submenu' }]);
    // find is a pure table lookup — nothing was dispatched anywhere.
    expect(sent).toHaveLength(0);
  });

  test('find surfaces headless capabilities at LOCATE time, with the no-door truth attached', async () => {
    // 2026-08-04 三轮实测:agent 一绕开直调,"你问的东西前端没有门"就永远没人说。
    const { tool, sent } = shellTools({
      snapshot: (id: string) => {
        if (id === 'host.menubar') {
          return { menus: { window: [{ id: 'window.chat', label: '聊天', kind: 'command', commandId: 'panel.toggle_chatpanel' }] } };
        }
        if (id === 'host.sidebar') return { workbenchTab: 'agents', mode: 'scene', entries: ENTRIES };
        return null;
      },
      actions: () => [
        { id: 'trajectory.read', title: '读取操作轨迹', description: 'Read the recent trajectory of UI operations' },
        { id: 'panel.toggle_chatpanel', title: '折叠/展开聊天面板' },
      ],
    });

    const hit = await tool.run!({ verb: 'find', query: '轨迹' }, ctx('find-headless')) as { matches: Array<Record<string, unknown>> };
    expect(hit.matches).toHaveLength(1);
    expect(hit.matches[0]).toMatchObject({ kind: 'headless-action', label: '读取操作轨迹' });
    expect(String(hit.matches[0]!.door)).toContain('headless');

    // 有菜单门的 catalog action 不重复列(菜单分支已给可见链)。
    const chat = await tool.run!({ verb: 'find', query: '聊天' }, ctx('find-doored')) as { matches: Array<Record<string, unknown>> };
    expect(chat.matches.every((m) => m.kind !== 'headless-action')).toBe(true);

    // 全表模式带 headlessActions 段。
    const all = await tool.run!({ verb: 'find' }, ctx('find-table')) as { table: { headlessActions: { items: Array<{ actionId: string }> } } };
    expect(all.table.headlessActions.items.map((i) => i.actionId)).toEqual(['trajectory.read']);
    expect(sent).toHaveLength(0);
  });

  test('find tells the truth about rail-unlisted plugins: not in rail, still clickable via the workbench grid', async () => {
    // 2026-08-05 修正:上一版断言"用户自己点不到" —— 只对了 rail 一个账源。实测
    // 工作台网格列出全部非隐藏插件且 tile 可点,所以正确的话术是"rail 里看不到,
    // 网格里点得到",并给出那条真实存在的路径。
    const { tool } = shellTools({
      plugins: () => [
        { id: '@forgeax-extension/wb-observatory', workbenchId: 'observatory', label: 'Observatory · 轨迹观察台' },
        { id: '@forgeax-extension/wb-anim', workbenchId: 'anim', label: '动画设计' },
      ],
      // 菜单投影必须在场:缺席时 find 现在整体拒答(PROJECTION_UNAVAILABLE),
      // 而本例考的是"在 rail 里找不到的插件该怎么措辞",不是投影可用性。
      snapshot: (id: string) => {
        if (id === 'host.menubar') return { menus: { file: [{ id: 'file.save', label: '保存', kind: 'command', commandId: 'editor.save' }] } };
        if (id === 'host.sidebar') return { workbenchTab: 'agents', mode: 'scene', entries: ENTRIES };
        return null;
      },
    });
    // ENTRIES 里有 wb:anim(rail 可达),没有 wb:observatory(仅网格可达)。

    const hit = await tool.run!({ verb: 'find', query: '轨迹' }, ctx('find-orphan')) as { matches: Array<Record<string, unknown>> };
    const unlisted = hit.matches.find((m) => m.kind === 'rail-unlisted-plugin')!;
    expect(unlisted).toBeDefined();
    expect(unlisted.label).toBe('Observatory · 轨迹观察台');
    expect(String(unlisted.door)).toContain('工作台网格');
    expect(String(unlisted.door)).not.toContain('点不到');
    expect(String(unlisted.door)).toContain('不要描述「点更多插件进入」'); // 禁令以原文出现,而非旧版的假断言

    const all = await tool.run!({ verb: 'find' }, ctx('find-orphan-table')) as { table: { railUnlisted: { items: Array<{ extensionId: string }> } } };
    expect(all.table.railUnlisted.items.map((i) => i.extensionId)).toEqual(['@forgeax-extension/wb-observatory']);
  });

  test('a menu chain expands the static prefix and reports the revealed level', async () => {
    const calls: Array<{ url: string; code: string }> = [];
    const { tool } = shellTools({ relayRespond: (code, record) => {
      calls.push(record);
      if (code.includes('const segs =')) {
        return value({ ok: true, path: ['file', '打开最近'], leaf: null,
          items: [{ text: 'Agent Exemplar', sub: false, disabled: false }], menusOpen: 2 });
      }
      return value({ ok: true });
    } });

    const result = await tool.run!({ verb: 'open', node: 'menu:file/打开最近' }, ctx('chain-sub')) as Record<string, unknown>;

    expect(result.visible_change).toContain('逐级展开');
    expect((result.items as unknown[])).toHaveLength(1);
    const program = calls.find((call) => call.code.includes('const segs ='))!.code;
    // Submenu triggers are CLICKED — hover and focus+Enter do nothing (hand-walked 2026-08-04).
    expect(program).toContain("dispatchEvent(new PointerEvent('pointerdown'");
    expect(program).not.toContain('pointerenter');
  });

  test('a command leaf executes through menubar.invoke, never through a DOM click', async () => {
    const calls: Array<{ url: string; code: string }> = [];
    const { tool, sent } = shellTools({
      snapshot: (id: string) => {
        if (id === 'host.menubar') {
          return { menus: { file: [
            { id: 'file.openRecent', label: '打开最近', kind: 'submenu', dynamic: true },
          ] } };
        }
        if (id === 'host.sidebar') return { workbenchTab: 'agents', mode: 'scene', entries: ENTRIES };
        return null;
      },
      relayRespond: (code, record) => {
        calls.push(record);
        if (code.includes('const segs =')) {
          return value({ ok: true, path: ['file', '打开最近', 'Agent Exemplar'],
            leaf: { text: 'Agent Exemplar', disabled: false },
            items: [{ text: 'Agent Exemplar', sub: false, disabled: false }], menusOpen: 2 });
        }
        // 指纹:执行后新开了一个面板 → 界面确实变了
        if (code.includes('dialogs:')) {
          const seen = calls.filter((c) => c.code.includes('dialogs:')).length;
          return value({ overlay: null, dialogs: 0, fullscreen: false, tab: 'agents', menus: 0,
            panels: seen === 1 ? ['viewport'] : ['viewport', 'ep:assets'] });
        }
        return value({ menusOpen: 0 });
      },
    });

    const result = await tool.run!({ verb: 'open', node: 'menu:file/打开最近/Agent Exemplar' }, ctx('chain-leaf')) as Record<string, unknown>;

    // The dynamic leaf resolves as {parentId, label} for the page-side registry.
    expect(sent).toEqual([{ surfaceId: 'host.menubar', action: 'invoke', args: { parentId: 'file.openRecent', label: 'Agent Exemplar' } }]);
    expect(String(result.visible_change)).toContain('同一命令入口');
    // And the menus were closed afterwards via the close program.
    expect(calls.some((call) => call.code.includes('aria-expanded="true"'))).toBe(true);
  });

  test('a command leaf never gets an Escape chaser — that would close the overlay it just opened', async () => {
    // 2026-08-04 用户实测:help → 快捷键 打开了浮层,然后"闪了一下就关了"。
    // 全局 Escape 是一条链(关菜单 → 退全屏 → 关浮层),补一发就误伤。
    const calls: Array<{ url: string; code: string }> = [];
    const { tool, sent } = shellTools({
      snapshot: (id: string) => {
        if (id === 'host.menubar') {
          return { menus: { help: [{ id: 'help.shortcuts', label: '快捷键', kind: 'command', commandId: 'overlay.open' }] } };
        }
        if (id === 'host.sidebar') return { workbenchTab: 'agents', mode: 'scene', entries: ENTRIES };
        return null;
      },
      relayRespond: (code, record) => {
        calls.push(record);
        if (code.includes('const segs =')) {
          return value({ ok: true, path: ['help', '快捷键'], leaf: { text: '快捷键', disabled: false }, items: [], menusOpen: 1 });
        }
        // 指纹前后完全一致 = 命令跑了但屏幕没动(用户 2026-08-04 遇到的情形)
        if (code.includes('dialogs:')) return value({ overlay: null, dialogs: 0, fullscreen: false, panels: ['viewport'], tab: 'agents', menus: 0 });
        return value({ menusOpen: 0 });
      },
    });

    const result = await tool.run!({ verb: 'open', node: 'menu:help/快捷键' }, ctx('overlay-safe')) as Record<string, unknown>;

    // 派发体还会带 commandId(账本两侧同形,另有专门测试钉);这条关心的是"只发了
    // 一次 invoke、没有多余动作",所以只锁 surface/action 与 itemId。
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ surfaceId: 'host.menubar', action: 'invoke', args: { itemId: 'help.shortcuts' } });
    // Escape 会顺着全局快捷键链关掉刚打开的浮层 —— 任何一段页面程序都不许带它。
    for (const call of calls) expect(call.code).not.toContain('Escape');
    // 指纹没差异 → 不许声称打开,并要求 agent 如实告诉用户。
    expect(result.visible_change).toBeNull();
    expect(String(result.hint)).toContain('不要向用户声称');
    expect(String(result.hint)).toContain('如实告诉用户');
  });

  test('a command leaf that visibly changes the screen reports what changed, in the user\'s terms', async () => {
    const calls: Array<{ url: string; code: string }> = [];
    const { tool } = shellTools({
      snapshot: (id: string) => {
        if (id === 'host.menubar') {
          return { menus: { help: [{ id: 'help.shortcuts', label: '快捷键', kind: 'command', commandId: 'overlay.open' }] } };
        }
        if (id === 'host.sidebar') return { workbenchTab: 'agents', mode: 'scene', entries: ENTRIES };
        return null;
      },
      relayRespond: (code, record) => {
        calls.push(record);
        if (code.includes('const segs =')) {
          return value({ ok: true, path: ['help', '快捷键'], leaf: { text: '快捷键', disabled: false }, items: [], menusOpen: 1 });
        }
        if (code.includes('dialogs:')) {
          const seen = calls.filter((c) => c.code.includes('dialogs:')).length;
          return seen === 1
            ? value({ overlay: null, dialogs: 0, fullscreen: false, panels: ['viewport'], tab: 'agents', menus: 0 })
            : value({ overlay: 'settings', dialogs: 1, fullscreen: false, panels: ['viewport'], tab: 'agents', menus: 0 });
        }
        return value({ menusOpen: 0 });
      },
    });

    const result = await tool.run!({ verb: 'open', node: 'menu:help/快捷键' }, ctx('overlay-visible')) as Record<string, unknown>;

    expect(String(result.visible_change)).toContain('弹出了「settings」浮层');
    expect(result.hint).toBeUndefined();
  });

  test('a disabled placeholder leaf refuses with the enabled rows as candidates', async () => {
    const { tool, sent } = shellTools({ relayRespond: (code) => {
      if (code.includes('const segs =')) {
        return value({ ok: true, path: ['file', '关闭游戏'], leaf: { text: '关闭游戏', disabled: true },
          items: [{ text: '新建游戏…', sub: false, disabled: false }, { text: '关闭游戏', sub: false, disabled: true }], menusOpen: 1 });
      }
      return value({ ok: true });
    } });

    const result = await tool.run!({ verb: 'open', node: 'menu:file/关闭游戏' }, ctx('chain-disabled'));

    expect(result).toMatchObject({ ok: false, error: { code: 'ITEM_DISABLED' } });
    expect(sent).toHaveLength(0);
  });

  test('a rail move that is already done costs nothing and claims nothing', async () => {
    // 被拒过一次的 agent 会开始给每一步加 open('rail:editor') 护栏 —— 实测一个任务里
    // 出现 8 次,每次都是真派发 + 等待。已经在目标状态就直接回答。
    const { tool, sent } = shellTools({ mode: 'scene', workbenchTab: 'agents' });

    const result = await tool.run!({ verb: 'open', node: 'rail:editor' }, ctx('already-there'));

    expect(sent).toHaveLength(0);
    expect(result).toMatchObject({ ok: true, alreadyThere: true, stateChanged: false, visible_change: null });
    expect(String((result as { hint: string }).hint)).toContain('本来就在前台');
  });

  test('an ambiguous rail query returns candidates without dispatching', async () => {
    const { tool, sent } = shellTools();

    const result = await tool.run!({ verb: 'open', node: 'rail:wb:' }, ctx('shell-ambiguous'));

    expect(sent).toHaveLength(0);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'AMBIGUOUS_REFERENT',
        candidates: [
          { node: 'rail:wb:character', label: 'Character Editor' },
          { node: 'rail:wb:anim', label: 'Animation' },
        ],
      },
    });
  });

  test('an unknown rail query lists what the shell actually publishes', async () => {
    const { tool, sent } = shellTools();

    const result = await tool.run!({ verb: 'open', node: 'rail:物理引擎' }, ctx('shell-miss'));

    expect(sent).toHaveLength(0);
    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', kind: 'rail' } });
    expect((result as { error: { candidates: unknown[] } }).error.candidates).toHaveLength(ENTRIES.length);
  });

  test('act drives ANY published surface action, not just the rail', async () => {
    const { tool, sent } = shellTools({ after: { mode: 'ai', workbenchTab: 'wb:anim' } });

    const result = await tool.run!(
      { verb: 'act', op: { surface: 'host.sidebar', action: 'selectTab', args: { tab: 'wb:anim' } } },
      ctx('generic-act'),
    );

    expect(sent).toEqual([{ surfaceId: 'host.sidebar', action: 'selectTab', args: { tab: 'wb:anim' } }]);
    expect(result).toMatchObject({ ok: true, via: 'host.sidebar.selectTab', stateChanged: true });
  });

  test('回执带 started=true → 失败结果必须继续带它(否则上游会回落重派,同一命令跑两次)', async () => {
    // 2026-08-07 外审 N3:此前这个信号靠在中文错误文案里匹配子串,改一句话就静默失效,
    // 而且没有任何测试会红。现在它是结构化字段 —— 这条钉的就是"服务端真的消费了它"。
    const { tool, sent } = shellTools({ ack: { ok: false, error: 'boom', started: true } });

    const out = await tool.run!(
      { verb: 'act', op: { surface: 'host.menubar', action: 'invoke', args: { itemId: 'file.save' } } },
      ctx('started-true'),
    ) as { ok: boolean; error: Record<string, unknown> };

    expect(sent).toHaveLength(1);
    expect(out.ok).toBe(false);
    expect(out.error.started).toBe(true);
  });

  test('回执没带 started → 失败结果里该键必须缺席,不能被补成 false', async () => {
    // 缺席 = 未知,false = 确定没开始。两者后果相反:未知不许回落重派,确定没开始才可以。
    const { tool, sent } = shellTools({ ack: { ok: false, error: 'boom' } });

    const out = await tool.run!(
      { verb: 'act', op: { surface: 'host.menubar', action: 'invoke', args: { itemId: 'file.save' } } },
      ctx('started-absent'),
    ) as { ok: boolean; error: Record<string, unknown> };

    expect(sent).toHaveLength(1);
    expect(out.ok).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(out.error, 'started')).toBe(false);
  });

  test('an unknown surface or action answers with what IS published', async () => {
    const { tool, sent } = shellTools();

    const noSurface = await tool.run!({ verb: 'act', op: { surface: 'host.nope', action: 'x' } }, ctx('no-surface'));
    expect(noSurface).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', kind: 'surface' } });
    expect((noSurface as { error: { candidates: Array<{ label: string }> } }).error.candidates.map((c) => c.label))
      .toEqual(['host.sidebar', 'host.menubar', 'host.toast']);

    const noAction = await tool.run!({ verb: 'act', op: { surface: 'host.sidebar', action: 'nope' } }, ctx('no-action'));
    expect(noAction).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', kind: 'action' } });
    // The refusal hands back the contract, so the next attempt can be correct.
    expect((noAction as { error: { argsSchemas: Record<string, unknown> } }).error.argsSchemas.selectTab)
      .toEqual({ type: 'object', required: ['tab'] });
    expect(sent).toHaveLength(0);
  });

  test('a human-only action is not offered to the agent', async () => {
    const { tool } = shellTools();
    const result = await tool.run!({ verb: 'act', op: { surface: 'host.toast', action: 'internal' } }, ctx('human-only'));
    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', kind: 'action' } });
  });

  test('look publishes the whole shell tree, each surface with its argsSchema', async () => {
    const { tool } = shellTools({ mode: 'ai', workbenchTab: 'agents' });

    const result = await tool.run!({ verb: 'look' }, ctx('shell-tree')) as {
      shell: { surfaces: Array<{ id: string; actions: Array<{ id: string; argsSchema?: unknown }> }> };
    };

    expect(result.shell.surfaces.map((surface) => surface.id)).toEqual(['host.sidebar', 'host.menubar', 'host.toast']);
    expect(result.shell.surfaces[0]!.actions).toEqual([
      { id: 'selectTab', argsSchema: { type: 'object', required: ['tab'] } },
      { id: 'setMode', argsSchema: { type: 'object', required: ['mode'] } },
    ]);
    // host.toast's human-only action must not appear in the tree either.
    expect(result.shell.surfaces[2]!.actions.map((action) => action.id)).toEqual(['dismiss']);
  });

  test('editor verbs refuse in one hop while the editor is not in front', async () => {
    const { tool, relayCalls } = shellTools({ mode: 'ai', workbenchTab: 'agents' });

    for (const args of [
      { verb: 'open', node: 'entity:TreeTrunk' },
      { verb: 'open', node: 'panel:ep:hierarchy' },
      { verb: 'act', op: { kind: 'setSelection', id: 3 } },
    ]) {
      const result = await tool.run!(args, ctx('shell-gate'));
      // 2026-08-06 外审 B1:不再给 recoveryActions 指路 open('rail:editor')——rail 门
      // 无发布者,那条路必死;hint 改为请用户自己点 Scene 页签。
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'EDITOR_NOT_FOREGROUND',
          retryable: true,
        },
      });
      const err = (result as { error: { hint: string; recoveryActions?: unknown } }).error;
      expect(err.recoveryActions).toBeUndefined();
      expect(err.hint).not.toContain("open('rail:editor')");
      expect(err.hint).toContain('请用户点');
    }
    expect(relayCalls).toHaveLength(0);
  });

  test('look answers from the shell alone while the editor is unmounted', async () => {
    const { tool, relayCalls } = shellTools({ mode: 'ai', workbenchTab: 'agents' });

    const result = await tool.run!({ verb: 'look' }, ctx('shell-look-ai'));

    expect(relayCalls).toHaveLength(0);
    expect(result).toMatchObject({
      editor: null,
      shell: { mode: 'ai', workbenchTab: 'agents', surface: 'host.sidebar' },
    });
    // 2026-08-06 外审 B1:死门不指路 —— recoveryActions 撤除,hint 请用户自己点。
    expect((result as { recoveryActions?: unknown }).recoveryActions).toBeUndefined();
    expect((result as { hint: string }).hint).not.toContain("open('rail:editor')");
    expect((result as { shell: { entries: unknown[] } }).shell.entries).toHaveLength(ENTRIES.length);
  });

  test('look in scene mode keeps the editor view and adds the shell half', async () => {
    const { tool, relayCalls } = shellTools({ mode: 'scene', workbenchTab: 'agents' });

    const result = await tool.run!({ verb: 'look' }, ctx('shell-look-scene')) as Record<string, unknown>;

    expect(relayCalls.length).toBeGreaterThan(0);
    expect(result.shell).toMatchObject({ mode: 'scene', surface: 'host.sidebar' });
  });
});
