import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Hono } from 'hono';
import {
  resolveNpcModel,
  type NpcBudgetConfig,
} from '@forgeax/orchestrator/npc-brain/model-config';

export interface NpcBrainSettings {
  model?: string;
  fallback?: string[];
  budget?: NpcBudgetConfig;
}

export interface NpcSettingsRouterOptions {
  getProjectRoot: () => string;
}

function settingsPath(projectRoot: string): string {
  return join(projectRoot, '.forgeax', 'npc-brain.json');
}

function readObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid NPC Brain settings JSON: ${(error as Error).message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('NPC Brain settings must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function optionalLimit(value: unknown, key: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer`);
  }
  return value;
}

export function parseNpcBrainSettings(value: unknown): NpcBrainSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('NPC Brain settings body must be an object');
  }
  const input = value as Record<string, unknown>;
  const model = input.model === undefined || input.model === null
    ? undefined
    : typeof input.model === 'string' && input.model.trim()
      ? input.model.trim()
      : (() => { throw new Error('model must be a non-empty string'); })();
  let fallback: string[] | undefined;
  if (input.fallback !== undefined && input.fallback !== null) {
    if (!Array.isArray(input.fallback)) throw new Error('fallback must be a string array');
    fallback = input.fallback.map((entry, index) => {
      if (typeof entry !== 'string' || !entry.trim()) {
        throw new Error(`fallback[${index}] must be a non-empty string`);
      }
      return entry.trim();
    });
  }

  let budget: NpcBudgetConfig | undefined;
  if (input.budget !== undefined && input.budget !== null) {
    if (typeof input.budget !== 'object' || Array.isArray(input.budget)) {
      throw new Error('budget must be an object');
    }
    const raw = input.budget as Record<string, unknown>;
    if (raw.maxCostUsd !== undefined) {
      throw new Error('budget.maxCostUsd is unsupported; use calls/tokens limits');
    }
    budget = {
      ...(optionalLimit(raw.maxCallsPerMinute, 'budget.maxCallsPerMinute') === undefined
        ? {}
        : { maxCallsPerMinute: optionalLimit(raw.maxCallsPerMinute, 'budget.maxCallsPerMinute') }),
      ...(optionalLimit(raw.maxTokensPerMinute, 'budget.maxTokensPerMinute') === undefined
        ? {}
        : { maxTokensPerMinute: optionalLimit(raw.maxTokensPerMinute, 'budget.maxTokensPerMinute') }),
      ...(optionalLimit(raw.maxConcurrent, 'budget.maxConcurrent') === undefined
        ? {}
        : { maxConcurrent: optionalLimit(raw.maxConcurrent, 'budget.maxConcurrent') }),
    };
    if (Object.keys(budget).length === 0) budget = undefined;
  }
  return {
    ...(model ? { model } : {}),
    ...(fallback ? { fallback } : {}),
    ...(budget ? { budget } : {}),
  };
}

function readSettings(projectRoot: string): NpcBrainSettings {
  const raw = readObject(settingsPath(projectRoot));
  return parseNpcBrainSettings({
    model: raw.model,
    fallback: raw.fallback ?? raw.fallbackModels,
    budget: raw.budget,
  });
}

function writeSettings(projectRoot: string, settings: NpcBrainSettings): void {
  const path = settingsPath(projectRoot);
  const current = readObject(path);
  delete current.fallbackModels;
  for (const key of ['model', 'fallback', 'budget']) {
    if (settings[key as keyof NpcBrainSettings] === undefined) delete current[key];
  }
  Object.assign(current, settings);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function createNpcSettingsRouter(options: NpcSettingsRouterOptions): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    try {
      const projectRoot = options.getProjectRoot();
      const config = readSettings(projectRoot);
      const effective = resolveNpcModel({ projectRoot });
      return c.json({ ok: true, config, effective, path: '.forgeax/npc-brain.json' });
    } catch (error) {
      return c.json({ ok: false, error: (error as Error).message }, 500);
    }
  });

  app.put('/', async (c) => {
    try {
      const config = parseNpcBrainSettings(await c.req.json());
      const projectRoot = options.getProjectRoot();
      writeSettings(projectRoot, config);
      const effective = resolveNpcModel({ projectRoot });
      return c.json({ ok: true, config, effective, path: '.forgeax/npc-brain.json' });
    } catch (error) {
      return c.json({ ok: false, error: (error as Error).message }, 400);
    }
  });

  return app;
}
