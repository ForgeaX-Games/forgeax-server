/** Abort-aware SSE heartbeat for Hono `streamSSE` loops.
 *
 *  WHY THIS EXISTS — Bun ≥ 1.2 leak (perf-analysis-2, maintenance dimension 5):
 *  Hono's `streamSSE` only bridges `req.signal → stream.abort()` when
 *  `isOldBunVersion()` is true (Bun 1.0/1.1/0.x). On Bun ≥ 1.2 that bridge is
 *  skipped, and `StreamingApi.write()` swallows write errors in a bare
 *  `catch {}`. So the classic
 *
 *      while (true) { await stream.sleep(15_000); await stream.writeSSE(...); }
 *
 *  heartbeat NEVER terminates on client disconnect: the loop has no exit
 *  condition, `sleep` is a plain `setTimeout` (not abort-aware), and the write
 *  never throws. Each UI reconnect leaks one orphan timer + closure → long-run
 *  OOM.
 *
 *  This helper makes the loop disconnect-aware via THREE independent signals,
 *  any one of which stops it:
 *    1. `stream.onAbort(...)` flips a local `closed` flag (fires when the
 *       response ReadableStream is cancelled — the path that DOES still work).
 *    2. The loop polls `stream.aborted` / `stream.closed` each iteration.
 *    3. `writeSSE` rejection (or, if we ever stop swallowing, a thrown write)
 *       is treated as a closed connection and breaks the loop.
 *  The sleep itself is abort-aware (`Promise.race(timer, abortPromise)`) so a
 *  disconnect during the idle window resolves immediately and we never schedule
 *  the next timer. On exit we `clearTimeout` and run the caller's `cleanup`
 *  (unsubscribe / release closures) on EVERY path.
 */
import type { SSEStreamingApi } from 'hono/streaming';

export interface HeartbeatOptions {
  /** Idle interval between pings, ms. Default 15s (reverse-proxy keep-alive). */
  intervalMs?: number;
  /** SSE event name for the heartbeat. Default 'ping'. */
  event?: string;
  /** Run on exit (abort OR write failure) — unsubscribe, drop closures, etc.
   *  Called exactly once, even if the caller already wired its own onAbort. */
  cleanup?: () => void;
}

/** Block on an abort-aware ping loop until the SSE client disconnects.
 *  Returns when the connection is gone; the enclosing `streamSSE` callback then
 *  falls through to Hono's `finally { stream.close() }`. */
export async function runSseHeartbeat(
  stream: SSEStreamingApi,
  opts: HeartbeatOptions = {},
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 15_000;
  const event = opts.event ?? 'ping';

  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveAbort: (() => void) | undefined;

  const markClosed = () => {
    if (closed) return;
    closed = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    // Unblock an in-flight sleep so the loop re-checks and exits now.
    resolveAbort?.();
  };

  // onAbort fires on disconnect via the response ReadableStream `cancel` path,
  // which still works on Bun ≥ 1.2 (unlike the req.signal bridge).
  stream.onAbort(markClosed);

  const isGone = () => closed || stream.aborted || stream.closed;

  try {
    while (!isGone()) {
      // Abort-aware sleep: whichever of (timer, abort) resolves first wins, and
      // on abort we never schedule the next iteration's timer.
      await new Promise<void>((resolve) => {
        resolveAbort = resolve;
        timer = setTimeout(() => {
          timer = undefined;
          resolve();
        }, intervalMs);
      });
      resolveAbort = undefined;
      if (isGone()) break;
      try {
        await stream.writeSSE({ event, data: String(Date.now()) });
      } catch {
        // Connection closed underneath us — stop, don't reschedule.
        markClosed();
        break;
      }
    }
  } finally {
    markClosed();
    opts.cleanup?.();
  }
}
