import * as migration_20261110_103458_initial from './20261110_103458_initial';
import * as migration_20261110_105612_jobs from './20261110_105612_jobs';
import * as migration_20261110_105640_job_schedule from './20261110_105640_job_schedule';
import * as migration_20261111_060845_blog_posts from './20261111_060845_blog_posts';
import * as migration_20261111_070000_blog_import from './20261111_070000_blog_import';

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
    name: '20261110_105640_job_schedule',
  },
  {
    up: migration_20261111_060845_blog_posts.up,
    down: migration_20261111_060845_blog_posts.down,
    name: '20261111_060845_blog_posts',
  },
  {
    up: migration_20261111_070000_blog_import.up,
    down: migration_20261111_070000_blog_import.down,
    name: '20261111_070000_blog_import',
  },
];
