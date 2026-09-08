import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(import.meta.dir, '../src/game/product-api.ts'), 'utf8');

describe('Brand-backed product agent API contract', () => {
  test('has no Marketplace manifest runtime fallback', () => {
    expect(source).toContain('loadBrand');
    expect(source).toContain('config.assistant.agent.id');
    expect(source).not.toContain('findMarketplaceManifest');
    expect(source).not.toContain('MarketplaceAgent');
    expect(source).not.toContain('marketplace/manifest.json');
  });
});
