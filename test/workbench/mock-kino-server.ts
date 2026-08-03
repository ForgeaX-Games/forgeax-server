import { createHash } from 'node:crypto';

export interface MockKinoRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Headers;
  readonly body: unknown;
}

interface MockJob {
  readonly id: string;
  readonly gameId: string;
  readonly outputUrl: string;
  reads: number;
}

/**
 * Deterministic, no-charge Kino transport used by cross-host acceptance tests.
 * It deliberately implements the same create/poll/upload/output surfaces that
 * the production service binding is allowed to reach.
 */
export class MockKinoServer {
  readonly origin = 'https://kino.mock.local';
  readonly gatewayToken = 'mock-kino-service-token';
  readonly requests: MockKinoRequest[] = [];
  readonly #jobs = new Map<string, MockJob>();
  #nextGeneration = 1;
  #removedOutputs = new Set<string>();

  get generationRequests(): MockKinoRequest[] {
    return this.requests.filter((request) => request.method === 'POST' && request.path === '/api/v1/kino/generations');
  }

  removeOutputUrls(): void {
    for (const job of this.#jobs.values()) this.#removedOutputs.add(job.outputUrl);
  }

  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const request = new Request(input as any, init);
    const url = new URL(request.url);
    const rawBody = await request.arrayBuffer();
    let body: unknown;
    if (rawBody.byteLength > 0 && request.headers.get('content-type')?.includes('json')) {
      body = JSON.parse(new TextDecoder().decode(rawBody));
    }
    this.requests.push({
      method: request.method,
      path: url.pathname,
      headers: new Headers(request.headers),
      body,
    });

    if (url.origin !== this.origin) {
      return new Response('not found', { status: 404 });
    }
    if (url.pathname.startsWith('/outputs/')) {
      if (this.#removedOutputs.has(url.toString())) return new Response('gone', { status: 404 });
      return new Response(new Uint8Array([0, 0, 0, 0, 102, 116, 121, 112]), {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': '8' },
      });
    }
    if (request.method === 'PUT' && url.pathname.startsWith('/cos/')) {
      return new Response(null, { status: 200 });
    }
    if (request.headers.get('x-gateway-token') !== this.gatewayToken) {
      return Response.json({ code: 401, message: 'invalid token' }, { status: 401 });
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/kino/image-assets/upload') {
      return Response.json({
        code: 0,
        data: {
          tmp_secret_id: 'mock-ak',
          tmp_secret_key: 'mock-sk',
          session_token: 'mock-session',
          bucket_url: `${this.origin}/cos`,
          object_key: `upload/${this.#nextGeneration}.png`,
          required_headers: {},
        },
      });
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/kino/generations') {
      const value = body as { game_id?: unknown } | undefined;
      const gameId = typeof value?.game_id === 'string' ? value.game_id : '';
      const id = `mock-generation-${this.#nextGeneration++}`;
      const outputUrl = `${this.origin}/outputs/${id}.mp4`;
      this.#jobs.set(id, { id, gameId, outputUrl, reads: 0 });
      return Response.json({
        code: 0,
        message: 'success',
        data: {
          generation_id: id,
          game_id: gameId,
          media_type: 'video',
          status: 'polling',
          created_at: 1785456000000,
          updated_at: 1785456000000,
        },
      });
    }
    const match = url.pathname.match(/^\/api\/v1\/kino\/generations\/([^/]+)$/u);
    if (request.method === 'GET' && match) {
      const job = this.#jobs.get(decodeURIComponent(match[1]!));
      if (!job) return Response.json({ code: 404, message: 'not found' }, { status: 404 });
      job.reads += 1;
      return Response.json({
        code: 0,
        data: {
          generation_id: job.id,
          game_id: job.gameId,
          media_type: 'video',
          status: job.reads === 1 ? 'polling' : 'succeeded',
          resource: { url: job.outputUrl },
          created_at: 1785456000000,
          updated_at: 1785456000000 + job.reads,
        },
      });
    }
    return new Response('not found', { status: 404 });
  }

  static idempotentAssetId(key: string): string {
    return `asset-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
  }
}
