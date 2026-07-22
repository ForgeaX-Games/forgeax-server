import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { KinoApiError } from '../../src/video-assets/kino-api';
import {
  VIDEO_ASSET_GAME_SLUG_RE,
  resolveGameDir,
  resolveVideoAssetsDir,
} from '../../src/video-assets/game-path';

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'video-assets-game-path-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function makeGameDir(slug: string, root = projectRoot): string {
  const dir = resolve(root, '.forgeax/games', slug);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('VIDEO_ASSET_GAME_SLUG_RE', () => {
  test('accepts canonical slugs', () => {
    expect(VIDEO_ASSET_GAME_SLUG_RE.test('alpha')).toBe(true);
    expect(VIDEO_ASSET_GAME_SLUG_RE.test('game-1')).toBe(true);
    expect(VIDEO_ASSET_GAME_SLUG_RE.test('a' + 'b'.repeat(40))).toBe(true);
  });

  test('rejects invalid slugs', () => {
    expect(VIDEO_ASSET_GAME_SLUG_RE.test('')).toBe(false);
    expect(VIDEO_ASSET_GAME_SLUG_RE.test('Bad')).toBe(false);
    expect(VIDEO_ASSET_GAME_SLUG_RE.test('-bad')).toBe(false);
    expect(VIDEO_ASSET_GAME_SLUG_RE.test('a'.repeat(42))).toBe(false);
  });
});

describe('resolveGameDir', () => {
  test('resolves an existing game directory', () => {
    const slug = 'alpha';
    const expected = makeGameDir(slug);
    expect(resolveGameDir(slug, () => projectRoot)).toBe(expected);
  });

  test('rejects invalid slug with 400', () => {
    try {
      resolveGameDir('Bad Slug!', () => projectRoot);
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(KinoApiError);
      expect((error as KinoApiError).status).toBe(400);
      expect((error as KinoApiError).errorCode).toBe('invalid_game_id');
    }
  });

  test('rejects missing game with 404', () => {
    try {
      resolveGameDir('missing', () => projectRoot);
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(KinoApiError);
      expect((error as KinoApiError).status).toBe(404);
      expect((error as KinoApiError).errorCode).toBe('game_not_found');
    }
  });

  test('accepts a valid directory symlink even outside project root', () => {
    const external = mkdtempSync(join(tmpdir(), 'video-assets-external-'));
    try {
      const linkPath = resolve(projectRoot, '.forgeax/games', 'linked');
      mkdirSync(resolve(projectRoot, '.forgeax/games'), { recursive: true });
      symlinkSync(external, linkPath);
      expect(resolveGameDir('linked', () => projectRoot)).toBe(linkPath);
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });

  test('rejects a dangling symlink with 404', () => {
    const linkPath = resolve(projectRoot, '.forgeax/games', 'gone');
    mkdirSync(resolve(projectRoot, '.forgeax/games'), { recursive: true });
    symlinkSync(resolve(projectRoot, 'nowhere'), linkPath);
    try {
      resolveGameDir('gone', () => projectRoot);
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(KinoApiError);
      expect((error as KinoApiError).status).toBe(404);
      expect((error as KinoApiError).errorCode).toBe('game_not_found');
    }
  });

  test('calls the injected root resolver for every request', () => {
    const otherRoot = mkdtempSync(join(tmpdir(), 'video-assets-game-path-other-'));
    try {
      const first = makeGameDir('demo');
      const second = makeGameDir('demo', otherRoot);
      let currentRoot = projectRoot;
      const getProjectRoot = () => currentRoot;

      expect(resolveGameDir('demo', getProjectRoot)).toBe(first);
      currentRoot = otherRoot;
      expect(resolveGameDir('demo', getProjectRoot)).toBe(second);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});

describe('resolveVideoAssetsDir', () => {
  test('resolves game-video/assets under the game directory', () => {
    const slug = 'demo';
    const gameDir = makeGameDir(slug);
    expect(resolveVideoAssetsDir(slug, () => projectRoot)).toBe(
      resolve(gameDir, 'game-video', 'assets'),
    );
  });
});
