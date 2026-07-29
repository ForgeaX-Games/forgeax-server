import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { parseCarrierHealthMessage, type CarrierHealthObservation } from './health';
import type {
  CarrierHost,
  CarrierHostHandle,
  CarrierHostObservation,
  CarrierHostStartInput,
  CarrierGameplayTransport,
  RuntimeScope,
} from './types';

export interface PlaywrightCarrierHostOptions {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly executablePath?: string;
  readonly resolveScope?: () => RuntimeScope | Promise<RuntimeScope>;
}

interface CarrierEventWindow {
  __forgeaxCarrierLatest?: unknown;
  __forgeax_carrier_health?: unknown;
  addEventListener: (type: string, listener: (event: { source: unknown; data: unknown }) => void) => void;
  focus: () => void;
}

const installCarrierEventBuffer = (): void => {
  const target = globalThis as unknown as CarrierEventWindow;
  target.__forgeaxCarrierLatest = undefined;
  target.addEventListener('message', (event) => {
    if (event.source === target) target.__forgeaxCarrierLatest = event.data;
  });
};

export function createPlaywrightCarrierHost(options: PlaywrightCarrierHostOptions = {}): CarrierHost {
  const baseUrl = (options.baseUrl ?? process.env.FORGEAX_INTERFACE_ORIGIN ?? 'http://127.0.0.1:18920').replace(/\/$/, '');
  const timeoutMs = options.timeoutMs ?? 15_000;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let userDataDir: string | null = null;
  let navigationCount = 0;
  let initialNavigationCount = 0;

  return {
    supportsReveal: true,
    async start(input: CarrierHostStartInput): Promise<CarrierHostHandle> {
      try {
        const { chromium } = await import('playwright');
        userDataDir = await mkdtemp(join(tmpdir(), 'forgeax-runtime-carrier-'));
        context = await chromium.launchPersistentContext(userDataDir, {
          headless: false,
          executablePath: options.executablePath,
          viewport: { width: 1280, height: 720 },
          args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
        });
        page = context.pages()[0] ?? await context.newPage();
        page.on('framenavigated', (frame) => {
          if (frame === page?.mainFrame()) navigationCount++;
        });
        await context.addInitScript(installCarrierEventBuffer);
        const actualScope = options.resolveScope ? await options.resolveScope() : input.scope;
        // A managed carrier must mount the Studio editor viewport immediately;
        // a fresh persistent profile would otherwise stop at onboarding before
        // the in-process ViewportComponent can publish its carrier handshake.
        await context.addInitScript((scope) => {
          const storage = (globalThis as unknown as { localStorage: { setItem: (key: string, value: string) => void } }).localStorage;
          storage.setItem('forgeax.onboarding.v2', JSON.stringify({ v: 2, phase: 'done', done: { tour: true, firstChat: true } }));
          if (scope.gameId) storage.setItem('forgeax.pinnedSlug', scope.gameId);
        }, actualScope);
        await page.goto(carrierUrl(baseUrl, input.runtimeId, actualScope, input.ownerToken), {
          waitUntil: 'domcontentloaded',
          timeout: timeoutMs,
        });
        if (input.signal.aborted) throw new Error('Carrier startup was cancelled.');
        await page.waitForFunction((expectedRuntimeId) => {
          const latest = (globalThis as unknown as CarrierEventWindow).__forgeaxCarrierLatest;
          const health = (globalThis as unknown as CarrierEventWindow).__forgeax_carrier_health as { runtimeId?: unknown } | undefined;
          return (latest as { type?: unknown } | null)?.type === 'VAG_CARRIER_HANDSHAKE' || health?.runtimeId === expectedRuntimeId;
        }, input.runtimeId, { timeout: timeoutMs });
        const observation = await readObservation(page, timeoutMs);
        if (!observation) throw new Error('Managed page did not provide a valid carrier handshake.');
        initialNavigationCount = navigationCount;
        return {
          runtimeId: observation.runtimeId,
          challengeResponse: observation.challengeResponse,
          ...toHostObservation(observation),
          reveal: async () => {
            if (!page || page.isClosed()) throw new Error('Managed carrier page is closed.');
            await page.bringToFront();
            await page.evaluate(() => (globalThis as unknown as CarrierEventWindow).focus());
          },
          gameplay: createGameplayTransport(() => page, observation.canvasIdentity),
          stop: async () => { await closeHost(); },
          observe: async () => {
            if (navigationCount > initialNavigationCount) {
              return {
                runtimeId: input.runtimeId,
                challengeResponse: input.ownerToken,
                confirmedScope: null,
                liveness: 'terminated',
                renderReadiness: 'unavailable',
                pageNonce: `reloaded-${navigationCount}`,
                pageIdentity: page?.url() ?? 'unknown',
                canvasIdentity: 'reloaded',
                rendererIdentity: 'reloaded',
                lastFailure: {
                  code: 'PAGE_RELOADED',
                  stage: 'status',
                  retryable: true,
                  hint: 'Stop the old runtime and ensure again to establish a new page identity.',
                  at: new Date().toISOString(),
                  message: 'The managed carrier page was reloaded.',
                  runtimeId: input.runtimeId,
                },
              };
            }
            const next = await readObservation(page, timeoutMs);
            return next ? toHostObservation(next) : unreachableObservation();
          },
        };
      } catch (error) {
        await closeHost();
        throw error;
      }
    },
  };

  async function closeHost(): Promise<void> {
    const activeContext = context;
    if (activeContext) {
      await activeContext.close();
      context = null;
      page = null;
    }
    const dir = userDataDir;
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      userDataDir = null;
    }
  }
}

