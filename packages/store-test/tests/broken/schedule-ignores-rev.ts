import { MemoryStore, type PutScheduleRequest, type PutScheduleResult, type Scope } from '@sureq/core';
import { inject } from './inject.js';

// putSchedule overwrites a stored schedule whatever expectedRev says.
class ScheduleIgnoresRev extends MemoryStore {
  override async putSchedule(scope: Scope, req: PutScheduleRequest): Promise<PutScheduleResult> {
    const stored = req.expectedRev === null ? null : await this.getSchedule(scope, { key: req.schedule.key });
    return super.putSchedule(scope, stored ? { ...req, expectedRev: stored.rev } : req);
  }
}

export const scheduleIgnoresRev = inject(
  'scheduleIgnoresRev',
  ['putSchedule'],
  ['schedule-store: put with stale rev fails conflict and changes nothing'],
  ScheduleIgnoresRev,
);
