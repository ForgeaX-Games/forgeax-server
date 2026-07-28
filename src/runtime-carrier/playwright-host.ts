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
        await page.goto(carrierUrl(baseUrl, input.runtimeId, actualScope, input.ownerToken), {
          waitUntil: 'domcontentloaded',
          timeout: timeoutMs,
        });
        if (input.signal.aborted) throw new Error('Carrier startup was cancelled.');
        await page.waitForFunction(() => {
          const latest = (globalThis as unknown as CarrierEventWindow).__forgeaxCarrierLatest;
          return (latest as { type?: unknown } | null)?.type === 'VAG_CARRIER_HANDSHAKE';
        }, { timeout: timeoutMs });
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

function carrierUrl(baseUrl: string, runtimeId: string, scope: RuntimeScope, ownerToken: string): string {
  const params = new URLSearchParams({
    game: scope.gameId ?? '_template',
    runtimeId,
    ownershipChallenge: ownerToken,
  });
  return `${baseUrl}/preview/?${params.toString()}`;
}

async function readObservation(page: Page | null, timeoutMs: number): Promise<CarrierHealthObservation | null> {
  if (!page || page.isClosed()) return null;
  const latest = await page.evaluate(() => (globalThis as unknown as CarrierEventWindow).__forgeaxCarrierLatest);
  const parsed = parseCarrierHealthMessage(latest);
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
