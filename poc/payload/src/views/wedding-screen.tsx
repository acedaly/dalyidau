'use client'
// The isolation boundary: the portal's Tailwind/Untitled UI stylesheet lives only inside a shadow root,
// so it can't restyle Payload, and Payload's admin CSS can't reach the wedding screen. React Aria's
// overlays (menus, dialogs, toasts) are kept inside the same shadow root by UNSAFE_PortalProvider.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { UNSAFE_PortalProvider } from 'react-aria'
// React Aria tracks presses with listeners on the document. Across a shadow root the browser retargets those
// events to the host element, so without this every press looked like "released outside the button" and was
// cancelled: no button in a wedding screen responded to a mouse (text fields did). This makes React Aria
// follow events into shadow roots (composedPath). Payload's own UI doesn't use React Aria.
import { enableShadowDOM } from 'react-stately/private/flags/flags'
enableShadowDOM()

import type { PortalPageData } from '@/shared/portal/types'
import { AdminScreen } from '@/portal/portal-screen'
import { useRouter } from 'next/navigation'

import { adminPathForPortalLink } from './wedding-routes'

type Loaded = { data: PortalPageData; styles: string[]; shadowDefaults: string; title: string } | { error: string }

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
    // Overlays (dialogs, menus, toasts) are added to this container next to the screen. React Aria's shadow DOM
    // mode leaves an open dialog's shadow-root observer running when a second dialog opens on top of it (a
    // "Delete guest?" confirmation over the guest panel), and that observer made the new dialog inert: it was
    // visible but couldn't be clicked. React Aria never hides nodes marked as its top layer, so each overlay is
    // marked as it's added. This observer is registered before React Aria's, so it runs first.
    const overlays = new MutationObserver((changes) => {
      for (const change of changes)
        for (const node of change.addedNodes)
          if (node instanceof HTMLElement && !node.hasAttribute('data-admin-screen')) node.setAttribute('data-react-aria-top-layer', 'true')
    })
    overlays.observe(container, { childList: true })
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
      overlays.disconnect()
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
            <AdminScreen data={state.data} />
          </UNSAFE_PortalProvider>,
          mount,
        )}
    </div>
  )
}
