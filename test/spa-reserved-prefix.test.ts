import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const mainSource = readFileSync(resolve(import.meta.dir, '../src/main.ts'), 'utf8');
const literal = mainSource.match(/const RESERVED_PREFIX = (\/\^.*?\/);/)?.[1];

describe('SPA reserved path prefixes', () => {
  test('reserves the current extension asset namespace only', () => {
    expect(literal).toBeDefined();
    const reserved = Function(`return ${literal}`)() as RegExp;

    expect(reserved.test('/extensions/wb-reel/missing.js')).toBe(true);
    expect(reserved.test('/plugins/wb-reel/missing.js')).toBe(false);
  });
});
