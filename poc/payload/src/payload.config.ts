import fs from 'fs'
import path from 'path'
import { sqliteD1Adapter } from '@payloadcms/db-d1-sqlite'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { buildConfig } from 'payload'
import { fileURLToPath } from 'url'
import { CloudflareContext, getCloudflareContext } from '@opennextjs/cloudflare'
import { GetPlatformProxyOptions } from 'wrangler'
import { r2Storage } from '@payloadcms/storage-r2'

import { Users } from './collections/Users'
import { Media, MEDIA_MAX_BYTES } from './collections/Media'
import { Pages } from './collections/Pages'
import { Posts } from './collections/Posts'
import { Projects } from './collections/Projects'
import { Homepage } from './globals/Homepage'
import { Navigation } from './globals/Navigation'
import { Redirects } from './globals/Redirects'
import { SiteSettings } from './globals/SiteSettings'
import { migrations } from './migrations'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)
const realpath = (value: string) => {
  try {
    return fs.existsSync(value) ? fs.realpathSync(value) : undefined
  } catch {
    return undefined
  }
}

const isCLI = process.argv.some((value) => {
  const resolved = realpath(value)
  if (!resolved) return false
  return (
    resolved.endsWith(path.join('payload', 'bin.js')) ||
    resolved.endsWith(path.join('next', 'dist', 'bin', 'next'))
  )
})
const isProduction = process.env.NODE_ENV === 'production'

const createLog =
  (level: string, fn: typeof console.log) => (objOrMsg: object | string, msg?: string) => {
    if (typeof objOrMsg === 'string') {
      fn(JSON.stringify({ level, msg: objOrMsg }))
    } else {
      fn(JSON.stringify({ level, ...objOrMsg, msg: msg ?? (objOrMsg as { msg?: string }).msg }))
    }
  }

const cloudflareLogger = {
  level: process.env.PAYLOAD_LOG_LEVEL || 'info',
  trace: createLog('trace', console.debug),
  debug: createLog('debug', console.debug),
  info: createLog('info', console.log),
  warn: createLog('warn', console.warn),
  error: createLog('error', console.error),
  fatal: createLog('fatal', console.error),
  silent: () => {},
} as any // Use PayloadLogger type when it's exported

const cloudflare =
  isCLI || !isProduction
    ? await getCloudflareContextFromWrangler()
    : await getCloudflareContext({ async: true })
// The CLI (payload migrate) has no request context: hooks and migrations read the bindings from here
// instead (src/cloudflare-env.ts). Never set in the deployed Worker.
if (isCLI || !isProduction) (globalThis as { __payloadLocalEnv?: unknown }).__payloadLocalEnv = cloudflare.env

export default buildConfig({
  admin: {
    user: Users.slug,
    // Payload's default is Gravatar, which sends a hash of each person's email to gravatar.com (Phase 0 finding).
    avatar: 'default',
    meta: { titleSuffix: ' · Daly admin', icons: [{ rel: 'icon', type: 'image/svg+xml', url: '/brand/favicon.svg' }] },
    importMap: {
      baseDir: path.resolve(dirname),
    },
    components: {
      // Phase 0, experiment 2: the existing wedding screens as native admin views.
      views: {
        wedding: { Component: '/views/wedding-view#WeddingView', path: '/wedding/:segments*', meta: { title: 'Wedding' } },
        // The former portal settings and audit log (Phase 3: Payload is the only admin).
        administration: { Component: '/views/administration-view#AdministrationView', path: '/administration/:segments*', meta: { title: 'Administration' } },
      },
      // The wedding first (used most), Administration last; the Wedding section heads the dashboard.
      beforeNavLinks: ['/views/wedding-nav#WeddingNav'],
      afterNavLinks: ['/views/wedding-nav#AdministrationNav'],
      beforeDashboard: ['/views/dashboard-wedding#DashboardWedding', '/views/dashboard-site-sync#DashboardSiteSync'],
      graphics: { Icon: '/views/brand#DalyIcon', Logo: '/views/brand#DalyLogo' },
    },
  },
  collections: [Users, Media, Pages, Projects, Posts],
  // The website (docs/PAYLOAD-FRONTEND-PLAN.md): published straight to the public site by their hooks.
  globals: [Homepage, Navigation, Redirects, SiteSettings],
  // Not used; switched off so there is one less API surface to secure.
  graphQL: { disable: true },
  jobs: {
    // Payload's queue is run by the Worker's cron only when a job is due (platform/compose.ts
    // payloadHasDueJobs), so Payload's own scheduler (`schedule` on a task) is deliberately not used:
    // recurring work stays in the existing cron. This task is a stand-in for one queued on demand.
    tasks: [
      {
        slug: 'pocHeartbeat',
        inputSchema: [{ name: 'note', type: 'text' }],
        outputSchema: [{ name: 'ranAt', type: 'text' }],
        handler: async () => ({ output: { ranAt: new Date().toISOString() } }),
      },
    ],
    // Run only by the Worker's own cron (platform/compose.ts) with a secret nobody else holds.
    access: {
      run: ({ req }) => {
        const secret = process.env.PAYLOAD_JOBS_SECRET
        return Boolean(secret) && req.headers.get('authorization') === `Bearer ${secret}`
      },
    },
  },
  editor: lexicalEditor(),
  // Uploads over the public site's 15 MB limit are refused while they stream in (413), not after.
  upload: { limits: { fileSize: MEDIA_MAX_BYTES }, abortOnLimit: true },
  secret: process.env.PAYLOAD_SECRET || '',
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
  db: sqliteD1Adapter({
    binding: cloudflare.env.D1,
    prodMigrations: migrations,
    // `autoIncrement` stays off. Turning it on would stop SQLite reusing a deleted row's number, but Payload
    // can only do that by rebuilding every one of its tables (copy, drop, rename), and D1 runs a migration
    // statement by statement with no transaction around it. The public site guards against a reused number
    // itself instead (worker/site/publisher.ts earlierDocumentsSlug and forgetEarlierDocument).
  }),
  logger: isProduction ? cloudflareLogger : undefined,
  plugins: [
    r2Storage({
      bucket: cloudflare.env.R2,
      collections: { media: true },
    }),
  ],
})

// Adapted from https://github.com/opennextjs/opennextjs-cloudflare/blob/d00b3a13e42e65aad76fba41774815726422cc39/packages/cloudflare/src/api/cloudflare-context.ts#L328C36-L328C46
function getCloudflareContextFromWrangler(): Promise<CloudflareContext> {
  return import(/* webpackIgnore: true */ `${'__wrangler'.replaceAll('_', '')}`).then(
    ({ getPlatformProxy }) =>
      getPlatformProxy({
        environment: process.env.CLOUDFLARE_ENV,
        remoteBindings: isProduction,
      } satisfies GetPlatformProxyOptions),
  )
}
