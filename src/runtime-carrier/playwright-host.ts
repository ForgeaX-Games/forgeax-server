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
}

interface CarrierEventWindow {
  __forgeaxCarrierEvents?: unknown[];
  addEventListener: (type: string, listener: (event: { source: unknown; data: unknown }) => void) => void;
  focus: () => void;
}

const installCarrierEventBuffer = (): void => {
  const target = globalThis as unknown as CarrierEventWindow;
  target.__forgeaxCarrierEvents = [];
  target.addEventListener('message', (event) => {
    if (event.source === target) target.__forgeaxCarrierEvents?.push(event.data);
  });
};

export function createPlaywrightCarrierHost(options: PlaywrightCarrierHostOptions = {}): CarrierHost {
  const baseUrl = (options.baseUrl ?? process.env.FORGEAX_INTERFACE_ORIGIN ?? 'http://127.0.0.1:18920').replace(/\/$/, '');
  const timeoutMs = options.timeoutMs ?? 15_000;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let userDataDir: string | null = null;

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
        await context.addInitScript(installCarrierEventBuffer);
        await page.goto(carrierUrl(baseUrl, input.runtimeId, input.scope), {
          waitUntil: 'domcontentloaded',
          timeout: timeoutMs,
        });
        if (input.signal.aborted) throw new Error('Carrier startup was cancelled.');
        await page.waitForFunction(() => {
          const events = (globalThis as unknown as CarrierEventWindow).__forgeaxCarrierEvents ?? [];
          return events.some((event) => (event as { type?: unknown } | null)?.type === 'VAG_CARRIER_HANDSHAKE');
        }, { timeout: timeoutMs });
        const observation = await readObservation(page, timeoutMs);
        if (!observation) throw new Error('Managed page did not provide a valid carrier handshake.');
        return {
          ...toHostObservation(observation),
          reveal: async () => {
            if (!page || page.isClosed()) throw new Error('Managed carrier page is closed.');
            await page.bringToFront();
            await page.evaluate(() => (globalThis as unknown as CarrierEventWindow).focus());
          },
          stop: async () => { await closeHost(); },
          observe: async () => {
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
    context = null;
    page = null;
    if (activeContext) await activeContext.close().catch(() => undefined);
    const dir = userDataDir;
    userDataDir = null;
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function carrierUrl(baseUrl: string, runtimeId: string, scope: RuntimeScope): string {
  const params = new URLSearchParams({
    game: scope.gameId ?? '_template',
    runtimeId,
    projectId: scope.projectId,
  });
  return `${baseUrl}/preview/?${params.toString()}`;
}

async function readObservation(page: Page | null, timeoutMs: number): Promise<CarrierHealthObservation | null> {
  if (!page || page.isClosed()) return null;
  const events = await page.evaluate(() => (globalThis as unknown as CarrierEventWindow).__forgeaxCarrierEvents ?? []) as unknown[];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const parsed = parseCarrierHealthMessage(events[index]);
    if (parsed) return parsed;
  }
  await page.waitForTimeout(Math.min(100, timeoutMs));
  return null;
}

function unreachableObservation(): CarrierHostObservation {
  return { confirmedScope: null, liveness: 'unreachable', renderReadiness: 'unavailable' };
}

function toHostObservation(observation: CarrierHealthObservation): CarrierHostObservation {
  return {
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
