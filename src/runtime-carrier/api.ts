import type { Hono } from 'hono';
import type { RuntimeCarrierSupervisor } from './supervisor';
import type { RuntimeActionResult, RuntimeScope } from './types';

function project(result: RuntimeActionResult): ResponseInit & { body: unknown } {
  if (result.ok) return { status: 200, body: result };
  return { status: result.error.code === 'UNKNOWN_RUNTIME' ? 404 : 409, body: result };
}

export function mountRuntimeCarrierApi(app: Hono, supervisor: RuntimeCarrierSupervisor): void {
  app.post('/api/runtime-carrier/ensure', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { scope?: unknown };
    if (!isRuntimeScope(body.scope)) return c.json({ ok: false, action: 'ensure', error: {
      code: 'SCOPE_UNCONFIRMED', stage: 'ensure', retryable: false, hint: 'Provide projectId and gameId in scope.',
      message: 'The ensure scope is invalid.', at: new Date().toISOString(),
    } }, 400);
    const output = project(await supervisor.ensure(body.scope));
    return c.json(output.body, output.status as 200 | 404 | 409);
  });
  app.get('/api/runtime-carrier/status/:runtimeId', async (c) => {
    const output = project(await supervisor.status(c.req.param('runtimeId')));
    return c.json(output.body, output.status as 200 | 404 | 409);
  });
  app.post('/api/runtime-carrier/reveal/:runtimeId', async (c) => {
    const output = project(await supervisor.reveal(c.req.param('runtimeId')));
    return c.json(output.body, output.status as 200 | 404 | 409);
  });
  app.post('/api/runtime-carrier/stop/:runtimeId', async (c) => {
    const output = project(await supervisor.stop(c.req.param('runtimeId')));
    return c.json(output.body, output.status as 200 | 404 | 409);
  });
}

function isRuntimeScope(value: unknown): value is RuntimeScope {
  if (!value || typeof value !== 'object') return false;
  const scope = value as Record<string, unknown>;
  return typeof scope.projectId === 'string' && (typeof scope.gameId === 'string' || scope.gameId === null);
}
