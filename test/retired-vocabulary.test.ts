import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const roots = ['src', 'test', 'README.md', 'package.json', '.github'];
const retiredShellTerm = ['work', 'bench'].join('');
const retired = new RegExp(`${retiredShellTerm}|\\b(?:wb|wm)[-_]`, 'i');
const extensions = new Set(['.ts', '.tsx', '.js', '.json', '.md', '.yml', '.yaml']);

function filesUnder(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return filesUnder(child);
    return extensions.has(extname(entry.name)) ? [child] : [];
  });
}

describe('Server retired vocabulary gate', () => {
  it('keeps maintained routes, domain services, tests, and docs canonical', () => {
    const files = roots.flatMap((root) => (extname(root) ? [root] : filesUnder(root)));
    const violations = files.flatMap((file) =>
      readFileSync(file, 'utf8').split('\n').flatMap((line, index) =>
        retired.test(line) ? [`${relative(process.cwd(), file)}:${index + 1}: ${line.trim()}`] : [],
      ),
    );
    expect(violations).toEqual([]);
  });
});
