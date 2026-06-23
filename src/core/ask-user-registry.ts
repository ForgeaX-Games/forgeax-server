/** ask-user-registry —— `ask_user` 工具的「阻塞 + HTTP 回执」往返中枢。
 *
 *  `ask_user` 工具在 execute() 里 registerAsk()，拿到一个会阻塞的 Promise；
 *  前端选完后 `POST /api/sessions/:sid/ask-reply` 调 resolveAsk() 把它解开。
 *
 *  与 `src/tools/registry.ts::awaitConfirm` 同款模式：模块级 Map<token, resolve>，
 *  单进程（Bun）安全。token = `${sid}::${agentPath}` —— 工具默认串行
 *  (tool-batch-runner partition)，故同一 agent 同一时刻至多一个 ask 在 pending，
 *  键天然唯一，无需 tool_call id。 */

interface Pending {
  resolve: (values: string[] | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();

function keyOf(sid: string, agentPath: string): string {
  return `${sid}::${agentPath}`;
}

export interface AskHandle {
  /** Resolves to the chosen label array, or null when aborted / timed out. */
  promise: Promise<string[] | null>;
  /** Settle the promise with null（用户中断/放弃）+ cleanup。Idempotent。
   *  abort 路径必须用这个而不是 dispose() —— dispose 只清表项不 settle，
   *  await 方会永远挂起。 */
  cancel(): void;
  /** Idempotent cleanup —— removes the pending entry + clears the timer.
   *  不 settle promise；只能在 promise 已 settle 之后（finally）调用。 */
  dispose(): void;
}

/** Register a pending ask. The returned promise resolves when the UI replies
 *  via resolveAsk(), or to `null` on timeout. Always call dispose() in a
 *  finally to drop the entry and avoid leaks. */
export function registerAsk(sid: string, agentPath: string, timeoutMs: number): AskHandle {
  const key = keyOf(sid, agentPath);
  // Drop any stale pending under the same key (e.g. a previous ask that the
  // user never answered and which is being superseded).
  const prev = pending.get(key);
  if (prev) {
    clearTimeout(prev.timer);
    prev.resolve(null);
    pending.delete(key);
  }

  let settle!: (values: string[] | null) => void;
  const promise = new Promise<string[] | null>((res) => {
    settle = res;
  });

  const timer = setTimeout(() => {
    if (pending.get(key)?.resolve === settle) pending.delete(key);
    settle(null);
  }, timeoutMs);

  pending.set(key, { resolve: settle, timer });

  const cleanup = () => {
    const cur = pending.get(key);
    if (cur && cur.resolve === settle) {
      clearTimeout(cur.timer);
      pending.delete(key);
    }
  };

  return {
    promise,
    cancel() {
      cleanup();
      settle(null);
    },
    dispose: cleanup,
  };
}

/** Resolve a pending ask with the user's selection. Returns true when a
 *  matching pending entry was found and resolved, false otherwise (already
 *  answered / timed out / unknown key). */
export function resolveAsk(sid: string, agentPath: string, values: string[]): boolean {
  const key = keyOf(sid, agentPath);
  const entry = pending.get(key);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(key);
  entry.resolve(values);
  return true;
}
