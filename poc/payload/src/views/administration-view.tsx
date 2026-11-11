// The former portal settings and audit log as a native Payload admin view (/admin/administration/...):
// users and permissions, feature switches, integrations, privacy and the audit log. The screens are the
// portal's own components, fed by the portal's loader through /api/platform/wedding-page, which applies
// the same sign-in and per-section permission checks as before.
import type { AdminViewServerProps } from 'payload'
import { DefaultTemplate } from '@payloadcms/next/templates'
import { Gutter } from '@payloadcms/ui'
import { notFound } from 'next/navigation'

import { ADMINISTRATION_SCREEN, portalPathForAdministration } from './wedding-routes'
import { WeddingScreen } from './wedding-screen'

export function AdministrationView({ initPageResult, params, searchParams }: AdminViewServerProps) {
  const user = initPageResult.req.user as { permissions?: string[] } | null
  if (!user?.permissions?.length) notFound()
  const segments = ((params?.segments as string[] | undefined) ?? []).slice(1)
  const screen = segments.join('/')
  if (!ADMINISTRATION_SCREEN.test(screen)) notFound()
  const query = new URLSearchParams(
    Object.entries((searchParams ?? {}) as Record<string, string | string[] | undefined>).flatMap(([k, v]) =>
      v === undefined ? [] : (Array.isArray(v) ? v : [v]).map((x) => [k, x] as [string, string]),
    ),
  ).toString()
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
        <WeddingScreen path={portalPathForAdministration(screen) + (query ? `?${query}` : '')} />
      </Gutter>
    </DefaultTemplate>
  )
}
