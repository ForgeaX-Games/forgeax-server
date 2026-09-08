/**
 * 回归测试:server 自己的 forgeax-core adapter 必须声明 `orchestrationProfile =
 * NATIVE_KERNEL_PROFILE`,否则 `orchestrationProfileOf()` 会静默兜底成
 * RENTED_KERNEL_PROFILE(hostOwnedHistory:false),导致 compose-turn-request.ts
 * 永远不给这个内核装 history —— 每轮对话都从零开始。
 *
 * 跑:`bun test packages/server/test/forgeax-core-adapter-orchestration-profile.test.ts`
 * (纯本地构造,不 spawn sidecar)。
 */
import { test, expect } from 'bun:test';
import { orchestrationProfileOf } from '@forgeax/orchestrator/kernel/kernel-profile';
import { createForgeaxCoreKernel } from '../src/kernel/forgeax-core-adapter';

test('server forgeax-core adapter declares hostOwnedHistory:true', () => {
  const kernel = createForgeaxCoreKernel();
  const profile = orchestrationProfileOf(kernel);
  expect(profile.hostOwnedHistory).toBe(true);
});

test('server adapter resolves a packaged host ask from its own pending registry', async () => {
  const kernel = createForgeaxCoreKernel() as unknown as {
    waitForHostedAsk(sid: string, agentPath: string, args: unknown): Promise<string>;
    resolveAskReply(
      sid: string,
      agentPath: string,
      values: Array<{ questionId: string; values: string[] }>,
      identity?: Record<string, unknown>,
    ): boolean;
  };

  const pending = kernel.waitForHostedAsk('sid-1', 'forge', {
    questions: [
      { id: 'color', prompt: 'Color?' },
      { id: 'speed', prompt: 'Speed?' },
    ],
  });

  expect(kernel.resolveAskReply('sid-1', 'forge', [
    { questionId: 'color', values: ['Red'] },
    { questionId: 'speed', values: ['Fast'] },
  ])).toBe(true);
  expect(JSON.parse(await pending)).toEqual({
    ok: true,
    questions: [
      { questionId: 'color', values: ['Red'] },
      { questionId: 'speed', values: ['Fast'] },
    ],
  });
});
