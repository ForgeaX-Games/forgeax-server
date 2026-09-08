import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FeedbackArchive } from '../src/game/feedback/archive';
import { FeedbackDeliveryCoordinator } from '../src/game/feedback/delivery';
import type { FeedbackGitHubGateway } from '../src/game/feedback/github';
import { FeedbackRepository } from '../src/game/feedback/repository';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'fx-feedback-delivery-test-'));
  roots.push(root);
  return root;
}

async function waitForStatus(repository: FeedbackRepository, id: string, status: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await repository.get(id))?.delivery?.status === status) return;
    await Bun.sleep(10);
  }
  throw new Error(`feedback ${id} did not reach ${status}`);
}

describe('feedback delivery coordinator', () => {
  test('publishes a queued local report and records its remote mapping', async () => {
    const root = project();
    const repository = new FeedbackRepository(() => root);
    const submitted = await repository.submit({ type: 'wrong', source: 'manual', description: 'broken' });
    let cleaned = false;
    const archive = {
      parts: [{ path: '/tmp/a', name: 'a.tar.gz', bytes: 1, sha256: 'a'.repeat(64) }],
      manifestPath: '/tmp/manifest',
      manifest: {
        version: 1, format: 'forgeax-feedback-tar-gz', feedbackId: submitted.report.id, occurrence: 1,
        capturedAt: new Date().toISOString(), sourceRoot: '.forgeax', sourceEntries: 1, sourceBytes: 1,
        archiveBytes: 1, archiveSha256: 'a'.repeat(64), skippedSymlinks: [], skippedLargeFiles: [], skippedGitInternals: [], unredactableFiles: [], redactedFiles: [],
        parts: [{ name: 'a.tar.gz', bytes: 1, sha256: 'a'.repeat(64) }],
      },
      cleanup: () => { cleaned = true; },
    } satisfies FeedbackArchive;
    const bundle = {
      archiveAssets: [{ name: 'a.tar.gz', url: 'https://github.test/a', bytes: 1, sha256: 'a'.repeat(64) }],
      manifestUrl: 'https://github.test/manifest', screenshotUrls: [],
    };
    const gateway: FeedbackGitHubGateway = {
      uploadBundle: async () => bundle,
      publishIssue: async () => ({ number: 88, url: 'https://github.com/ForgeaX-Games/forgeax-issues/issues/88' }),
      updateIssueStatus: async () => undefined,
      readIssueStatus: async () => 'processing',
    };
    const coordinator = new FeedbackDeliveryCoordinator({
      repository,
      getProjectRoot: () => root,
      env: {},
      buildArchive: async () => archive,
      triage: async () => triageFixture(),
      createGitHubClient: () => gateway,
      retryDelayMs: 5,
    });
    coordinator.enqueue(submitted.report.id);
    await waitForStatus(repository, submitted.report.id, 'published');
    expect(await repository.get(submitted.report.id)).toMatchObject({
      delivery: { status: 'published', issueNumber: 88, attempts: 1 },
    });
    expect(cleaned).toBe(true);
  });

  test('re-enqueues failed reports after credentials become available', async () => {
    const root = project();
    const repository = new FeedbackRepository(() => root);
    const submitted = await repository.submit({ type: 'ui', source: 'manual', description: 'broken' });
    let configured = false;
    const gateway: FeedbackGitHubGateway = {
      uploadBundle: async () => ({
        archiveAssets: [{ name: 'a.enc', url: 'https://github.test/a', bytes: 1, sha256: 'a'.repeat(64) }],
        manifestUrl: 'https://github.test/manifest',
        screenshotUrls: [],
      }),
      publishIssue: async () => ({ number: 91, url: 'https://github.com/ForgeaX-Games/forgeax-issues/issues/91' }),
      updateIssueStatus: async () => undefined,
      readIssueStatus: async () => 'processing',
    };
    const coordinator = new FeedbackDeliveryCoordinator({
      repository,
      getProjectRoot: () => root,
      env: {},
      createGitHubClient: () => {
        if (!configured) throw new Error('GitHub feedback delivery is not configured');
        return gateway;
      },
      buildArchive: async () => ({
        parts: [{ path: '/tmp/a', name: 'a.enc', bytes: 1, sha256: 'a'.repeat(64) }],
        manifestPath: '/tmp/manifest',
        manifest: {
          version: 1, format: 'forgeax-feedback-tar-gz', feedbackId: submitted.report.id, occurrence: 1,
          capturedAt: new Date().toISOString(), sourceRoot: '.forgeax', sourceEntries: 1, sourceBytes: 1,
          archiveBytes: 1, archiveSha256: 'a'.repeat(64), skippedSymlinks: [], skippedLargeFiles: [], skippedGitInternals: [], unredactableFiles: [], redactedFiles: [],
          parts: [{ name: 'a.enc', bytes: 1, sha256: 'a'.repeat(64) }],
        },
        cleanup: () => undefined,
      }),
      triage: async () => triageFixture(),
    });

    coordinator.enqueue(submitted.report.id);
    await waitForStatus(repository, submitted.report.id, 'failed');
    configured = true;
    expect(await coordinator.retryFailed()).toBe(1);
    await waitForStatus(repository, submitted.report.id, 'published');
  });
});

function triageFixture() {
  return {
    title: 'broken',
    summary: 'broken',
    reproductionSteps: [],
    expectedBehavior: 'works',
    actualBehavior: 'broken',
    observations: [],
    routing: {
      businessModule: 'Studio server and feedback delivery',
      repository: 'ForgeaX-Games/forgeax-server',
      repositoryUrl: 'https://github.com/ForgeaX-Games/forgeax-server',
      confidence: 'high' as const,
      basis: [],
      relevantPaths: [],
      recentCommits: [],
    },
    labels: ['bug' as const],
    source: 'fallback' as const,
  };
}
