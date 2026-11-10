import * as migration_20261110_103458_initial from './20261110_103458_initial';
import * as migration_20261110_105612_jobs from './20261110_105612_jobs';
import * as migration_20261110_105640_job_schedule from './20261110_105640_job_schedule';

export const migrations = [
  {
    up: migration_20261110_103458_initial.up,
    down: migration_20261110_103458_initial.down,
    name: '20261110_103458_initial',
  },
  {
    up: migration_20261110_105612_jobs.up,
    down: migration_20261110_105612_jobs.down,
    name: '20261110_105612_jobs',
  },
  {
    up: migration_20261110_105640_job_schedule.up,
    down: migration_20261110_105640_job_schedule.down,
    name: '20261110_105640_job_schedule'
  },
];
