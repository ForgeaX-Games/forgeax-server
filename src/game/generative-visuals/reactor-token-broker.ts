import { Hono } from 'hono';
import {
  createGenerativeVisualAccessPolicy,
  type GenerativeVisualAccessPolicy,
} from './access-policy';

const DEFAULT_TOKEN_LIFETIME_SECONDS = 10 * 60;
const EXPIRY_SKEW_SECONDS = 30;
const DEFAULT_MAX_SESSIONS_PER_CLIENT = 2;

interface ReactorTokenResponse {
  jwt?: unknown;
  expires_at?: unknown;
}

interface Lease {
  readonly id: string;
  readonly expiresAtMs: number;
}

interface CachedToken {
  readonly jwt: string;
  readonly expiresAtMs: number;
}

export interface ReactorTokenBrokerOptions {
  readonly apiKey?: string;
  readonly coordinatorUrl?: string;
  readonly tokenLifetimeSeconds?: number;
  readonly maxSessionsPerClient?: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export interface ReactorTokenRouterOptions extends ReactorTokenBrokerOptions {
  readonly accessPolicy?: GenerativeVisualAccessPolicy;
}

function toBoundedPositiveInt(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}

function normalizeExpiresAtMs(raw: unknown, nowMs: number): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  // Reactor returns Unix seconds. Be tolerant of an eventual millisecond API.
  const milliseconds = raw < 10_000_000_000 ? raw * 1000 : raw;
  return milliseconds > nowMs ? milliseconds : undefined;
}

/**
 * Exchanges the server-only Reactor API key for a short-lived browser JWT.
 *
 * The cache is private to an Origin/client-address pair. A lease is counted once
 * until it expires or the adapter releases it, preventing accidental repeated
 * connect clicks from consuming an unbounded number of model sessions.
 */
export class ReactorTokenBroker {
  private readonly cache = new Map<string, CachedToken>();
  private readonly leases = new Map<string, Map<string, Lease>>();
  private readonly apiKey: string;
  private readonly coordinatorUrl: string;
  private readonly tokenLifetimeSeconds: number;
  private readonly maxSessionsPerClient: number;
  private readonly request: typeof fetch;
  private readonly now: () => number;

