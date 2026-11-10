'use client'
// The isolation boundary: the portal's Tailwind/Untitled UI stylesheet lives only inside a shadow root,
// so it can't restyle Payload, and Payload's admin CSS can't reach the wedding screen. React Aria's
// overlays (menus, dialogs, toasts) are kept inside the same shadow root by UNSAFE_PortalProvider.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { UNSAFE_PortalProvider } from 'react-aria'

import type { PortalPageData } from '@/shared/portal/types'
import { ToastProvider } from '@/portal/components/toast'
import { BudgetPage } from '@/portal/pages/budget-page'
import { CateringPage } from '@/portal/pages/catering-page'
import { CommunicationsPage } from '@/portal/pages/communications-page'
import { DashboardPage } from '@/portal/pages/dashboard-page'
import { EventsPage } from '@/portal/pages/events-page'
import { GuestImportPage } from '@/portal/pages/guest-import-page'
import { GuestsPage } from '@/portal/pages/guests-page'
import { HouseholdsPage } from '@/portal/pages/households-page'
import { InvitationStudioPage } from '@/portal/pages/invitation-studio-page'
import { MessagePage } from '@/portal/pages/message-page'
import { ProviderSettingsPage } from '@/portal/pages/provider-settings-page'
import { RsvpsPage } from '@/portal/pages/rsvps-page'
import { SeatingPage } from '@/portal/pages/seating-page'
import { WeddingSettingsPage } from '@/portal/pages/settings-page'
import { ForbiddenPage, NotFoundPage } from '@/portal/pages/status-pages'
import { SuppliersPage } from '@/portal/pages/suppliers-page'
import { TasksPage } from '@/portal/pages/tasks-page'
import { TextsPage } from '@/portal/pages/texts-page'
import { TimelinePage } from '@/portal/pages/timeline-page'
import { WebsitePage } from '@/portal/pages/website-page'
import { PortalProvider } from '@/portal/portal-context'
import { useRouter } from 'next/navigation'

import { adminPathForPortalLink } from './wedding-routes'

type Loaded = { data: PortalPageData; styles: string[]; shadowDefaults: string; title: string } | { error: string }

/** The portal's own page for each wedding route (the same mapping as src/portal/portal-app.tsx). */
const Screen = ({ data }: { data: PortalPageData }) => {
  switch (data.route) {
    case 'dashboard':
      return <DashboardPage data={data} />
    case 'guests':
      return <GuestsPage data={data} />
    case 'guest-import':
      return <GuestImportPage data={data} />
    case 'households':
      return <HouseholdsPage data={data} />
    case 'events':
      return <EventsPage data={data} />
    case 'rsvps':
      return <RsvpsPage data={data} />
    case 'communications':
      return <CommunicationsPage data={data} />
    case 'invitation-studio':
      return <InvitationStudioPage data={data} />
    case 'provider-settings':
      return <ProviderSettingsPage data={data} />
    case 'message':
      return <MessagePage data={data} />
    case 'texts':
      return <TextsPage data={data} />
    case 'tasks':
      return <TasksPage data={data} />
    case 'timeline':
      return <TimelinePage data={data} />
    case 'seating':
      return <SeatingPage data={data} />
    case 'catering':
      return <CateringPage data={data} />
    case 'budget':
      return <BudgetPage data={data} />
    case 'suppliers':
      return <SuppliersPage data={data} />
    case 'website':
      return <WebsitePage data={data} />
    case 'wedding-settings':
      return <WeddingSettingsPage data={data} />
    case 'forbidden':
      return <ForbiddenPage message={data.message} />
    default:
      return <NotFoundPage />
  }
}

export function WeddingScreen({ path }: { path: string }) {
  const host = useRef<HTMLDivElement>(null)
  const [mount, setMount] = useState<HTMLElement | null>(null)
  const [state, setState] = useState<Loaded | null>(null)
  const router = useRouter()

  useEffect(() => {
    let cancelled = false
    fetch(`/api/platform/wedding-page?path=${encodeURIComponent(path)}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(async (r) => (r.ok ? ((await r.json()) as Loaded) : { error: r.status === 403 ? 'You don’t have access to this screen.' : `Couldn’t load (${r.status}).` }))
      .catch(() => ({ error: 'Couldn’t reach the server.' }))
      .then((loaded) => !cancelled && setState(loaded))
    return () => {
      cancelled = true
    }
  }, [path])

  // One shadow root per view; its stylesheet links are the portal's own built CSS files.
  useEffect(() => {
    if (!host.current || !state || 'error' in state) return
    const root = host.current.shadowRoot ?? host.current.attachShadow({ mode: 'open' })
    root.replaceChildren()
    // Tailwind's starting values for its --tw-* variables (see platform/bridge.ts shadowDefaults), first so
    // its layer order matches the stylesheet's own.
    const defaults = document.createElement('style')
    defaults.textContent = state.shadowDefaults
    root.append(defaults)
    for (const href of state.styles) {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = href
      root.append(link)
    }
    const container = document.createElement('div')
    container.className = 'wedding-root bg-primary text-primary font-body'
    container.style.minHeight = '60vh'
    root.append(container)
    // Follow Payload's light/dark choice with the portal's own dark-mode class, inside the boundary only.
    const sync = () => container.classList.toggle('dark-mode', document.documentElement.dataset.theme === 'dark')
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    // Links to other wedding screens stay inside Payload (same screen, Payload's chrome). A plain
    // left-click only; anything else (new tab, other apps, downloads) behaves as a normal link.
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const anchor = event.composedPath().find((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement)
      if (!anchor || anchor.target || anchor.hasAttribute('download')) return
      const target = adminPathForPortalLink(anchor.getAttribute('href') ?? '')
      if (!target) return
      event.preventDefault()
      router.push(target)
    }
    container.addEventListener('click', onClick)
    setMount(container)
    return () => {
      observer.disconnect()
      container.removeEventListener('click', onClick)
    }
  }, [state])

  if (state && 'error' in state) return <p role="alert">{state.error}</p>
  return (
    <div ref={host} data-testid="wedding-screen" data-path={path}>
      {!state && <p>Loading…</p>}
      {mount && state && 'data' in state &&
        createPortal(
          <UNSAFE_PortalProvider getContainer={() => mount}>
            <PortalProvider value={state.data.context}>
              <ToastProvider>
                <div className="mx-auto flex w-full max-w-container flex-col gap-8 px-4 py-8 lg:px-8">
                  <Screen data={state.data} />
                </div>
              </ToastProvider>
            </PortalProvider>
          </UNSAFE_PortalProvider>,
          mount,
        )}
    </div>
  )
}
