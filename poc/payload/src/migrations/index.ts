import * as migration_20261110_103458_initial from './20261110_103458_initial';
import * as migration_20261110_105612_jobs from './20261110_105612_jobs';
import * as migration_20261110_105640_job_schedule from './20261110_105640_job_schedule';
import * as migration_20261111_060845_blog_posts from './20261111_060845_blog_posts';
import * as migration_20261111_070000_blog_import from './20261111_070000_blog_import';
import * as migration_20261111_084356_site_content from './20261111_084356_site_content';
import * as migration_20261111_085000_projects from './20261111_085000_projects';
import * as migration_20261111_090000_site_seed from './20261111_090000_site_seed';
import * as migration_20261114_031432_phase2b_seo_redirects_history from './20261114_031432_phase2b_seo_redirects_history';

// Order matters only on a fresh database (CI, local, a new environment): production has applied everything up
// to the seed already, and Payload runs whatever is pending by name.
//
// The two data migrations (the blog import and the site seed) write documents through Payload with TODAY's
// collections, so every schema migration must have run before them or the columns they write don't exist
// yet. They therefore come last. A new schema migration goes above them; a new data migration goes at the end.
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
    up: migration_20261111_084356_site_content.up,
    down: migration_20261111_084356_site_content.down,
    name: '20261111_084356_site_content',
  },
  {
    up: migration_20261111_085000_projects.up,
    down: migration_20261111_085000_projects.down,
    name: '20261111_085000_projects',
  },
  {
    // Phase 2b (docs/AUDIT-2026-11.md): additive only. `up` creates tables and indexes and adds nullable
    // columns; it rewrites and removes nothing. Never run its `down` in production: rolling back is a code
    // rollback, and the extra tables and columns are simply left unused.
    up: migration_20261114_031432_phase2b_seo_redirects_history.up,
    down: migration_20261114_031432_phase2b_seo_redirects_history.down,
    name: '20261114_031432_phase2b_seo_redirects_history'
  },
  {
    up: migration_20261111_070000_blog_import.up,
    down: migration_20261111_070000_blog_import.down,
    name: '20261111_070000_blog_import',
  },
  {
    up: migration_20261111_090000_site_seed.up,
    down: migration_20261111_090000_site_seed.down,
    name: '20261111_090000_site_seed',
  },
];