function createGameplayTransport(getPage: () => Page | null, expectedCanvasIdentity?: string): CarrierGameplayTransport {
  const withPage = (): Page => {
    const current = getPage();
    if (!current || current.isClosed()) throw new Error('Managed carrier page is closed.');
    return current;
  };

  return {
    async execute(operation: unknown): Promise<unknown> {
      const current = withPage();
      const result = await current.evaluate(async (payload) => {
        const root = globalThis as unknown as {
          __forgeax_editor?: {
            readActiveWorld?: () => unknown;
            dispatchGameplayInput?: (action: unknown) => unknown;
            gateway?: {
              mode?: string;
              playPhase?: string;
              dispatch?: (op: unknown, origin?: string) => { ok: boolean; error?: unknown };
              invokeGameAction?: (id: string, args: unknown) => Promise<unknown>;
              readGameState?: (query: string) => Promise<unknown>;
            };
            playSimulation?: () => unknown;
            stopSimulation?: () => unknown;
          };
        };
        if (!payload || typeof payload !== 'object' || typeof (payload as { operation?: unknown }).operation !== 'string') {
          return { ok: false, error: { code: 'operation-unsupported', hint: 'A typed gameplay operation is required.' } };
        }
        const op = payload as { operation: string; action?: unknown; query?: string };
        const editor = root.__forgeax_editor;
        const gateway = editor?.gateway;
        if (!editor || !gateway) return { ok: false, error: { code: 'surface-unavailable', hint: 'Editor Gateway is not booted.' } };
        if (op.operation === 'play') {
          if (gateway.mode !== 'play') await editor.playSimulation?.();
          return { ok: true, state: 'running' };
        }
        if (op.operation === 'gameplayStop') {
          if (gateway.mode === 'play') await editor.stopSimulation?.();
          return { ok: true, state: 'stopped' };
        }
        if (op.operation === 'input') {
          if (gateway.mode !== 'play') return { ok: false, error: { code: 'surface-unavailable', hint: 'input requires an active live Play projection' } };
          if (gateway.invokeGameAction) {
            const projected = await gateway.invokeGameAction('input', op.action);
            const projectedError = projected && typeof projected === 'object' && 'ok' in projected && (projected as { ok?: unknown }).ok === false
              ? (projected as { error?: { code?: unknown } }).error?.code : undefined;
            if (projectedError !== 'unknown-game-projection') return projected;
          }
          if (!editor.dispatchGameplayInput) return { ok: false, error: { code: 'surface-unavailable', hint: 'input surface is unavailable' } };
          return editor.dispatchGameplayInput(op.action);
        }
        if (op.operation === 'query') {
          if (gateway.mode !== 'play') return { ok: false, error: { code: 'surface-unavailable', hint: 'query requires an active live Play projection' } };
          if ((op.query ?? '').trim() === 'world' && editor.readActiveWorld) return { ok: true, value: editor.readActiveWorld() };
          if (!gateway.readGameState) return { ok: false, error: { code: 'surface-unavailable', hint: 'query requires an active live Play projection' } };
          return await gateway.readGameState((op.query ?? '').trim() || 'world');
        }
        return { ok: false, error: { code: 'operation-unsupported', hint: 'Use the capture or reveal transport for that operation.' } };
      }, operation);
      if (result && typeof result === 'object' && 'ok' in result && (result as { ok?: unknown }).ok === false) return result;
      if (operation && typeof operation === 'object' && (operation as { operation?: unknown }).operation === 'play') {
        await current.waitForFunction(() => (globalThis as unknown as { __forgeax_editor?: { gateway?: { mode?: string } } }).__forgeax_editor?.gateway?.mode === 'play', { timeout: 15_000 });
      } else if (operation && typeof operation === 'object' && (operation as { operation?: unknown }).operation === 'gameplayStop') {
        await current.waitForFunction(() => (globalThis as unknown as { __forgeax_editor?: { gateway?: { mode?: string } } }).__forgeax_editor?.gateway?.mode === 'edit', { timeout: 15_000 });
      }
      return result;
    },
    async capture(): Promise<{ dataUrl: string; bytes: number }> {
      const current = withPage();
      const result = await current.evaluate((canvasIdentity) => {
        const documentRef = (globalThis as unknown as { document?: { querySelectorAll: (selector: string) => ArrayLike<unknown> } }).document;
        const canvases = documentRef?.querySelectorAll('canvas') ?? [];
        const canvas = Array.from(canvases).find((candidate) => {
          const element = candidate as { dataset?: { forgeaxCarrierCanvas?: string } };
          return canvasIdentity === undefined || element.dataset?.forgeaxCarrierCanvas === canvasIdentity;
        }) as { isConnected?: boolean; toDataURL?: (type: string) => string } | undefined;
        if (!canvas || canvas.isConnected !== true || typeof canvas.toDataURL !== 'function') throw new Error('Live carrier canvas is unavailable.');
        const dataUrl = canvas.toDataURL('image/png');
        if (!dataUrl.startsWith('data:image/')) throw new Error('Live carrier canvas produced no readable artifact.');
        return { dataUrl, bytes: dataUrl.length };
      }, expectedCanvasIdentity);
      return result;
    },
    async focus(): Promise<void> {
      const current = withPage();
      await current.bringToFront();
      await current.evaluate((canvasIdentity) => {
        const documentRef = (globalThis as unknown as { document?: { querySelectorAll: (selector: string) => ArrayLike<unknown> } }).document;
        const canvases = documentRef?.querySelectorAll('canvas') ?? [];
        const canvas = Array.from(canvases).find((candidate) => {
          const element = candidate as { dataset?: { forgeaxCarrierCanvas?: string } };
          return canvasIdentity === undefined || element.dataset?.forgeaxCarrierCanvas === canvasIdentity;
        }) as { focus?: (options?: unknown) => void } | undefined;
        if (!canvas) throw new Error('Live carrier canvas identity is unavailable.');
        canvas?.focus?.({ preventScroll: true });
        (globalThis as unknown as CarrierEventWindow).focus();
      }, expectedCanvasIdentity);
    },
  };
}

