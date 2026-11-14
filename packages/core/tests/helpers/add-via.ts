import type { Queue } from '../../src/queue/queue.js';

/** Add one job through the queue's pipeline. Returns the new job's id. */
export async function addVia(queue: Queue, data: unknown, opts: Record<string, unknown> = {}): Promise<string> {
  return (await queue.add(data, opts)).job.id;
}
