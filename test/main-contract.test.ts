import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const mainSource = readFileSync(resolve(import.meta.dir, '../src/main.ts'), 'utf8');

test('main composes the runtime carrier without replacing the existing preview proxy', () => {
  expect(mainSource).toContain("import { createRuntimeCarrierSupervisor } from './runtime-carrier/supervisor';");
  expect(mainSource).toContain("import { mountRuntimeCarrierApi } from './runtime-carrier/api';");
  expect(mainSource).toContain('mountRuntimeCarrierApi(app, runtimeCarrierSupervisor);');
  expect(mainSource).toContain('resolveScope: () =>');
  expect(mainSource).toContain('baseUrl: process.env.FORGEAX_SERVER_URL');
  expect(mainSource).toContain("process.env.FORGEAX_INTERFACE_PORT ?? '18920'");
  expect(mainSource).toContain('await runtimeCarrierSupervisor.shutdown();');
  expect(mainSource).toContain("if (url.pathname === '/preview' || url.pathname.startsWith('/preview/'))");
  expect(mainSource).toContain("process.env.FORGEAX_ENGINE_PORT ?? '15173'");
  expect(mainSource).not.toContain('runtimeCarrierSupervisor.play');
  expect(mainSource).not.toContain('runtimeCarrierSupervisor.capture');
  expect(mainSource).not.toContain('CarrierGameplayAdapter');
});

test('main prepares optional product composition before creating the app', () => {
  expect(mainSource).toContain(
    "import { activateServerModules, prepareServerModules } from './composition-host';",
  );
  expect(mainSource).not.toContain("from './extension/runtime';");
  expect(mainSource).not.toContain('@forgeax/extension-host');
  const hostCreation = mainSource.indexOf('await prepareServerModules({');
  const appCreation = mainSource.indexOf('await createForgeaxApp({');
  expect(hostCreation).toBeGreaterThanOrEqual(0);
  expect(appCreation).toBeGreaterThan(hostCreation);
  expect(mainSource.slice(appCreation, mainSource.indexOf('\n});', appCreation)))
    .toContain('...productComposition,');
  expect(mainSource).toContain("process.env.FORGEAX_STARTUP_PROFILE === 'desktop-prod' && process.env.FORGEAX_RESOURCE_ROOT");
  expect(mainSource.slice(appCreation, mainSource.indexOf('\n});', appCreation)))
    .toContain("resourceRoot: join(process.env.FORGEAX_RESOURCE_ROOT, 'server-runtime', 'orchestrator')");
});

test('main composes chat task-flow host tools without merge residue', () => {
  expect(mainSource).toContain('const studioHostCapabilities = await resolveStudioHostCapabilities();');
  expect(mainSource).toContain('const studioTools = studioHostTools(');
  expect(mainSource).toContain('{ dispatch: editorTransportCarrier.dispatch },');
  expect(mainSource).toContain('hostTools: studioTools,');
  expect(mainSource).toContain('hostTools: studioTools.map(({ name }) => name),');
  expect(mainSource).not.toContain('includeDevEditorRelayTools');
  const enabledStart = mainSource.indexOf('enabledBuiltinTools: [');
  expect(enabledStart).toBeGreaterThanOrEqual(0);
  const enabledEnd = mainSource.indexOf('],', enabledStart);
  const enabledBlock = mainSource.slice(enabledStart, enabledEnd + 2);
  for (const name of [
    'ask_user',
    'delegate_to_subagent',
    'list_subagents',
    'todo_write',
    'memory_search',
    'remember',
    'soul_create',
    'npc_wire',
    'ui_snapshot',
    'ui_invoke',
    'ui_screenshot',
  ]) {
    expect(enabledBlock).toContain(`'${name}',`);
  }
  expect(mainSource).not.toMatch(/^(?:<{7}|={7}|>{7})/m);
  expect(mainSource).not.toContain('gameplayAdapter');
});

test('main opts into the complete Studio builtin allowlist', () => {
  // Read the actual app options: a separate test-only enablement list hid the
  // product omission when Orchestrator made every builtin opt-in (issue #75).
  // Do not import main.ts: that starts services and reads local credentials.
  const source = ts.createSourceFile('main.ts', mainSource, ts.ScriptTarget.Latest, true);
  const appCalls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'createForgeaxApp') appCalls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(appCalls).toHaveLength(1);
  const options = appCalls[0]!.arguments[0];
  if (!options || !ts.isObjectLiteralExpression(options)) throw new Error('Expected literal app options');
  const property = options.properties.find((node): node is ts.PropertyAssignment =>
    ts.isPropertyAssignment(node)
    && ts.isIdentifier(node.name)
    && node.name.text === 'enabledBuiltinTools');
  if (!property || !ts.isArrayLiteralExpression(property.initializer)) {
    throw new Error('Expected an explicit product builtin allowlist');
  }
  // A later spread/property must not override the product policy we checked.
  const tail = options.properties.slice(options.properties.indexOf(property) + 1);
  expect(tail.some((node) => ts.isSpreadAssignment(node)
    || node.name?.getText(source) === 'enabledBuiltinTools')).toBe(false);
  const enabled = property.initializer.elements.map((element) => {
    if (!ts.isStringLiteral(element)) throw new Error('Expected literal builtin names');
    return element.text;
  });
  expect(enabled).toEqual([
    'ask_user',
    'delegate_to_subagent',
    'list_subagents',
    'todo_write',
    'memory_search',
    'remember',
    'soul_create',
    'npc_wire',
    'ui_snapshot',
    'ui_invoke',
    'ui_screenshot',
  ]);
});
