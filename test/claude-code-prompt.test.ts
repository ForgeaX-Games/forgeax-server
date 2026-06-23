import { describe, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { $ } from 'bun';

// t4c — prompt three-example tsc test (red->green TDD)
//
// Extracts the three ECS recipe examples from FORGEAX_SYSTEM_PROMPT
// in claude-code.ts, writes each to a separate temp .ts file, and
// runs `tsc --noEmit` to verify type correctness.
//
// RED phase (current THREE.js prompt): expect tsc errors.
// GREEN phase (after t4d rewrites to ECS): expect exit 0 for all 3.

const WORKTREE_ROOT = resolve(import.meta.dir, '..', '..', '..');
const ENGINE_PKGS = join(WORKTREE_ROOT, 'packages', 'engine', 'packages');

function engineDtsPath(pkg: string): string {
  return join(ENGINE_PKGS, pkg, 'dist', 'index.d.ts');
}

function findTsc(): string {
  const tsVersions = join(WORKTREE_ROOT, 'node_modules', '.bun');
  try {
    const { readdirSync } = require('node:fs');
    for (const entry of readdirSync(tsVersions)) {
      if (entry.startsWith('typescript@')) {
        const candidate = join(tsVersions, entry, 'node_modules', '.bin', 'tsc');
        try { require('node:fs').accessSync(candidate); return candidate; } catch { /* continue */ }
      }
    }
  } catch { /* .bun dir not found */ }
  return join(ENGINE_PKGS, '..', 'node_modules', '.bin', 'tsc');
}

// Extract the FORGEAX_SYSTEM_PROMPT string from claude-code.ts.
function extractPrompt(): string {
  const claudeCodePath = resolve(
    import.meta.dir, '..', 'src', 'cli-providers', 'providers', 'claude-code.ts',
  );
  const raw = require('node:fs').readFileSync(claudeCodePath, 'utf-8');

  const marker = 'const FORGEAX_SYSTEM_PROMPT = `';
  const startIdx = raw.indexOf(marker);
  if (startIdx === -1) throw new Error('prompt marker not found');

  const contentStart = startIdx + marker.length;
  let endIdx = contentStart;
  for (let i = contentStart; i < raw.length; i++) {
    // Find unescaped closing backtick (not preceded by backslash)
    if (raw[i] === '`' && (i === contentStart || raw[i - 1] !== '\\')) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === contentStart) throw new Error('prompt closing backtick not found');
  return raw.slice(contentStart, endIdx);
}

// Extract the three ECS recipe code blocks from the prompt.
// Inside a JS template literal, backticks are escaped as \`.
// The raw string thus has \`\`\`ts ... \`\`\` sequences.
function extractExamples(prompt: string): string[] {
  const examples: string[] = [];
  // Match escaped triple-backtick code blocks.
  // In the raw string: \`\`\`ts<NL> ... <NL>\`\`\`
  // We split on the pattern: backslash-backtick-backslash-backtick-backslash-backtick-ts
  const re = /\\`\\`\\`ts\r?\n([\s\S]*?)\\`\\`\\`/g;
  let match;
  while ((match = re.exec(prompt)) !== null) {
    const code = match[1]!.trim();
    // Skip the intro contract skeleton (partial example) and the
    // error-help exhaustive switch block (not a standalone recipe).
    if (code.length === 0) continue;
    if (code.startsWith('import { World }')) continue; // intro skeleton
    if (code.startsWith('// Exhaustive error')) continue; // error-help block
    examples.push(code);
  }
  return examples;
}

// Create a temp tsconfig for checking the examples
function writeTempTsconfig(dir: string): void {
  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      isolatedModules: true,
      baseUrl: './',
      paths: {
        '@forgeax/engine-runtime': [engineDtsPath('runtime')],
        '@forgeax/engine-ecs': [engineDtsPath('ecs')],
        '@forgeax/engine-types': [engineDtsPath('types')],
      },
    },
    include: ['*.ts'],
  };
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2), 'utf-8');
}

describe('claude-code FORGEAX_SYSTEM_PROMPT — three examples tsc --noEmit', () => {
  test('three ECS recipe examples each pass tsc --noEmit (AC-06)', async () => {
    const prompt = extractPrompt();
    const examples = extractExamples(prompt);

    // AC-06: must have at least 3 examples
    if (examples.length < 3) {
      console.log(`[t4c RED] Found ${examples.length} examples (need >= 3). Prompt preview:\n${prompt.slice(0, 500)}`);
    }
    expect(examples.length).toBeGreaterThanOrEqual(3);

    const tscBin = findTsc();
    let allPassed = true;
    const results: string[] = [];

    for (let i = 0; i < examples.length; i++) {
      const tmpDir = mkdtempSync(join(tmpdir(), `forgeax-prompt-example-${i}-`));
      const fileName = `example-${i}.ts`;
      writeFileSync(join(tmpDir, fileName), examples[i]!, 'utf-8');
      writeTempTsconfig(tmpDir);

      let result;
      try {
        result = await $`${tscBin} --noEmit --project ${tmpDir} 2>&1`.quiet().nothrow();
      } catch {
        result = { exitCode: 1, stderr: 'tsc invocation failed', stdout: '' };
      }

      const exitCode = result?.exitCode ?? 1;
      const output = (result?.stderr?.toString() ?? '') + (result?.stdout?.toString() ?? '');

      if (exitCode !== 0) {
        allPassed = false;
        results.push(`Example ${i} FAILED (exit ${exitCode}):\n${output.slice(0, 1000)}`);
      } else {
        results.push(`Example ${i} PASSED`);
      }

      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
    }

    if (!allPassed) {
      console.log('[t4c RED] Some examples failed:\n' + results.join('\n'));
    }

    expect(allPassed).toBe(true);
  });
});