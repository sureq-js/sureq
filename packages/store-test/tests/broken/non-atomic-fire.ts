import { MemoryStore, type FireScheduleRequest, type FireScheduleResult, type Scope } from '@sureq/core';
import { inject, yieldToLoop } from './inject.js';

// Advances the schedule, yields, then inserts the job: a failed insert leaves a tick advanced with no job.
class NonAtomicFire extends MemoryStore {
  override async fireSchedule(scope: Scope, req: FireScheduleRequest): Promise<FireScheduleResult> {
    const rec = await this.getSchedule(scope, { key: req.key });
    const fires = rec !== null && req.mode === 'tick' && rec.rev === req.expectedRev && !rec.paused && rec.queuedTicks.length === 0
      && (rec.overlap === 'allow' || rec.lastJobId === null) && (await this.now()) >= rec.nextRunAt;
    if (!fires) return super.fireSchedule(scope, req);
    const { namespace: _n, queue: _q, rev: _r, createdAt: _c, updatedAt: _u, ...stored } = rec;
    const next = { ...stored, nextRunAt: req.nextRunAt!, lastFiredFor: rec.nextRunAt, lastJobId: req.job.id, runCount: rec.runCount + 1 };
    const put = await this.putSchedule(scope, { schedule: next, expectedRev: rec.rev });
    if (!put.ok) return { outcome: 'conflict' };
    await yieldToLoop();
    await this.add(scope, [req.job]);
    return { outcome: 'fired', jobId: req.job.id, schedule: put.schedule };
  }
}

export const nonAtomicFire = inject(
  'nonAtomicFire',
  ['fireSchedule'],
  ['schedule-fire: failed job insert leaves the schedule unchanged'],
  NonAtomicFire,
);
