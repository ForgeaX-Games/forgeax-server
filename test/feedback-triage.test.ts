import { describe, expect, test } from 'bun:test';
import type { AgentKernel, TurnRequest } from '@forgeax/agent-runtime';
import type { FeedbackReport } from '@forgeax/types/feedback';
import { triageFeedback } from '../src/game/feedback/triage';

const report: FeedbackReport = {
  id: 'FB-260818-1',
  type: 'ui',
  status: 'processing',
  source: 'manual',
  title: 'ui',
  description: '按钮错位',
  context: { logs: ['token ghp_' + 'x'.repeat(36), '/tmp/project/private'] },
  count: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('forgeax-cli feedback triage', () => {
  test('uses the native kernel with no tools and accepts structured JSON', async () => {
    let request: TurnRequest | undefined;
    const kernel = {
      id: 'forgeax-core',
      capabilities: { streaming: true, thinking: true, toolCalls: true, midTurnInject: false, forkExtract: true },
      runTurn(req: TurnRequest) {
        request = req;
        return (async function* () {
          yield { kind: 'message.delta', role: 'assistant', text: '{"title":"界面按钮错位","summary":"按钮位置异常","reproductionSteps":["打开面板"],"expectedBehavior":"按钮对齐","actualBehavior":"按钮错位","observations":[],"labels":["bug"]}' } as const;
        })();
      },
      openHandle: () => ({ cancel: async () => undefined }),
      probe: async () => ({ ok: true as const }),
    } as unknown as AgentKernel;

    const result = await triageFeedback(report, { projectRoot: '/tmp/project', kernel });
    expect(result).toMatchObject({ title: '界面按钮错位', source: 'forgeax-cli', labels: ['bug'] });
    expect(result.expectedBehavior).toBe('按钮对齐');
    expect(result.actualBehavior).toBe('按钮错位');
    expect(result.routing.repository).toBe('ForgeaX-Games/forgeax-studio');
    expect(request?.tools).toEqual([]);
    expect(request?.toolPolicy).toEqual({ allow: [] });
    expect(request?.input.text).not.toContain('ghp_' + 'x'.repeat(36));
    expect(request?.input.text).not.toContain('/tmp/project/private');
    expect(request?.systemPrompt.charter).toContain('no Mermaid syntax or guessed screenshot association');
  });

  test('falls back deterministically when the native kernel is unavailable', async () => {
    const result = await triageFeedback(report, { projectRoot: '/tmp/project' });
    expect(result.source).toBe('fallback');
    expect(result.title).toContain(report.id);
    expect(result.labels).toEqual(['bug']);
    expect(result.actualBehavior).toBe(report.description!);
    expect(result.routing.confidence).toBe('low');
  });
});
