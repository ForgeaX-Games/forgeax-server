/** Product-owned feedback API. Local persistence is the acceptance boundary;
 * GitHub delivery runs asynchronously so network and model failures never lose
 * a user's submission. */

import { Hono } from 'hono';
import { FeedbackSubmit, FeedbackStatusUpdate } from '@forgeax/types/feedback';
import { FeedbackRepository } from './feedback/repository';

export interface FeedbackDeliveryQueue {
  enqueue(id: string): void;
  retryFailed?(): Promise<number>;
  syncStatus?(id: string): void;
  refreshStatuses?(): void;
}

export interface FeedbackRouterOptions {
  getProjectRoot: () => string;
  repository?: FeedbackRepository;
  delivery?: FeedbackDeliveryQueue;
}

export function createFeedbackRouter(options: FeedbackRouterOptions): Hono {
  const app = new Hono();
  const repository = options.repository ?? new FeedbackRepository(options.getProjectRoot);

  app.post('/', async (c) => {
    try {
      const submit = FeedbackSubmit.parse(await c.req.json());
      const result = await repository.submit(submit);
      options.delivery?.enqueue(result.report.id);
      return c.json({ ok: true, ...result }, result.merged ? 200 : 201);
    } catch (error) {
      return c.json({ ok: false, error: (error as Error).message }, 400);
    }
  });

  app.get('/', async (c) => {
    try {
      options.delivery?.refreshStatuses?.();
      const reports = await repository.list();
      return c.json({ ok: true, reports });
    } catch (error) {
      return c.json({ ok: false, error: (error as Error).message }, 500);
    }
  });

  app.post('/retry', async (c) => {
    try {
      const queued = await options.delivery?.retryFailed?.() ?? 0;
      return c.json({ ok: true, queued });
    } catch (error) {
      return c.json({ ok: false, error: (error as Error).message }, 500);
    }
  });

  app.patch('/:id/status', async (c) => {
    try {
      const { status } = FeedbackStatusUpdate.parse(await c.req.json());
      const id = c.req.param('id');
      const report = await repository.updateStatus(id, status);
      if (!report) return c.json({ ok: false, error: `feedback ${id} not found` }, 404);
      options.delivery?.syncStatus?.(id);
      return c.json({ ok: true, report });
    } catch (error) {
      return c.json({ ok: false, error: (error as Error).message }, 400);
    }
  });

  return app;
}
