// Every existing wedding screen as a native Payload admin view (/admin/wedding/...).
// Payload's own chrome (navigation, account menu) surrounds it; the screen itself is the portal's
// component, unchanged, fed by the portal's own page loader through /api/platform/wedding-page.
import type { AdminViewServerProps } from 'payload'
import { DefaultTemplate } from '@payloadcms/next/templates'
import { Gutter } from '@payloadcms/ui'
import { notFound } from 'next/navigation'

import { WEDDING_SCREEN, portalPath } from './wedding-routes'
import { WeddingScreen } from './wedding-screen'

export function WeddingView({ initPageResult, params, searchParams }: AdminViewServerProps) {
  const user = initPageResult.req.user as { permissions?: string[] } | null
  // The real checks are server-side on every API call; this only avoids rendering an empty shell.
  if (!user?.permissions?.includes('wedding.view')) notFound()
  const segments = ((params?.segments as string[] | undefined) ?? []).slice(1)
  const screen = segments.join('/')
  if (!WEDDING_SCREEN.test(screen)) notFound()
  return (
    <DefaultTemplate
      i18n={initPageResult.req.i18n}
      locale={initPageResult.locale}
      params={params}
      payload={initPageResult.req.payload}
      permissions={initPageResult.permissions}
      searchParams={searchParams}
      user={initPageResult.req.user ?? undefined}
      visibleEntities={initPageResult.visibleEntities}
    >
      <Gutter>
        <WeddingScreen path={portalPath(screen)} />
      </Gutter>
    </DefaultTemplate>
  )
}
