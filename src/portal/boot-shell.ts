// What the server sends inside #root for a portal page. The portal is private and noindex, so it
// renders in the browser rather than on the Worker, which keeps a full React render of pages like
// the dashboard (and the portal's code) out of every request's CPU time (see docs/PORTAL.md).
// This is plain HTML, kept in src/ so Tailwind sees its classes. Every value is escaped.
const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const portalBootShell = (title: string) =>
    `<div class="flex min-h-dvh items-center justify-center bg-primary px-4" data-portal-boot>` +
    `<div class="flex flex-col items-center gap-2 text-center" role="status" aria-live="polite">` +
    `<p class="text-md font-semibold text-primary">${escape(title)}</p>` +
    `<p class="text-sm text-tertiary">Loading…</p>` +
    `<noscript><p class="text-sm text-tertiary">Wedding Planner needs JavaScript. Turn it on and reload the page.</p></noscript>` +
    `</div></div>`;

// Untitled UI's WifiOff icon, inline because the offline page loads no JavaScript.
const WIFI_OFF =
    "M15.312 10c1.368.426 2.65 1.12 3.768 2.05m3.5-3.55a16 16 0 0 0-12.383-3.896M8.53 15.61a6 6 0 0 1 6.95 0M12 19.5h.01M1.193 8.7A16.014 16.014 0 0 1 5.76 5.764m-1.027 6.48a10.966 10.966 0 0 1 5-2.51m5.966 6.042A5.974 5.974 0 0 0 12 14.5c-1.416 0-2.718.49-3.745 1.312M3 3l18 18";

/**
 * The installed Wedding Planner's offline page (worker/portal/pwa.ts), shown by the service worker
 * when a portal page can't be reached. Static: it holds no guest or portal data, and nothing else
 * from the portal is stored on the device. "Try again" reloads the address that failed (the page
 * is served in place of it, so an empty href is that address). Composed like Untitled UI's empty
 * state with a light brand FeaturedIcon and a primary Button.
 */
export const portalOfflineShell = (shortName: string) =>
    `<div class="flex min-h-dvh flex-col bg-primary" data-portal-offline>` +
    `<header class="flex h-14 items-center gap-2.5 border-b border-secondary px-4">` +
    `<span aria-hidden="true" class="flex size-8 items-center justify-center rounded-lg bg-brand-solid text-xs font-bold tracking-wide text-white shadow-xs-skeuomorphic">${escape(shortName)}</span>` +
    `<span class="flex flex-col leading-tight"><span class="text-sm font-semibold text-primary">Daly Portal</span><span class="text-xs text-tertiary">Wedding Planner</span></span>` +
    `</header>` +
    `<main class="flex flex-1 items-center justify-center px-4 py-12">` +
    `<div class="flex max-w-sm flex-col items-center gap-6 text-center">` +
    `<span class="flex size-12 items-center justify-center rounded-full bg-brand-secondary text-featured-icon-light-fg-brand">` +
    `<svg aria-hidden="true" class="size-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${WIFI_OFF}"/></svg>` +
    `</span>` +
    `<div class="flex flex-col gap-2">` +
    `<h1 class="text-lg font-semibold text-primary">You're offline</h1>` +
    `<p class="text-sm text-tertiary">Wedding Planner needs a connection to show guests, RSVPs and plans. Nothing from the portal is kept on this device; everything will be here again as soon as you're back online.</p>` +
    `</div>` +
    `<a href="" class="inline-flex items-center justify-center gap-1 rounded-lg bg-brand-solid px-3.5 py-2.5 text-sm font-semibold text-white shadow-xs-skeuomorphic ring-1 ring-transparent ring-inset outline-brand transition duration-100 ease-linear hover:bg-brand-solid_hover focus-visible:outline-2 focus-visible:outline-offset-2">Try again</a>` +
    `</div></main></div>`;
