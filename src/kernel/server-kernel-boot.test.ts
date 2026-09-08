// M5 acceptance anchor (AC-08, D-3, plan-strategy Section 3.1): after the server
// kernel shell collapse, `main.ts` no longer owns the kernel boot ORDER — it
// injects product params through the `@forgeax/orchestrator/kernel` facade and
// holds the returned handle for teardown. This test pins the server-side USAGE
// contract: driving the facade with the exact opts shape `main.ts` passes
// (projectRoot + env + a `registerNativeKernel` gated on FORGEAX_KERNEL_IMPL)
// must produce the assembly sequence the retired inline code produced:
//
//   register self-hosted rented kernels
//     -> product registerNativeKernel (forgeax-core adapter)
//       -> ensureSidecar  (only when the kernel + sidecar stack is guarded on)
//         -> wipe server model keys (only under FORGEAX_KERNEL_ONLY once warm)
//
// The seams are injected so the assertion never spawns a real sidecar/binary; it
// verifies WHAT the server wires, not a live process. This is the behavior-
// equivalence proof for the two hand-written boot sites main.ts used to own
// (cold-start prewarm + R3-02 kernel-only key wipe) collapsing into one
// createKernelRuntime().boot() call.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  createKernelRuntime,
  shutdownKernel,
  type BootKernelOpts,
} from '@forgeax/orchestrator/kernel';

