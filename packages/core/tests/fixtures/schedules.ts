// The README "Schedules" sample, verbatim between the markers (checked by tests/unit/readme.test.ts)
// and type-checked with the package.
import { Queue } from '@sureq/core'

const queue = new Queue<{ day: string }>('reports', { scheduler: { tickMs: 1000 } })
// --- snippet start
await queue.upsertSchedule('nightly-report', {
  cron: '0 2 * * *', tz: 'Europe/Berlin', version: 3,
  template: { name: 'report', data: { day: 'yesterday' }, opts: { maxAttempts: 5 } },
  overlap: 'queue', maxQueued: 3,
});
queue.on('scheduleFired', ({ key, scheduledFor, jobId }) => console.log(key, scheduledFor, jobId));
queue.process(async (job) => {
  if (job.schedule) console.log(`tick ${job.schedule.scheduledFor} of ${job.schedule.key}`);
});
// --- snippet end
await queue.close()
