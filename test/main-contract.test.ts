import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const mainSource = readFileSync(resolve(import.meta.dir, '../src/main.ts'), 'utf8');

test('main composes the runtime carrier without replacing the existing preview proxy', () => {
  expect(mainSource).toContain("import { createRuntimeCarrierSupervisor } from './runtime-carrier/supervisor';");
  expect(mainSource).toContain("import { mountRuntimeCarrierApi } from './runtime-carrier/api';");
  expect(mainSource).toContain('mountRuntimeCarrierApi(app, runtimeCarrierSupervisor);');
  expect(mainSource).toContain('resolveScope: () =>');
  expect(mainSource).toContain('await runtimeCarrierSupervisor.shutdown();');
  expect(mainSource).toContain("if (url.pathname === '/preview' || url.pathname.startsWith('/preview/'))");
  expect(mainSource).toContain("process.env.FORGEAX_ENGINE_PORT ?? '15173'");
  expect(mainSource).not.toContain('runtimeCarrierSupervisor.play');
  expect(mainSource).not.toContain('runtimeCarrierSupervisor.capture');
});
