import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { studioResidentResourcePolicy as policy } from '../src/desktop/resident-resource-policy';

const persona = 'resources/brand/defaults.forgeax/personas/forge.zh.md';
const skill = 'resources/product/node_modules/@forgeax-extension/skill-draw/SKILL.md';
const current = (resource: string) => `/Applications/ForgeaX Studio.app/Contents/Resources/${resource}`;

test('Studio explicitly selects snapshots only for product-owned sources', () => {
  expect(policy.persistence).toBe('snapshot');
  expect(policy.acceptsSource({ kind: 'brand' })).toBe(true);
  expect(policy.acceptsSource({ kind: 'plugin', origin: 'builtin' })).toBe(true);
  expect(policy.acceptsSource({ kind: 'plugin', origin: 'user' })).toBe(false);
  expect(policy.acceptsSource({ kind: 'plugin', origin: 'project' })).toBe(false);
});

test('old DMG and Translocation paths map by exact packaged identity', () => {
  for (const root of ['/Volumes/ForgeaX Studio 1/ForgeaX Studio.app', '/private/var/folders/t/T/AppTranslocation/id/d/ForgeaX Studio.app']) {
    for (const resource of [persona, skill]) {
      expect(policy.matchesLegacyPath(`${root}/Contents/Resources/${resource}`, current(resource))).toBe(true);
    }
  }
});

test('Windows drive and UNC paths retain the same package identity', () => {
  for (const root of ['C:\\Program Files\\ForgeaX', '\\\\server\\apps\\ForgeaX']) {
    const old = `${root}\\${skill.replaceAll('/', '\\')}`;
    expect(policy.matchesLegacyPath(old, current(skill))).toBe(true);
  }
});

test('unrelated resources, traversal, and relative paths cannot become migration candidates', () => {
  for (const path of [
    '/custom/personas/forge.zh.md',
    `relative/ForgeaX Studio.app/Contents/Resources/${persona}`,
    current(persona.replace('forge.zh.md', '../personas/forge.zh.md')),
    current(persona.replace('defaults.forgeax', 'defaults.other')),
    current(skill.replace('skill-draw', 'skill-other')),
  ]) expect(policy.matchesLegacyPath(path, current(persona))).toBe(false);
  expect(policy.matchesLegacyPath(current(skill.replace('skill-draw', 'skill-other')), current(skill))).toBe(false);
});

test('the real product startup injects its policy through the public app contract', () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  expect(source).toContain("from './desktop/resident-resource-policy'");
  expect(source).toContain('residentResourcePolicy: studioResidentResourcePolicy');
});
