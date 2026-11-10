'use client'
// The isolation boundary: the portal's Tailwind/Untitled UI stylesheet lives only inside a shadow root,
// so it can't restyle Payload, and Payload's admin CSS can't reach the wedding screen. React Aria's
// overlays (menus, dialogs, toasts) are kept inside the same shadow root by UNSAFE_PortalProvider.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { UNSAFE_PortalProvider } from 'react-aria'

import type { PortalPageData } from '@/shared/portal/types'
import { ToastProvider } from '@/portal/components/toast'
import { DashboardPage } from '@/portal/pages/dashboard-page'
import { GuestsPage } from '@/portal/pages/guests-page'
import { HouseholdsPage } from '@/portal/pages/households-page'
import { RsvpsPage } from '@/portal/pages/rsvps-page'
import { SeatingPage } from '@/portal/pages/seating-page'
import { PortalProvider } from '@/portal/portal-context'

type Loaded = { data: PortalPageData; styles: string[]; shadowDefaults: string; title: string } | { error: string }

const Screen = ({ data }: { data: PortalPageData }) => {
  switch (data.route) {
    case 'dashboard':
      return <DashboardPage data={data} />
    case 'guests':
      return <GuestsPage data={data} />
    case 'households':
      return <HouseholdsPage data={data} />
    case 'rsvps':
      return <RsvpsPage data={data} />
    case 'seating':
      return <SeatingPage data={data} />
    default:
      return <p>This screen isn&apos;t available here.</p>
  }
}

export function WeddingScreen({ path }: { path: string }) {
  const host = useRef<HTMLDivElement>(null)
  const [mount, setMount] = useState<HTMLElement | null>(null)
  const [state, setState] = useState<Loaded | null>(null)

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
    setMount(container)
    return () => observer.disconnect()
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
