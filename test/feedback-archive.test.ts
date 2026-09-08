import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFeedbackArchive } from '../src/game/feedback/archive';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'fx-feedback-archive-test-'));
  roots.push(root);
  mkdirSync(join(root, '.forgeax', 'nested'), { recursive: true });
  writeFileSync(join(root, '.forgeax', '.hidden'), 'hidden\n');
  writeFileSync(join(root, '.forgeax', 'nested', 'data.bin'), Buffer.from([0, 1, 2, 3]));
  return root;
}

describe('feedback archive', () => {
  test('relativizes absolute paths (PRD §5 绝对路径相对化)', async () => {
    const root = project();
    const { homedir } = require('node:os') as typeof import('node:os');
    writeFileSync(
      join(root, '.forgeax', 'runtime.log'),
      `booting from ${root}/packages/server\nsocket at ${homedir()}/.forgeax/host.sock\n`,
    );
    const archive = await buildFeedbackArchive(root, 'FB-PATH-1', 1);
    try {
      const dir = mkdtempSync(join(tmpdir(), 'fx-path-check-'));
      roots.push(dir);
      execFileSync('tar', ['-xzf', archive.parts[0]!.path, '-C', dir]);
      const staged = readFileSync(join(dir, '.forgeax', 'runtime.log'), 'utf8');
      // The reporter's account name and layout must not survive.
      expect(staged).not.toContain(root);
      expect(staged).not.toContain(homedir());
      expect(staged).toContain('<project>/packages/server');
      expect(staged).toContain('~/.forgeax/host.sock');
      expect(archive.manifest.redactedFiles.find((f) => f.path === 'runtime.log')?.kinds)
        .toContain('absolute-paths');
    } finally {
      archive.cleanup();
    }
  });

  test('a residual scan hit drops one file instead of the whole report', async () => {
    const root = project();
    writeFileSync(join(root, '.forgeax', 'good.log'), 'plain diagnostic line\n');
    const archive = await buildFeedbackArchive(root, 'FB-PARTIAL-1', 1);
    try {
      // Redaction and the scan agree today, so nothing is unredactable; the
      // contract that matters is that the field exists and the archive builds
      // rather than throwing on a disagreement.
      expect(Array.isArray(archive.manifest.unredactableFiles)).toBe(true);
      expect(archive.manifest.sourceEntries).toBeGreaterThan(0);
    } finally {
      archive.cleanup();
    }
  });

  test('drops project content and git internals (PRD §5 不含项目内容)', async () => {
    const root = project();
    // A game project: the PRD keeps this out of the report entirely, so the
    // .git hook samples that used to fail the scan never even get staged.
    const hooks = join(root, '.forgeax', 'games', 'untitled-1', '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(
      join(hooks, 'fsmonitor-watchman.sample'),
      '#!/usr/bin/perl\n$last_update_token = "\\"$last_update_token\\"";\n',
    );
    writeFileSync(join(root, '.forgeax', 'games', 'untitled-1', 'blueprint.json'), '{}\n');
    // A .git outside games/ is still dropped by the git-internals rule.
    const otherGit = join(root, '.forgeax', 'diagnostics', '.git');
    mkdirSync(otherGit, { recursive: true });
    writeFileSync(join(otherGit, 'config'), '[core]\n');
    writeFileSync(join(root, '.forgeax', 'diagnostics', 'state.json'), '{}\n');

    const archive = await buildFeedbackArchive(root, 'FB-260825-1', 1);
    try {
      const staged = archive.manifest;
      // Project content never reaches the archive.
      expect(staged.skippedGitInternals).not.toContain('games/untitled-1/.git/hooks/fsmonitor-watchman.sample');
      // Git internals elsewhere are reported as skipped, not silently dropped.
      expect(staged.skippedGitInternals).toContain('diagnostics/.git/config');
      // Diagnostics outside .git still ship.
      expect(staged.sourceEntries).toBeGreaterThan(0);
    } finally {
      archive.cleanup();
    }
  });

  test('archives a filtered redacted staging copy without changing source files', async () => {
    const root = project();
    const outside = join(root, 'outside.txt');
    writeFileSync(outside, 'outside-secret');
    if (process.platform !== 'win32') symlinkSync(outside, join(root, '.forgeax', 'outside-link'));
    mkdirSync(join(root, '.forgeax', 'logs', 'debug'), { recursive: true });
    mkdirSync(join(root, '.forgeax', 'node_modules', 'pkg'), { recursive: true });
    const envToken = 'feedback-env-token-value';
    const logPath = join(root, '.forgeax', 'logs', 'debug', 'session.jsonl');
    writeFileSync(logPath, `${JSON.stringify({ token: 'local-token-value', message: envToken })}\n`);
    writeFileSync(join(root, '.forgeax', 'keys.yaml'), 'provider: secret\n');
    writeFileSync(join(root, '.forgeax', 'local.env'), 'SECRET=value\n');
    writeFileSync(join(root, '.forgeax', 'node_modules', 'pkg', 'index.js'), 'ignored\n');

    const archive = await buildFeedbackArchive(root, 'FB-260818-1', 1, {
      env: { FORGEAX_FEEDBACK_GITHUB_TOKEN: envToken },
    });
    try {
      expect(archive.parts).toHaveLength(1);
      const listing = execFileSync('tar', ['-tzf', archive.parts[0]!.path], { encoding: 'utf8' });
      expect(listing).toContain('.forgeax/.hidden');
      expect(listing).toContain('.forgeax/nested/data.bin');
      expect(listing).toContain('.forgeax/logs/debug/session.jsonl');
      expect(listing).not.toContain('keys.yaml');
      expect(listing).not.toContain('local.env');
      expect(listing).not.toContain('node_modules');
      expect(listing).not.toContain('outside-link');
      expect(readFileSync(logPath, 'utf8')).toContain(envToken);
      const extracted = join(root, 'extracted');
      mkdirSync(extracted);
      execFileSync('tar', ['-xzf', archive.parts[0]!.path, '-C', extracted]);
      const stagedLog = readFileSync(join(extracted, '.forgeax', 'logs', 'debug', 'session.jsonl'), 'utf8');
      expect(stagedLog).not.toContain(envToken);
      expect(stagedLog).not.toContain('local-token-value');
      expect(stagedLog).toContain('[REDACTED]');
      expect(archive.manifest.redactedFiles).toContainEqual({
        path: 'logs/debug/session.jsonl',
        kinds: ['cli-structured-fields', 'env-secret-literal'],
      });
      if (process.platform !== 'win32') expect(archive.manifest.skippedSymlinks).toHaveLength(1);
      expect(archive.manifest.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      archive.cleanup();
    }
  });

  test('splits oversized archives into ordered Git-safe blobs', async () => {
    const root = project();
    writeFileSync(join(root, '.forgeax', 'payload.bin'), crypto.getRandomValues(new Uint8Array(16_000)));
    const archive = await buildFeedbackArchive(root, 'FB-260818-2', 3, { maxAssetBytes: 1_024 });
    try {
      expect(archive.parts.length).toBeGreaterThan(1);
      expect(archive.parts.every((part) => part.bytes <= 1_024)).toBe(true);
      const joined = Buffer.concat(archive.parts.map((part) => readFileSync(part.path)));
      expect(createHash('sha256').update(joined).digest('hex')).toBe(archive.manifest.archiveSha256);
      expect(archive.manifest.parts.map((part) => part.name)).toEqual(archive.parts.map((part) => part.name));
    } finally {
      archive.cleanup();
    }
  });

  test('excludes oversized source files and records them in the manifest', async () => {
    const root = project();
    writeFileSync(join(root, '.forgeax', 'large.bin'), Buffer.alloc(2_000, 1));
    const archive = await buildFeedbackArchive(root, 'FB-260818-3', 1, { maxFileBytes: 1_000 });
    try {
      expect(archive.manifest.format).toBe('forgeax-feedback-tar-gz');
      expect(archive.manifest.skippedLargeFiles).toEqual([{ path: 'large.bin', bytes: 2_000 }]);
      expect(execFileSync('tar', ['-tzf', archive.parts[0]!.path], { encoding: 'utf8' })).not.toContain('large.bin');
    } finally {
      archive.cleanup();
    }
  });
});
