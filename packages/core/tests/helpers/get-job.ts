import type { Queue } from '../../src/queue/queue.js';
import type { Job } from '../../src/job/job.js';

/** Read a job as the public API does. */
export const getJobVia = (queue: Queue, id: string): Promise<Job | null> => queue.getJob(id);