// Env keys the boot path reads (kernel-mode gate + kernel-only key wipe). Saved
// and cleared before each test so an ambient .env cannot leak into ordering.
const BOOT_ENV_KEYS = [
  'FORGEAX_KERNEL',
  'FORGEAX_SIDECAR',
  'FORGEAX_KERNEL_ONLY',
  'FORGEAX_NO_KERNEL',
  'FORGEAX_KERNEL_IMPL',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of BOOT_ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of BOOT_ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// A seam bundle recording the order the facade drives its internalized steps.
// Mirrors the orchestrator-side facade test spy so a server-side assertion can
// verify the same order emerges from the SERVER's opts wiring.
function makeSeamSpy(): { seams: NonNullable<BootKernelOpts['__seams']>; order: string[] } {
  const order: string[] = [];
  const seams: NonNullable<BootKernelOpts['__seams']> = {
    registerSelfHostedKernels: () => {
      order.push('register-self-hosted');
    },
    ensureSidecar: async () => {
      order.push('ensure-sidecar');
    },
    stripServerModelKeys: () => {
      order.push('strip-keys');
    },
    closeClaudeSessionPool: async () => {
      order.push('close-claude-pool');
    },
    closeCodexAppServerPool: async () => {
      order.push('close-codex-pool');
    },
    shutdownProjectMcpPool: async () => {
      order.push('shutdown-mcp-pool');
    },
    teardownSidecar: async () => {
      order.push('teardown-sidecar');
    },
  };
  return { seams, order };
}

// Reproduce exactly how `main.ts` builds the kernel runtime opts: the native
// forgeax-core registrar is injected ONLY when FORGEAX_KERNEL_IMPL resolves to
// forgeax-core (its default), otherwise no native kernel is injected. The
// server passes `instanceRoot` as projectRoot and the live process env.
function serverKernelOpts(
  projectRoot: string,
  order: string[],
  seams: NonNullable<BootKernelOpts['__seams']>,
): BootKernelOpts {
  if (!process.env.FORGEAX_KERNEL_IMPL?.trim()) {
    process.env.FORGEAX_KERNEL_IMPL = 'forgeax-core';
  }
  const useForgeaxCoreKernel = process.env.FORGEAX_KERNEL_IMPL.trim() === 'forgeax-core';
  return {
    projectRoot,
    env: process.env as Record<string, string | undefined>,
    registerNativeKernel: useForgeaxCoreKernel
      ? (): void => {
          order.push('inject-native');
        }
      : undefined,
    __seams: seams,
  };
}

const PROJECT_ROOT = '/tmp/forgeax-server-kernel-boot-test';

describe('server kernel shell — createKernelRuntime wiring (AC-08, D-3)', () => {
  test('default (kernel+sidecar): registers self-hosted, injects forgeax-core, warms sidecar in order', async () => {
    const { seams, order } = makeSeamSpy();
    const rt = createKernelRuntime(serverKernelOpts(PROJECT_ROOT, order, seams));
    // createKernelRuntime is pure construction: no seam runs until boot().
    expect(order).toEqual([]);
    await rt.boot();
    // The server injects the native kernel registrar; the facade sequences it
    // after self-hosted registration and warms the sidecar last.
    expect(order).toEqual(['register-self-hosted', 'inject-native', 'ensure-sidecar']);
    await shutdownKernel(rt);
  });

  test('non-forgeax-core kernel impl: server injects NO native registrar', async () => {
    process.env.FORGEAX_KERNEL_IMPL = 'claude-code';
    const { seams, order } = makeSeamSpy();
    const rt = createKernelRuntime(serverKernelOpts(PROJECT_ROOT, order, seams));
    await rt.boot();
    // Self-hosted rented kernels still register + sidecar warms, but the server
    // does not inject a forgeax-core registrar for a rented default kernel.
    expect(order).toContain('register-self-hosted');
    expect(order).not.toContain('inject-native');
    await shutdownKernel(rt);
  });

  test('kernel disabled (FORGEAX_KERNEL=cli): sidecar prewarm is skipped', async () => {
    process.env.FORGEAX_KERNEL = 'cli';
    const { seams, order } = makeSeamSpy();
    const rt = createKernelRuntime(serverKernelOpts(PROJECT_ROOT, order, seams));
    await rt.boot();
    expect(order).not.toContain('ensure-sidecar');
    await shutdownKernel(rt);
  });

  test('kernel-only (FORGEAX_KERNEL_ONLY=1): sidecar warms THEN server model keys are wiped', async () => {
    process.env.FORGEAX_KERNEL_ONLY = '1';
    const { seams, order } = makeSeamSpy();
    const rt = createKernelRuntime(serverKernelOpts(PROJECT_ROOT, order, seams));
    await rt.boot();
    const warmAt = order.indexOf('ensure-sidecar');
    const wipeAt = order.indexOf('strip-keys');
    expect(warmAt).toBeGreaterThanOrEqual(0);
    expect(wipeAt).toBeGreaterThanOrEqual(0);
    // R3-02 invariant: wipe only AFTER the sidecar holds the key.
    expect(wipeAt).toBeGreaterThan(warmAt);
    await shutdownKernel(rt);
  });

  test('kernel-only but sidecar off: keys are NOT wiped (would leave no usable path)', async () => {
    process.env.FORGEAX_KERNEL_ONLY = '1';
    process.env.FORGEAX_SIDECAR = 'off';
    const { seams, order } = makeSeamSpy();
    const rt = createKernelRuntime(serverKernelOpts(PROJECT_ROOT, order, seams));
    await rt.boot();
    expect(order).not.toContain('strip-keys');
    await shutdownKernel(rt);
  });
});

describe('server kernel shell — shutdownKernel teardown (AC-08 behavior equivalence)', () => {
  test('shutdownKernel reaps the Claude/Codex/project-MCP pools the server used to close inline', async () => {
    const { seams, order } = makeSeamSpy();
    const rt = createKernelRuntime(serverKernelOpts(PROJECT_ROOT, order, seams));
    await rt.boot();
    order.length = 0; // isolate the teardown sequence
    await shutdownKernel(rt);
    // The three pool closes main.ts owned inline (ClaudeCodeKernel.closeSessionPool
    // / CodexKernel.closeAppServerPool / shutdownProjectMcpPool) are all driven by
    // the single shutdownKernel call, in that order.
    expect(order).toContain('close-claude-pool');
    expect(order).toContain('close-codex-pool');
    expect(order).toContain('shutdown-mcp-pool');
    expect(order.indexOf('close-claude-pool')).toBeLessThan(order.indexOf('close-codex-pool'));
    expect(order.indexOf('close-codex-pool')).toBeLessThan(order.indexOf('shutdown-mcp-pool'));
  });
});
