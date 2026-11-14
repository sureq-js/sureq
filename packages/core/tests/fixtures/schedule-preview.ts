// The README "Schedule timing" sample, verbatim between the markers (checked by tests/unit/readme.test.ts)
// and type-checked with the package.
import { Queue } from '@sureq/core'

const queue = new Queue('reports')
// --- snippet start
await queue.previewSchedule({ cron: '30 2 * * 1-5', tz: 'Europe/Berlin' });  // next 5 fire times, epoch ms
await queue.previewSchedule({ every: '15m' }, 3);                            // 3 ticks of a grid anchored at store now
// --- snippet end
await queue.close()
