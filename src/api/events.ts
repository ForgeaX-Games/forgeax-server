/** /api/events — Phase D5.
 *
 *  GET  /api/events/recent?topic=<glob>&n=<int>  → EventEnvelope[]
 *  POST /api/events/emit                          → manual emit (debugging /
 *                                                   skill-runner pre-D4)
 *  GET  /api/events/stream?topic=<glob>           → SSE fanout
 *
 *  Emit accepts `{ topic, payload, threadId? }`. SSE is a one-shot live tap;
 *  callers needing replay use /recent. */
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getEventBus } from '../events/bus';
import { runSseHeartbeat } from './lib/sse-heartbeat';

export function createEventsRouter() {
  const r = new Hono();

  r.get('/recent', (c) => {
    const topic = c.req.query('topic') || '*';
    const n = Number(c.req.query('n') || '50');
    const events = getEventBus().recent(topic, Number.isFinite(n) ? n : 50);
    return c.json({ events });
  });

  r.post('/emit', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.topic !== 'string') {
      return c.json({ ok: false, error: 'topic (string) required' }, 400);
    }
    const env = getEventBus().emit(body.topic, body.payload ?? null, {
      threadId: typeof body.threadId === 'string' ? body.threadId : undefined,
    });
    return c.json({ ok: true, env });
  });

  r.get('/stream', (c) =>
    streamSSE(c, async (stream) => {
      const topic = c.req.query('topic') || '*';
      let closed = false;
      const unsub = getEventBus().subscribe(topic, (env) => {
        if (closed) return;
        // Fire-and-forget; swallow post-disconnect write failures so a dead
        // connection can't surface an unhandled rejection.
        void stream.writeSSE({ event: 'event', data: JSON.stringify(env) }).catch(() => {});
      });
      // Keep the stream open; SSE clients close from their side. The heartbeat
      // loop is abort-aware (see sse-heartbeat.ts) — on disconnect it exits and
      // runs cleanup, releasing the bus subscription. Without this, the old
      // `while (true)` leaked one orphan timer + closure per UI reconnect on
      // Bun ≥ 1.2 (Hono's req.signal→abort bridge is skipped there).
      await runSseHeartbeat(stream, {
        cleanup: () => {
          closed = true;
          unsub();
        },
      });
    }),
  );

  return r;
}
