// Shared adapter: spawn a CLI binary, stream its stdout as ndjson lines,
// and bridge an AbortSignal to SIGTERM (then SIGKILL after a grace period).
//
// Used by ClaudeCodeProvider (Phase 2) and CodexProvider (Phase 2.5). The
// translator (claude-code-mapper.ts / codex-mapper.ts) sits on top of this
// and converts each parsed JSON line into a ChatEvent.

// friendlyPath 已搬到 api/lib/ (commit 64078a4); cli-providers 复活时 reuse 那一份。
import { friendlyPath } from '../../api/lib/friendly-path';

export interface SpawnJsonlOptions {
  /** Absolute path or PATH-resolvable binary name. */
  cmd: string;
  /** Argv tail (the binary's flags + positional args). */
  args: string[];
  /** Working directory for the subprocess. Defaults to process.cwd(). */
  cwd?: string;
  /** Extra env vars (merged onto process.env). */
  env?: Record<string, string>;
  /**
   * Optional payload written to the subprocess's stdin and then EOF-closed.
   * If omitted, stdin is closed immediately.
   */
  stdin?: string;
  /** Abort signal — triggers SIGTERM + grace-period SIGKILL. */
  signal: AbortSignal;
  /** Grace ms between SIGTERM and SIGKILL. Default 2000. */
  killGraceMs?: number;
}

export interface SpawnJsonlResult<T> {
  /** Async iterator over JSON-parsed stdout lines. */
  lines: AsyncIterable<T>;
  /** Promise resolves with exit code AFTER stdout/stderr are drained. */
  exit: Promise<{ code: number; stderr: string }>;
}

/** Spawn a CLI emitting ndjson on stdout. Each non-empty line is JSON.parse'd
 *  and yielded as T. Malformed lines are skipped silently except for a
 *  console.warn at server stderr (with friendlyPath-redacted cmd), so the
 *  caller's stream consumer never has to handle parse errors itself. */
export function spawnJsonl<T = unknown>(opts: SpawnJsonlOptions): SpawnJsonlResult<T> {
  const { cmd, args, cwd, env, stdin, signal, killGraceMs = 2000 } = opts;

  const proc = Bun.spawn({
    cmd: [cmd, ...args],
    cwd: cwd ?? process.cwd(),
    env: { ...process.env, ...(env ?? {}) },
    stdin: stdin !== undefined ? 'pipe' : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Stdin payload + EOF
  if (stdin !== undefined && proc.stdin) {
    proc.stdin.write(stdin);
    proc.stdin.end();
  }

  // Wire abort → SIGTERM, then SIGKILL after grace period.
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const onAbort = () => {
    try {
      proc.kill('SIGTERM');
    } catch {
      /* already dead */
    }
    killTimer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }, killGraceMs);
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });

  // Stderr drained in parallel — we keep the text for the exit summary so
  // the caller can surface it in an error ChatEvent.
  let stderrBuf = '';
  const stderrDone = (async () => {
    if (!proc.stderr) return;
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      stderrBuf += dec.decode(value, { stream: true });
    }
  })();

  // Stdout line splitter.
  async function* iterate(): AsyncIterable<T> {
    if (!proc.stdout) return;
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            yield JSON.parse(line) as T;
          } catch (e) {
            // Redact $HOME in the cmd path so the warn doesn't leak
            // /data/home/<user>/... into logs. Execution path stays raw.
            console.warn(
              `[subprocess-jsonl] dropped malformed line from ${friendlyPath(cmd)}: ${(e as Error).message} :: ${line.slice(0, 120)}`,
            );
          }
        }
      }
      // Flush remainder (in case the process didn't terminate stdout with \n).
      const tail = buf.trim();
      if (tail) {
        try {
          yield JSON.parse(tail) as T;
        } catch {
          /* ignore trailing garbage */
        }
      }
    } finally {
      reader.releaseLock();
      signal.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
    }
  }

  const exit = (async () => {
    const code = await proc.exited;
    await stderrDone;
    return { code, stderr: stderrBuf };
  })();

  return { lines: iterate(), exit };
}
