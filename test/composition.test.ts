import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import type { ServerCompositionContext, ServerModule } from '../src/composition';
import { ServerModuleRegistry } from '../src/composition-host';

function context(): ServerCompositionContext {
  return { app: new Hono() };
}

test('empty registry activation is a no-op', async () => {
  const registry = new ServerModuleRegistry();

  await expect(registry.activate(context())).resolves.toBeUndefined();
});

test('modules activate in registration order', async () => {
  const registry = new ServerModuleRegistry();
  const activations: string[] = [];

  registry.register({ activate: () => void activations.push('first') });
  registry.register({ activate: () => void activations.push('second') });

  await registry.activate(context());

  expect(activations).toEqual(['first', 'second']);
});

test('async modules finish before the next module activates', async () => {
  const registry = new ServerModuleRegistry();
  const activations: string[] = [];

  registry.register({
    activate: async () => {
      activations.push('first:start');
      await Promise.resolve();
      activations.push('first:end');
    },
  });
  registry.register({ activate: () => void activations.push('second') });

  await registry.activate(context());

  expect(activations).toEqual(['first:start', 'first:end', 'second']);
});

test('activation propagates the original registration error', async () => {
  const registry = new ServerModuleRegistry();
  const error = new Error('module registration failed');
  const module: ServerModule = {
    activate: () => {
      throw error;
    },
  };
  registry.register(module);

  await expect(registry.activate(context())).rejects.toBe(error);
});

test('activation propagates the original async registration error', async () => {
  const registry = new ServerModuleRegistry();
  const error = new Error('async module registration failed');
  registry.register({
    activate: async () => {
      await Promise.resolve();
      throw error;
    },
  });

  await expect(registry.activate(context())).rejects.toBe(error);
});

test('a module can add a route to a real Hono app', async () => {
  const registry = new ServerModuleRegistry();
  const compositionContext = context();

  registry.register({
    activate: ({ app }) => {
      app.get('/module-route', (c) => c.text('registered'));
    },
  });
  await registry.activate(compositionContext);

  const response = await compositionContext.app.request('/module-route');
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('registered');
});

test('register rejects after activation completes', async () => {
  const registry = new ServerModuleRegistry();
  await registry.activate(context());

  expect(() => registry.register({ activate: () => {} })).toThrow(
    'Cannot register server module after activation has started',
  );
});

test('repeated activation rejects after activation completes', async () => {
  const registry = new ServerModuleRegistry();
  await registry.activate(context());

  await expect(registry.activate(context())).rejects.toThrow(
    'Server modules have already been activated',
  );
});

test('concurrent activation rejects while the first activation is in progress', async () => {
  const registry = new ServerModuleRegistry();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  registry.register({
    activate: async () => {
      calls += 1;
      if (calls === 1) await gate;
    },
  });

  const firstActivation = registry.activate(context());
  await Promise.resolve();
  await expect(registry.activate(context())).rejects.toThrow(
    'Server module activation is already in progress',
  );
  release();
  await firstActivation;

  expect(calls).toBe(1);
});

test('failed activation cannot retry already-run modules', async () => {
  const registry = new ServerModuleRegistry();
  const error = new Error('activation failed');
  let successfulModuleCalls = 0;
  registry.register({ activate: () => void (successfulModuleCalls += 1) });
  registry.register({
    activate: () => {
      throw error;
    },
  });

  await expect(registry.activate(context())).rejects.toBe(error);
  await expect(registry.activate(context())).rejects.toThrow(
    'Server module activation previously failed',
  );
  expect(successfulModuleCalls).toBe(1);
});

test('package exports expose the server entry and public composition seam only', () => {
  expect(Bun.resolveSync('@forgeax/server', import.meta.dir)).toBe(
    resolve(import.meta.dir, '../src/main.ts'),
  );
  expect(Bun.resolveSync('@forgeax/server/composition', import.meta.dir)).toBe(
    resolve(import.meta.dir, '../src/composition.ts'),
  );
  expect(() =>
    Bun.resolveSync('@forgeax/server/composition-host', import.meta.dir),
  ).toThrow();
});

test('main activates modules after app creation and before product routes', () => {
  const source = readFileSync(resolve(import.meta.dir, '../src/main.ts'), 'utf8');
  const hostImport = source.match(
    /import \{ activateServerModules \} from '\.\/composition-host';/g,
  );
  const createStart = source.indexOf('const { app } = await createForgeaxApp({');
  const createEnd = source.indexOf('\n});', createStart);
  const activation = source.indexOf('await activateServerModules({ app });');
  const healthRoute = source.indexOf("app.get('/api/health'");

  expect(hostImport).toHaveLength(1);
  expect(createStart).toBeGreaterThanOrEqual(0);
  expect(createEnd).toBeGreaterThan(createStart);
  expect(activation).toBeGreaterThan(createEnd);
  expect(healthRoute).toBeGreaterThan(activation);
  expect(source.match(/await activateServerModules\(\{ app \}\);/g)).toHaveLength(1);
});

test('public composition wrapper registers a module without exposing host APIs', async () => {
  const packageRoot = resolve(import.meta.dir, '..');
  const script = `
    import * as composition from '@forgeax/server/composition';
    import { Hono } from 'hono';
    import { activateServerModules } from './src/composition-host.ts';

    const exported = Object.keys(composition);
    if (exported.length !== 1 || exported[0] !== 'registerServerModule') {
      throw new Error('unexpected public exports: ' + exported.join(','));
    }

    composition.registerServerModule({
      activate: ({ app }) => app.get('/module-level-seam', (c) => c.text('active')),
    });
    const app = new Hono();
    await activateServerModules({ app });
    const response = await app.request('/module-level-seam');
    if (response.status !== 200 || await response.text() !== 'active') {
      throw new Error('registered module did not activate');
    }
  `;
  const child = Bun.spawn([process.execPath, '-e', script], {
    cwd: packageRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);

  expect(exitCode, stderr).toBe(0);
});
