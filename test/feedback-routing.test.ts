import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FeedbackReport } from '@forgeax/types/feedback';
import { collectFeedbackRoutingEvidence } from '../src/game/feedback/routing';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

describe('feedback repository routing', () => {
  test('routes a diagnostic file path to its submodule and reads relevant Git history', () => {
    const root = mkdtempSync(join(tmpdir(), 'fx-feedback-routing-root-'));
    const editorSource = mkdtempSync(join(tmpdir(), 'fx-feedback-routing-editor-'));
    roots.push(root, editorSource);
    git(root, ['init', '-q']);
    git(root, ['remote', 'add', 'origin', 'git@github.com:ForgeaX-Games/forgeax-studio.git']);
    git(editorSource, ['init', '-q']);
    git(editorSource, ['remote', 'add', 'origin', 'git@github.com:ForgeaX-Games/forgeax-editor.git']);
    mkdirSync(join(editorSource, 'src'), { recursive: true });
    writeFileSync(join(editorSource, 'src', 'Assets.tsx'), 'export const Assets = true;\n');
    git(editorSource, ['add', '.']);
    git(editorSource, ['-c', 'user.name=Editor Owner', '-c', 'user.email=editor@example.com', 'commit', '-qm', 'fix(editor): asset panel']);
    git(root, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', editorSource, 'packages/editor']);
    git(join(root, 'packages/editor'), ['remote', 'set-url', 'origin', 'git@github.com:ForgeaX-Games/forgeax-editor.git']);

    const report: FeedbackReport = {
      id: 'FB-260819-1',
      type: 'wrong',
      status: 'processing',
      source: 'manual',
      title: 'wrong',
      description: '场景编辑器的资产面板显示错误',
      context: {
        logs: [`failed at ${join(root, 'packages/editor/src/Assets.tsx')}`],
      },
      count: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const routing = collectFeedbackRoutingEvidence(report, root);
    expect(routing.repository).toBe('ForgeaX-Games/forgeax-editor');
    expect(routing.businessModule).toContain('Editor');
    expect(routing.confidence).toBe('high');
    expect(routing.relevantPaths).toContain('src/Assets.tsx');
    expect(routing.recentCommits[0]).toMatchObject({
      subject: 'fix(editor): asset panel',
      authorName: 'Editor Owner',
    });
  });
});
