import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFeedbackRouter } from '../src/game/feedback';
import { FeedbackRepository } from '../src/game/feedback/repository';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'fx-feedback-repo-test-'));
  roots.push(root);
  return root;
}

describe('feedback repository and API', () => {
  test('queues a new report and preserves its Issue mapping when a duplicate is merged', async () => {
    const root = project();
    const repository = new FeedbackRepository(() => root);
    const first = await repository.submit({ type: 'ui', source: 'manual', description: 'first' });
    await repository.updateDelivery(first.report.id, (delivery) => ({
      ...delivery,
      status: 'published',
      issueNumber: 42,
      issueUrl: 'https://github.com/ForgeaX-Games/forgeax-issues/issues/42',
      attempts: 1,
      deliveredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    const second = await repository.submit({ type: 'ui', source: 'manual', description: 'again' });
    expect(second.merged).toBe(true);
    expect(second.report.count).toBe(2);
    expect(second.report.description).toBe('again');
    expect(second.report.delivery).toMatchObject({
      status: 'queued',
      occurrence: 2,
      issueNumber: 42,
      attempts: 1,
    });
  });

  test('updatedAt tracks user-visible status only, not background delivery ticks', async () => {
    const root = project();
    const repository = new FeedbackRepository(() => root);
    const created = await repository.submit({ type: 'ui', source: 'manual', description: 'first' });
    const afterCreate = created.report.updatedAt;
    // 让墙钟确实走过 1ms:否则「没被顶掉」和「顶成了同一毫秒」无法区分,
    // 这个断言就会时真时假。
    const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

    // 需求 §3.1:「更新时间」= 最近一次状态变更时间。打包/上传/发布是后台投递
    // 流水线,用户在「我的反馈」里看不到,不该顶掉这个时间戳。
    await tick();
    const delivered = await repository.updateDelivery(created.report.id, (delivery) => ({
      ...delivery,
      status: 'publishing',
      attempts: 1,
      updatedAt: new Date(Date.parse(afterCreate) + 60_000).toISOString(),
    }));
    expect(delivered?.updatedAt).toBe(afterCreate);
    // 投递自己的时间戳照常前进 —— 信息没丢,只是各归其位。
    expect(delivered?.delivery?.updatedAt).not.toBe(afterCreate);

    // 用户可见状态变更必须推进它。
    await tick();
    const confirmed = await repository.updateStatus(created.report.id, 'pending-confirm');
    expect(confirmed?.updatedAt).not.toBe(afterCreate);
  });

  test('feedback ids are unique across installs, not merely within one machine', async () => {
    // `.forgeax/` is per-install local state (gitignored), so a counter scoped to it
    // made "today's first report" the same string on every machine: two installs both
    // minted FB-<day>-1, then claimed the same GitHub issue and the same diagnostic
    // bundle path. An install segment makes the id unique where it is generated.
    const [rootA, rootB] = [project(), project()];
    const a = await new FeedbackRepository(() => rootA).submit({ type: 'ui', source: 'manual' });
    const b = await new FeedbackRepository(() => rootB).submit({ type: 'ui', source: 'manual' });

    expect(a.report.id).not.toBe(b.report.id);
    // Both are still "report #1 of today" locally — only the install segment separates them.
    expect(a.report.id).toEndWith('-1');
    expect(b.report.id).toEndWith('-1');
    for (const id of [a.report.id, b.report.id]) {
      expect(id).toMatch(/^FB-\d{6}-[0-9a-f]{6}-\d+$/);
      // The id lands in a Data-repo path and an Issue marker verbatim, so it must
      // survive safePathSegment / safeName without being rewritten.
      expect(id).toMatch(/^[A-Za-z0-9._-]+$/);
    }
  });

  test('the install segment is stable across repository instances and reports', async () => {
    const root = project();
    const first = await new FeedbackRepository(() => root).submit({ type: 'ui', source: 'manual' });
    // A fresh instance on the same project root must reuse the persisted install id
    // (§6 idempotency), otherwise same-day numbering would restart at 1 and collide.
    const second = await new FeedbackRepository(() => root).submit({ type: 'wrong', source: 'manual' });

    const install = (id: string) => id.split('-')[2];
    expect(install(second.report.id)).toBe(install(first.report.id));
    expect(first.report.id).toEndWith('-1');
    expect(second.report.id).toEndWith('-2');
  });

  test('legacy ids neither block new numbering nor get rewritten', async () => {
    // Historical records carry the old FB-YYMMDD-N shape and are already mapped to
    // live GitHub issues. They must be left exactly as they are.
    const root = project();
    const legacyId = 'FB-260825-1';
    mkdirSync(join(root, '.forgeax', 'feedback'), { recursive: true });
    writeFileSync(join(root, '.forgeax', 'feedback', 'records.json'), `${JSON.stringify([{
      id: legacyId, type: 'ui', status: 'processing', source: 'manual', title: 'ui',
      count: 1, createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z',
      delivery: { status: 'published', occurrence: 1, attempts: 1, issueNumber: 19, updatedAt: '2026-08-25T00:00:00.000Z' },
    }])}\n`);

    const repository = new FeedbackRepository(() => root);
    const fresh = await repository.submit({ type: 'wrong', source: 'manual' });
    expect(fresh.report.id).toMatch(/^FB-\d{6}-[0-9a-f]{6}-\d+$/);

    const legacy = await repository.get(legacyId);
    expect(legacy?.id).toBe(legacyId);
    expect(legacy?.delivery?.issueNumber).toBe(19);
  });

  test('the page API returns immediately after durable local storage and enqueues delivery', async () => {
    const root = project();
    const repository = new FeedbackRepository(() => root);
    const enqueued: string[] = [];
    const app = createFeedbackRouter({
      getProjectRoot: () => root,
      repository,
      delivery: { enqueue: (id) => enqueued.push(id) },
    });
    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'wrong', source: 'manual', description: 'broken' }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as any;
    expect(body.report.delivery.status).toBe('queued');
    expect(enqueued).toEqual([body.report.id]);

    const listed = await app.request('/');
    expect(await listed.json()).toMatchObject({ ok: true, reports: [{ id: body.report.id }] });
  });

  test('the page API can retry locally persisted failed deliveries after settings change', async () => {
    const root = project();
    let calls = 0;
    const app = createFeedbackRouter({
      getProjectRoot: () => root,
      delivery: {
        enqueue: () => undefined,
        retryFailed: async () => {
          calls += 1;
          return 3;
        },
      },
    });

    const response = await app.request('/retry', { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, queued: 3 });
    expect(calls).toBe(1);
  });
});
