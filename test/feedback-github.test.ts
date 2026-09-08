import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FeedbackReport } from '@forgeax/types/feedback';
import type { FeedbackArchive } from '../src/game/feedback/archive';
import type { FeedbackTriage } from '../src/game/feedback/triage';
import {
  FeedbackGitHubClient,
  resolveFeedbackGitHubConfig,
} from '../src/game/feedback/github';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The smallest triage that publishIssue accepts; these tests assert on issue claiming, not body shape. */
function minimalTriage(): FeedbackTriage {
  return {
    title: '[FB] broken',
    summary: 'broken',
    reproductionSteps: ['Open the panel'],
    expectedBehavior: 'It works.',
    actualBehavior: 'It does not.',
    observations: [],
    routing: {
      businessModule: 'Studio interface and feedback UI',
      repository: 'ForgeaX-Games/forgeax-interface',
      repositoryUrl: 'https://github.com/ForgeaX-Games/forgeax-interface',
      confidence: 'high',
      basis: ['The wording names the feedback panel.'],
      relevantPaths: [],
      recentCommits: [],
    },
    labels: ['bug'],
    source: 'fallback',
  };
}

describe('feedback GitHub delivery', () => {
  test('pushes feedback files to Forgeax-Data and embeds screenshots in the issue', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fx-feedback-github-test-'));
    roots.push(root);
    const partPath = join(root, 'archive.tar.gz');
    const manifestPath = join(root, 'manifest.json');
    writeFileSync(partPath, 'archive');
    writeFileSync(manifestPath, '{}');
    const archive: FeedbackArchive = {
      parts: [{ path: partPath, name: 'feedback-hash.tar.gz', bytes: 7, sha256: 'a'.repeat(64) }],
      manifestPath,
      manifest: {
        version: 1,
        format: 'forgeax-feedback-tar-gz',
        feedbackId: 'FB-260818-1',
        occurrence: 1,
        capturedAt: '2026-08-18T00:00:00.000Z',
        sourceRoot: '.forgeax',
        sourceEntries: 1,
        sourceBytes: 7,
        archiveBytes: 7,
        archiveSha256: 'a'.repeat(64),
        skippedSymlinks: [],
        skippedLargeFiles: [], skippedGitInternals: [], unredactableFiles: [],
        redactedFiles: [],
        parts: [{ name: 'feedback-hash.tar.gz', bytes: 7, sha256: 'a'.repeat(64) }],
      },
      cleanup() {},
    };
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const mockFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
      if (url.includes('/repos/ForgeaX-Games/forgeax-interface/commits/')) {
        return Response.json({ message: 'local commit is not pushed' }, { status: 422 });
      }
      if (url.includes('/search/commits?')) {
        return Response.json({ items: [
          { author: { login: 'ui-maintainer' } },
          { author: { login: 'ui-maintainer' } },
        ] });
      }
      if (url.includes('/search/issues')) return Response.json({ items: [] });
      if (url.endsWith('/repos/ForgeaX-Games/forgeax-issues/issues') && method === 'POST') {
        return Response.json({ number: 77, html_url: 'https://github.com/ForgeaX-Games/forgeax-issues/issues/77', state: 'open' });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    };
    let pushed: Parameters<typeof import('@forgeax/orchestrator').pushFilesToPath>[0] | undefined;
    const mockPush = async (params: Parameters<typeof import('@forgeax/orchestrator').pushFilesToPath>[0]) => {
      pushed = params;
      return { commit: 'b'.repeat(40), filesChanged: params.files.length, skipped: false, path: params.destinationPath };
    };
    const client = new FeedbackGitHubClient({
      issuesToken: 'test-token',
      dataToken: 'test-token',
      dataRepo: 'ForgeaX-Games/Forgeax-Data',
      issuesRepo: 'ForgeaX-Games/forgeax-issues',
    }, mockFetch as typeof fetch, mockPush);
    const report: FeedbackReport = {
      id: 'FB-260818-1', type: 'wrong', status: 'processing', source: 'manual', title: 'wrong',
      description: 'broken', screenshots: ['data:image/png;base64,aGVsbG8='], count: 1,
      createdAt: '2026-08-18T00:00:00.000Z', updatedAt: '2026-08-18T00:00:00.000Z',
    };
    const bundle = await client.uploadBundle(archive, report);
    const issue = await client.publishIssue(report, {
      title: '[FB] broken',
      summary: 'broken',
      reproductionSteps: ['Open the feedback | panel', 'Submit the report"]\nclick X callback'],
      expectedBehavior: 'The report is submitted once.',
      actualBehavior: 'The report is duplicated.',
      observations: ['Observed in the feedback panel.'],
      routing: {
        businessModule: 'Studio interface and feedback UI',
        repository: 'ForgeaX-Games/forgeax-interface',
        repositoryUrl: 'https://github.com/ForgeaX-Games/forgeax-interface',
        confidence: 'high',
        basis: ['The feedback wording names the feedback panel.'],
        relevantPaths: ['src/components/Feedback/FeedbackPanel.tsx'],
        recentCommits: [{
          repository: 'ForgeaX-Games/forgeax-interface',
          sha: 'c'.repeat(40),
          subject: 'feat(interface): feedback panel',
          authorName: 'UI Owner',
          authorEmail: 'ui-owner@example.com',
        }],
      },
      labels: ['bug'],
      source: 'fallback',
    }, bundle);

    expect(issue.number).toBe(77);
    expect(bundle.archiveAssets[0]?.url).toContain('feedback-hash.tar.gz');
    expect(bundle.screenshotUrls).toHaveLength(1);
    expect(pushed?.destinationPath).toBe('feedback/FB-260818-1/r1');
    expect(pushed?.files.map((file) => file.name)).toEqual([
      'feedback-hash.tar.gz',
      'manifest.json',
      'screenshot-1-2cf24dba5fb0.png',
    ]);
    // /search/issues answers 422 unless the query pins is:issue or
    // is:pull-request, and that used to abort the whole delivery.
    const dedupeSearch = calls.find((call) => call.url.includes('/search/issues'));
    expect(decodeURIComponent(dedupeSearch?.url ?? '')).toContain('is:issue');
    const createIssue = calls.find((call) => call.url.endsWith('/repos/ForgeaX-Games/forgeax-issues/issues'));
    const issueBody = JSON.parse(createIssue?.body ?? '{}').body as string;
    expect(createIssue?.body).toContain('forgeax-feedback-id:FB-260818-1');
    expect(issueBody).toContain('## Overview');
    expect(issueBody).toContain('| Business module | Studio interface and feedback UI |');
    expect(createIssue?.body).toContain('## Reproduction Path');
    expect(issueBody).toContain('```mermaid\nflowchart TD');
    expect(issueBody.match(/```mermaid/g)).toHaveLength(1);
    expect(issueBody).toContain('S1 --> S2');
    expect(issueBody).toContain('S2 --> OBS');
    expect(issueBody).not.toMatch(/^\s*click\s+\w+/m);
    expect(issueBody).toContain('| 1 | Open the feedback \\| panel |');
    expect(createIssue?.body).toContain('## Business Module');
    expect(createIssue?.body).toContain('ForgeaX-Games/forgeax-interface');
    expect(createIssue?.body).toContain('## Relevant Git History');
    expect(createIssue?.body).toContain('@ui-maintainer');
    expect(createIssue?.body).toContain('![Screenshot 1](');
    expect(createIssue?.body).not.toMatch(/- \[Screenshot 1\]\(/);
    expect(createIssue?.body).not.toContain('/releases/');
  });

  test('opens a new issue when the dedupe search only recalls other reports', async () => {
    // /search/issues tokenizes rather than matching substrings: searching for
    // `forgeax-feedback-id:FB-260828-2` really does recall issues whose marker is
    // `…-4` or `…-3`. Trusting items[0] adopted a stranger's issue and PATCHed our
    // title and body over it, so an unrelated report's Issue silently became ours.
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const mockFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
      if (url.includes('/search/issues')) {
        // Both recalled issues carry a real marker — just not ours.
        return Response.json({ items: [
          { number: 25, html_url: 'https://github.com/ForgeaX-Games/forgeax-issues/issues/25', state: 'open', body: '<!-- forgeax-feedback-id:FB-260828-4 -->\n## Summary' },
          { number: 28, html_url: 'https://github.com/ForgeaX-Games/forgeax-issues/issues/28', state: 'open', body: '<!-- forgeax-feedback-id:FB-260828-3 -->\n## Summary' },
        ] });
      }
      if (url.endsWith('/repos/ForgeaX-Games/forgeax-issues/issues') && method === 'POST') {
        return Response.json({ number: 90, html_url: 'https://github.com/ForgeaX-Games/forgeax-issues/issues/90', state: 'open' });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    };
    const client = new FeedbackGitHubClient({
      issuesToken: 'test-token',
      dataToken: 'test-token',
      dataRepo: 'ForgeaX-Games/Forgeax-Data',
      issuesRepo: 'ForgeaX-Games/forgeax-issues',
    }, mockFetch as typeof fetch, async () => { throw new Error('no push expected'); });

    const issue = await client.publishIssue(
      {
        id: 'FB-260828-2', type: 'wrong', status: 'processing', source: 'manual', title: 'wrong',
        count: 1, createdAt: '2026-08-28T00:00:00.000Z', updatedAt: '2026-08-28T00:00:00.000Z',
      },
      minimalTriage(),
      { archiveAssets: [], manifestUrl: 'https://example.com/manifest.json', screenshotUrls: [] },
    );

    // A brand new issue, not #25 or #28.
    expect(issue.number).toBe(90);
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
    const created = calls.find((call) => call.method === 'POST');
    expect(created?.body).toContain('forgeax-feedback-id:FB-260828-2');
  });

  test('adopts the recalled issue whose body carries this exact report marker', async () => {
    // The complement of the case above: exact-marker verification must not stop a
    // legitimate re-delivery from reusing its own issue.
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const mockFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
      if (url.includes('/search/issues')) {
        return Response.json({ items: [
          { number: 25, html_url: 'https://github.com/ForgeaX-Games/forgeax-issues/issues/25', state: 'open', body: '<!-- forgeax-feedback-id:FB-260828-4 -->' },
          { number: 31, html_url: 'https://github.com/ForgeaX-Games/forgeax-issues/issues/31', state: 'open', body: '<!-- forgeax-feedback-id:FB-260828-2 -->' },
        ] });
      }
      if (url.includes('/issues/31') && method === 'PATCH') {
        return Response.json({ number: 31, html_url: 'https://github.com/ForgeaX-Games/forgeax-issues/issues/31', state: 'open' });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    };
    const client = new FeedbackGitHubClient({
      issuesToken: 'test-token',
      dataToken: 'test-token',
      dataRepo: 'ForgeaX-Games/Forgeax-Data',
      issuesRepo: 'ForgeaX-Games/forgeax-issues',
    }, mockFetch as typeof fetch, async () => { throw new Error('no push expected'); });

    const issue = await client.publishIssue(
      {
        id: 'FB-260828-2', type: 'wrong', status: 'processing', source: 'manual', title: 'wrong',
        count: 1, createdAt: '2026-08-28T00:00:00.000Z', updatedAt: '2026-08-28T00:00:00.000Z',
      },
      minimalTriage(),
      { archiveAssets: [], manifestUrl: 'https://example.com/manifest.json', screenshotUrls: [] },
    );

    // Reuses its own issue rather than opening a duplicate — and never touches #25.
    expect(issue.number).toBe(31);
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
    expect(calls.some((call) => call.url.includes('/issues/25'))).toBe(false);
  });

  test('falls back to the built-in credentials and honours override precedence', () => {
    // No env: the product shell's built-in shared credentials keep delivery
    // working without any local configuration.
    const builtIn = resolveFeedbackGitHubConfig({} as NodeJS.ProcessEnv);
    expect(builtIn.dataRepo).toBe('ForgeaX-Games/Forgeax-Data');
    expect(builtIn.issuesRepo).toBe('ForgeaX-Games/forgeax-issues');
    expect(builtIn.issuesToken).toStartWith('github_pat_');
    expect(builtIn.dataToken).toStartWith('github_pat_');
    expect(builtIn.issuesToken).not.toBe(builtIn.dataToken);

    // An operator override wins over the built-in credential.
    expect(resolveFeedbackGitHubConfig({
      FORGEAX_FEEDBACK_GITHUB_TOKEN: 'feedback-token',
    } as NodeJS.ProcessEnv).issuesToken).toBe('feedback-token');
    expect(resolveFeedbackGitHubConfig({
      FORGEAX_FEEDBACK_GITHUB_TOKEN: 'feedback-token',
      FORGEAX_UPLOAD_GITHUB_TOKEN: 'upload-token',
    } as NodeJS.ProcessEnv).issuesToken).toBe('feedback-token');
    expect(resolveFeedbackGitHubConfig({
      FORGEAX_UPLOAD_GITHUB_TOKEN: 'upload-token',
    } as NodeJS.ProcessEnv).issuesToken).toBe('upload-token');

    // The data repo credential has its own override and inherits the shared ones.
    expect(resolveFeedbackGitHubConfig({
      FORGEAX_FEEDBACK_DATA_GITHUB_TOKEN: 'data-token',
      FORGEAX_FEEDBACK_GITHUB_TOKEN: 'feedback-token',
    } as NodeJS.ProcessEnv).dataToken).toBe('data-token');
    expect(resolveFeedbackGitHubConfig({
      FORGEAX_UPLOAD_GITHUB_TOKEN: 'upload-token',
    } as NodeJS.ProcessEnv).dataToken).toBe('upload-token');
  });
});
