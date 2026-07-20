/**
 * Track S — server telemetry transport 单测(observability v3 / B 档)。
 *
 * 跑:`bun test packages/server/test/telemetry-transport.test.ts`(纯本地,无需 API key)。
 *
 * 覆盖:
 *  1) file sink:span→trace.jsonl / log→log.jsonl,各一行 JSONL;未知 kind 丢弃。
 *  2) file sink 大小轮转:超 MAX_FILE_SIZE 触发 `f`→`f.1` 平移。
 *  3) adapter handleTelemetry(模拟 onNotify('telemetry',{records}) 旁路):
 *     注入 broadcast spy + temp-dir sink → 断言 broadcast 收到 {type:'telemetry'} 且 JSONL 落盘。
 *  4) 非法/空 records 容错:不抛、不广播、不写盘。
 */
import { test, expect, beforeEach } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TelemetryRecord } from '@forgeax/types';
import {
  createTelemetryFileSink,
  __resetTelemetryFileSinkState,
} from '../src/kernel/telemetry-file-sink';
import { createForgeaxCoreKernel } from '../src/kernel/forgeax-core-adapter';
import { initPathManager } from '@forgeax/orchestrator/fs/path-manager';

beforeEach(() => __resetTelemetryFileSinkState());

test('file sink default resolveLogsDir uses PathManager <userRoot>/sessions/<sid>/logs', () => {
  const root = tmp();
  initPathManager({ userRoot: root }); // 把 PathManager 单例的 userRoot 指到临时目录
  const sink = createTelemetryFileSink(); // 不注入 resolveLogsDir → 走默认 getPathManager() 分支
  sink.write('sess-D', [span]);
  expect(existsSync(join(root, 'sessions', 'sess-D', 'logs', 'trace.jsonl'))).toBe(true);
});

test('file sink onError fires when logs-dir resolution throws (best-effort, no throw)', () => {
  const errors: unknown[] = [];
  const sink = createTelemetryFileSink({
    onError: (e) => errors.push(e),
    resolveLogsDir: () => {
      throw new Error('resolve boom');
    },
  });
  sink.write('sess-A', [span]); // 不抛回调用方
  expect(errors.length).toBe(1);
  expect(String(errors[0])).toContain('resolve boom');
});

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'fx-telemetry-'));
}

const span: TelemetryRecord = {
  kind: 'span',
  traceId: 't1',
  spanId: 's1',
  name: 'agent.run',
  startTs: 1,
  endTs: 2,
  sid: 'sess-A',
};
const log: TelemetryRecord = {
  kind: 'log',
  ts: 3,
  level: 'info',
  msg: 'hello',
  traceId: 't1',
  spanId: 's1',
  sid: 'sess-A',
};

test('file sink splits span→trace.jsonl and log→log.jsonl', () => {
  const dir = tmp();
  const sink = createTelemetryFileSink({ resolveLogsDir: () => dir });
  sink.write('sess-A', [span, log]);

  const traceFile = join(dir, 'trace.jsonl');
  const logFile = join(dir, 'log.jsonl');
  expect(existsSync(traceFile)).toBe(true);
  expect(existsSync(logFile)).toBe(true);

  const traceLines = readFileSync(traceFile, 'utf-8').trim().split('\n');
  const logLines = readFileSync(logFile, 'utf-8').trim().split('\n');
  expect(traceLines.length).toBe(1);
  expect(logLines.length).toBe(1);
  expect(JSON.parse(traceLines[0]!).kind).toBe('span');
  expect(JSON.parse(traceLines[0]!).spanId).toBe('s1');
  expect(JSON.parse(logLines[0]!).kind).toBe('log');
  expect(JSON.parse(logLines[0]!).msg).toBe('hello');
});

test('file sink appends across multiple writes (JSONL grows, no overwrite)', () => {
  const dir = tmp();
  const sink = createTelemetryFileSink({ resolveLogsDir: () => dir });
  sink.write('sess-A', [span]);
  sink.write('sess-A', [span]);
  sink.write('sess-A', [span]);
  const lines = readFileSync(join(dir, 'trace.jsonl'), 'utf-8').trim().split('\n');
  expect(lines.length).toBe(3);
});

test('file sink ignores unknown-kind records and empty/undefined sid', () => {
  const dir = tmp();
  const sink = createTelemetryFileSink({ resolveLogsDir: () => dir });
  // unknown kind → neither file
  sink.write('sess-A', [{ kind: 'weird' } as unknown as TelemetryRecord]);
  expect(existsSync(join(dir, 'trace.jsonl'))).toBe(false);
  expect(existsSync(join(dir, 'log.jsonl'))).toBe(false);
  // undefined sid → no write attempt at all
  sink.write(undefined, [span]);
  expect(existsSync(join(dir, 'trace.jsonl'))).toBe(false);
});

test('file sink rotates when a single file exceeds the size cap', () => {
  const dir = tmp();
  let resolved = '';
  const sink = createTelemetryFileSink({ resolveLogsDir: () => (resolved = dir) });
  // Build a single span record big enough to blow past 50MB in a few writes.
  const big: TelemetryRecord = { ...span, attrs: { blob: 'x'.repeat(6 * 1024 * 1024) } };
  // Rotation fires when a write's pre-check sees the live file already >= cap.
  // 9 writes × ~6MB ≈ 54MB takes it past 50MB; the 10th write's pre-check trips
  // the rotate (f→f.1) before appending.
  for (let i = 0; i < 10; i++) sink.write('sess-A', [big]);
  expect(resolved).toBe(dir);
  const rotated = join(dir, 'trace.jsonl.1');
  expect(existsSync(rotated)).toBe(true);
  // Live file size must be below the cap (rotation reset it).
  expect(statSync(join(dir, 'trace.jsonl')).size).toBeLessThan(50 * 1024 * 1024);
});

