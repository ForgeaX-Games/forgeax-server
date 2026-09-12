import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { studioActionCatalog, studioHeadlessCompatibilityIds } from '../src/studio-action-catalog';

test('Studio owns its product actions and does not advertise agent game switching', () => {
  const ids = new Set<string>(studioActionCatalog.map(entry => entry.id));
  expect(ids.size).toBe(studioActionCatalog.length);
  expect(ids.size).toBe(22);
  for (const id of ['game.create', 'role.open', 'console.read', 'session.switch']) expect(ids.has(id)).toBe(true);
  expect(ids.has('game.switch')).toBe(false);
  expect(studioActionCatalog.find(entry => entry.id === 'game.create')?.description.toLowerCase()).toContain('does not switch');
  expect(studioActionCatalog.find(entry => entry.id === 'sessions.list')?.description).toContain('game scope');
});

test('legacy headless gaps are explicit Studio debt and cannot contain undeclared actions', () => {
  expect(studioHeadlessCompatibilityIds).toEqual(['game.create', 'session.rename', 'sessions.refresh']);
  for (const id of studioHeadlessCompatibilityIds) {
    expect(studioActionCatalog.find(entry => entry.id === id)?.surface).toBe('both');
  }
});

test('normal Studio startup injects declarations and compatibility policy together', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  expect(main).toContain('actionCatalog: studioActionCatalog,');
  expect(main).toContain('headlessActionCompatibilityIds: studioHeadlessCompatibilityIds,');
});