function carrierUrl(baseUrl: string, runtimeId: string, scope: RuntimeScope, ownerToken: string): string {
  const params = new URLSearchParams({
    runtimeId,
    ownershipChallenge: ownerToken,
  });
  return `${baseUrl}/?${params.toString()}`;
}

async function readObservation(page: Page | null, timeoutMs: number): Promise<CarrierHealthObservation | null> {
  if (!page || page.isClosed()) return null;
  const latest = await page.evaluate(() => (globalThis as unknown as CarrierEventWindow).__forgeaxCarrierLatest);
  const producerHealth = await page.evaluate(() => (globalThis as unknown as CarrierEventWindow).__forgeax_carrier_health);
  const parsed = parseCarrierHealthMessage(latest) ?? parseCarrierHealthMessage(producerHealth);
  if (parsed) return parsed;
  await page.waitForTimeout(Math.min(100, timeoutMs));
  return null;
}

function unreachableObservation(): CarrierHostObservation {
  return { confirmedScope: null, liveness: 'unreachable', renderReadiness: 'unavailable' };
}

function toHostObservation(observation: CarrierHealthObservation): CarrierHostObservation {
  return {
    runtimeId: observation.runtimeId,
    challengeResponse: observation.challengeResponse,
    confirmedScope: observation.confirmedScope,
    liveness: observation.liveness,
    renderReadiness: observation.renderReadiness,
    pageNonce: observation.pageNonce,
    pageIdentity: observation.pageIdentity,
    canvasIdentity: observation.canvasIdentity,
    rendererIdentity: observation.rendererIdentity,
    sentinel: observation.sentinel,
    at: observation.failure?.at,
    lastFailure: observation.failure ? {
      code: observation.failure.code,
      stage: observation.failure.stage,
      retryable: observation.failure.retryable,
      hint: observation.failure.hint,
      at: observation.failure.at,
      message: observation.failure.message ?? `Carrier reported ${observation.failure.code}.`,
      runtimeId: observation.runtimeId ?? undefined,
    } : null,
  };
}
