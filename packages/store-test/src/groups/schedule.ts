import { registerScheduleFire } from './schedule-fire.js';
import { registerScheduleStore } from './schedule-store.js';
import type { ConformanceGroup } from './types.js';

export const scheduleGroup: ConformanceGroup = {
  name: 'schedule',
  mode: 'fake',
  register(t) {
    registerScheduleStore(t);
    registerScheduleFire(t);
  },
};