test('adapter handleTelemetry: broadcasts {type:telemetry} and persists JSONL', () => {
  const dir = tmp();
  const broadcasts: Array<{ type: string; records?: unknown }> = [];
  const sink = createTelemetryFileSink({ resolveLogsDir: () => dir });
  const kernel = createForgeaxCoreKernel({
    broadcast: (msg) => broadcasts.push(msg as { type: string; records?: unknown }),
    telemetrySink: sink,
  });

  // Simulate the onNotify('telemetry', { records }) bypass. handleTelemetry is
  // private; invoke it as the onNotify branch would, with an explicit host sid.
  (kernel as unknown as { handleTelemetry(p: unknown, sid?: string): void }).handleTelemetry(
    { records: [span, log] },
    'sess-A',
  );

  // (b) broadcast fired with the telemetry envelope shape.
  expect(broadcasts.length).toBe(1);
  expect(broadcasts[0]!.type).toBe('telemetry');
  expect(Array.isArray(broadcasts[0]!.records)).toBe(true);
  expect((broadcasts[0]!.records as unknown[]).length).toBe(2);

  // (a) JSONL persisted under the (injected) logs dir.
  expect(JSON.parse(readFileSync(join(dir, 'trace.jsonl'), 'utf-8').trim()).kind).toBe('span');
  expect(JSON.parse(readFileSync(join(dir, 'log.jsonl'), 'utf-8').trim()).kind).toBe('log');
});

test('file sink drops a single unserializable record (circular ref) but keeps the batch alive', () => {
  const dir = tmp();
  const sink = createTelemetryFileSink({ resolveLogsDir: () => dir });
  const circular: Record<string, unknown> = { kind: 'span', traceId: 't', spanId: 's', name: 'n', startTs: 1 };
  circular.self = circular; // JSON.stringify 抛 → 该条丢弃,不拖垮整批
  sink.write('sess-A', [circular as unknown as TelemetryRecord, span]);
  const lines = readFileSync(join(dir, 'trace.jsonl'), 'utf-8').trim().split('\n');
  expect(lines.length).toBe(1); // 只剩正常那条
  expect(JSON.parse(lines[0]!).spanId).toBe('s1');
});

test('adapter maybeHandleTelemetry: routes telemetry (true) vs passes through non-telemetry (false)', () => {
  const dir = tmp();
  const broadcasts: Array<{ type: string }> = [];
  const sink = createTelemetryFileSink({ resolveLogsDir: () => dir });
  const kernel = createForgeaxCoreKernel({
    broadcast: (msg) => broadcasts.push(msg as { type: string }),
    telemetrySink: sink,
  }) as unknown as { maybeHandleTelemetry(m: string, p: unknown, sid?: string): boolean };

  expect(kernel.maybeHandleTelemetry('telemetry', { records: [span] }, 'sess-A')).toBe(true);
  expect(broadcasts.length).toBe(1);
  expect(kernel.maybeHandleTelemetry('event', { records: [span] }, 'sess-A')).toBe(false);
  expect(broadcasts.length).toBe(1); // 非 telemetry 不消费、不广播
});

test('adapter handleTelemetry: invalid/empty records do not throw, broadcast, or write', () => {
  const dir = tmp();
  const broadcasts: unknown[] = [];
  const sink = createTelemetryFileSink({ resolveLogsDir: () => dir });
  const kernel = createForgeaxCoreKernel({
    broadcast: (msg) => broadcasts.push(msg),
    telemetrySink: sink,
  }) as unknown as { handleTelemetry(p: unknown, sid?: string): void };

  // empty array
  kernel.handleTelemetry({ records: [] }, 'sess-A');
  // missing records
  kernel.handleTelemetry({}, 'sess-A');
  // all-invalid records (no valid kind)
  kernel.handleTelemetry({ records: [{ nope: 1 }, null, 'str'] }, 'sess-A');
  // non-object params (must not throw)
  kernel.handleTelemetry(undefined, 'sess-A');

  expect(broadcasts.length).toBe(0);
  expect(existsSync(join(dir, 'trace.jsonl'))).toBe(false);
  expect(existsSync(join(dir, 'log.jsonl'))).toBe(false);
});

test('file sink evict: no-throw on edge sids, and write→evict→write keeps persistence intact', () => {
  const dir = tmp();
  const sink = createTelemetryFileSink({ resolveLogsDir: () => dir });
  // 防御路径:空 sid / 未知 sid 都不抛(byteCounters 没有对应键也安全)。
  expect(() => sink.evict(undefined)).not.toThrow();
  expect(() => sink.evict('never-written')).not.toThrow();
  // 正常路径:写入后驱逐(清掉该 sid 的字节计数缓存),再写仍正确续写。
  sink.write('sess-A', [span]);
  sink.evict('sess-A');
  sink.write('sess-A', [span]);
  const lines = readFileSync(join(dir, 'trace.jsonl'), 'utf-8').trim().split('\n');
  expect(lines.length).toBe(2); // 驱逐后按 statSync 重建字节数,续写不丢、不覆盖
});