  constructor(options: ReactorTokenBrokerOptions = {}) {
    this.apiKey = (options.apiKey ?? process.env.REACTOR_API_KEY ?? '').trim();
    this.coordinatorUrl = (options.coordinatorUrl ?? process.env.REACTOR_COORDINATOR_URL ?? 'https://api.reactor.inc')
      .trim()
      .replace(/\/+$/, '');
    this.tokenLifetimeSeconds = toBoundedPositiveInt(
      options.tokenLifetimeSeconds,
      DEFAULT_TOKEN_LIFETIME_SECONDS,
      6 * 60 * 60,
    );
    this.maxSessionsPerClient = toBoundedPositiveInt(
      options.maxSessionsPerClient,
      DEFAULT_MAX_SESSIONS_PER_CLIENT,
      8,
    );
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  ready(): boolean {
    return this.apiKey.length > 0;
  }

  async issue(client: string, session: string): Promise<
    | { ok: true; jwt: string; expiresAtMs: number; leaseId: string; coordinatorUrl: string }
    | { ok: false; status: number; error: string }
  > {
    const nowMs = this.now();
    this.prune(nowMs);
    const existingLease = this.leases.get(client)?.get(session);
    const cached = this.cache.get(client);
    if (cached && existingLease && cached.expiresAtMs - nowMs > EXPIRY_SKEW_SECONDS * 1000) {
      return {
        ok: true,
        jwt: cached.jwt,
        expiresAtMs: cached.expiresAtMs,
        leaseId: existingLease.id,
        coordinatorUrl: this.coordinatorUrl,
      };
    }
    if (!this.ready()) {
      return { ok: false, status: 503, error: 'REACTOR_API_KEY is not configured' };
    }
    if (!existingLease && this.activeLeaseCount(client, nowMs) >= this.maxSessionsPerClient) {
      return { ok: false, status: 429, error: 'generative visual session limit reached' };
    }

    let token = cached;
    if (!token || token.expiresAtMs - nowMs <= EXPIRY_SKEW_SECONDS * 1000) {
      let response: Response;
      try {
        response = await this.request(`${this.coordinatorUrl}/tokens`, {
          method: 'POST',
          headers: {
            'Reactor-API-Key': this.apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ expires_after: this.tokenLifetimeSeconds }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        return { ok: false, status: 502, error: 'Reactor token service is unreachable' };
      }
      if (!response.ok) {
        return { ok: false, status: 502, error: `Reactor token request failed (${response.status})` };
      }

      const payload = await response.json().catch(() => ({})) as ReactorTokenResponse;
      if (typeof payload.jwt !== 'string' || payload.jwt.length === 0) {
        return { ok: false, status: 502, error: 'Reactor token response did not include a JWT' };
      }
      const expiresAtMs = normalizeExpiresAtMs(payload.expires_at, nowMs)
        ?? nowMs + this.tokenLifetimeSeconds * 1000;
      token = {
        jwt: payload.jwt,
        expiresAtMs,
      };
      this.cache.set(client, token);
    }
    const lease: Lease = existingLease ?? {
      id: crypto.randomUUID(),
      expiresAtMs: token.expiresAtMs,
    };
    const leases = this.leases.get(client) ?? new Map<string, Lease>();
    leases.set(session, lease);
    this.leases.set(client, leases);
    return {
      ok: true,
      jwt: token.jwt,
      expiresAtMs: token.expiresAtMs,
      leaseId: lease.id,
      coordinatorUrl: this.coordinatorUrl,
    };
  }

  release(client: string, leaseId: string): boolean {
    const leases = this.leases.get(client);
    if (!leases) return false;
    for (const [session, lease] of leases) {
      if (lease.id !== leaseId) continue;
      leases.delete(session);
      if (leases.size === 0) this.leases.delete(client);
      return true;
    }
    return false;
  }

  private activeLeaseCount(client: string, nowMs: number): number {
    const leases = this.leases.get(client);
    if (!leases) return 0;
    let active = 0;
    for (const lease of leases.values()) {
      if (lease.expiresAtMs > nowMs) active += 1;
    }
    return active;
  }

  private prune(nowMs: number): void {
    for (const [key, value] of this.cache) {
      if (value.expiresAtMs <= nowMs) this.cache.delete(key);
    }
    for (const [client, leases] of this.leases) {
      for (const [session, lease] of leases) {
        if (lease.expiresAtMs <= nowMs) leases.delete(session);
      }
      if (leases.size === 0) this.leases.delete(client);
    }
  }
}

export function createReactorTokenRouter(
  options: ReactorTokenRouterOptions = {},
): Hono {
  const { accessPolicy: configuredAccessPolicy, ...brokerOptions } = options;
  const broker = new ReactorTokenBroker(brokerOptions);
  const accessPolicy = configuredAccessPolicy ?? createGenerativeVisualAccessPolicy();
  const router = new Hono();

  router.get('/health', (c) => c.json({ ready: broker.ready() }));

  router.post('/tokens', async (c) => {
    const access = accessPolicy.authorize(c.req.raw);
    if (!access.ok) return c.json({ error: access.error }, access.status);
    const body = await c.req.json<{ session?: unknown }>()
      .catch((): { session?: unknown } => ({}));
    const session = typeof body.session === 'string' ? body.session.trim() : undefined;
    if (!session || session.length > 128 || !/^[A-Za-z0-9_-]+$/.test(session)) {
      return c.json({ error: 'valid visual session identifier required' }, 400);
    }
    const client = accessPolicy.clientKey(c.req.raw);
    const result = await broker.issue(client, session);
    if (!result.ok) return c.json({ error: result.error }, result.status as 400);

    const maxAge = Math.max(
      0,
      Math.floor((result.expiresAtMs - Date.now()) / 1000) - EXPIRY_SKEW_SECONDS,
    );
    return c.json(
      {
        jwt: result.jwt,
        expiresAt: Math.floor(result.expiresAtMs / 1000),
        leaseId: result.leaseId,
        coordinatorUrl: result.coordinatorUrl,
      },
      200,
      {
        'Cache-Control': `private, max-age=${maxAge}`,
        'Vary': 'Origin',
      },
    );
  });

  router.post('/leases/:leaseId/release', async (c) => {
    const access = accessPolicy.authorize(c.req.raw);
    if (!access.ok) return c.json({ error: access.error }, access.status);
    const client = accessPolicy.clientKey(c.req.raw);
    const released = broker.release(client, c.req.param('leaseId'));
    return c.json({ released });
  });

  return router;
}
