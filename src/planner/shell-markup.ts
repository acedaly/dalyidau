// Plain-HTML pieces of Wedding Planner (worker/planner/pwa.ts): what the server sends inside #root
// while the app loads, and the offline page the service worker shows. Kept in src/ so Tailwind sees
// their classes. Every value is escaped.
const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// Untitled UI's HeartRounded and WifiOff icons, inline because neither page has loaded any JavaScript.
const HEART =
    "M16.111 3C19.633 3 22 6.353 22 9.48 22 15.814 12.178 21 12 21c-.178 0-10-5.186-10-11.52C2 6.352 4.367 3 7.889 3 9.91 3 11.233 4.024 12 4.924 12.767 4.024 14.089 3 16.111 3Z";
const WIFI_OFF =
    "M15.312 10c1.368.426 2.65 1.12 3.768 2.05m3.5-3.55a16 16 0 0 0-12.383-3.896M8.53 15.61a6 6 0 0 1 6.95 0M12 19.5h.01M1.193 8.7A16.014 16.014 0 0 1 5.76 5.764m-1.027 6.48a10.966 10.966 0 0 1 5-2.51m5.966 6.042A5.974 5.974 0 0 0 12 14.5c-1.416 0-2.718.49-3.745 1.312M3 3l18 18";

const icon = (path: string, className: string) =>
    `<svg aria-hidden="true" class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;

const mark = `<span aria-hidden="true" class="flex size-10 items-center justify-center rounded-xl bg-brand-solid text-white shadow-xs-skeuomorphic">${icon(HEART, "size-5")}</span>`;

export const plannerBootMarkup = () =>
    `<div class="flex min-h-dvh flex-col items-center justify-center gap-3 bg-secondary_alt px-4" role="status" aria-live="polite">` +
    mark +
    `<p class="text-sm text-tertiary">Loading Wedding Planner…</p>` +
    `<noscript><p class="text-sm text-tertiary">Wedding Planner needs JavaScript. Turn it on and reload the page.</p></noscript>` +
    `</div>`;

/**
 * Shown in place of a page that couldn't be reached. Holds no guest or wedding data. "Try again"
 * reloads the address that failed (the page is served in place of it, so an empty href is that
 * address). Composed like Untitled UI's empty state: a light brand FeaturedIcon and a primary Button.
 */
export const plannerOfflineMarkup = (adminHome: string) =>
    `<div class="flex min-h-dvh flex-col bg-secondary_alt" data-planner-offline>` +
    `<header class="flex h-16 items-center gap-3 px-4">${mark}<span class="text-md font-semibold text-primary">Wedding Planner</span></header>` +
    `<main class="flex flex-1 items-center justify-center px-4 pb-16">` +
    `<div class="flex w-full max-w-sm flex-col items-center gap-6 rounded-2xl bg-primary px-6 py-10 text-center shadow-xs ring-1 ring-secondary ring-inset">` +
    `<span class="flex size-12 items-center justify-center rounded-full bg-brand-secondary text-featured-icon-light-fg-brand">${icon(WIFI_OFF, "size-6")}</span>` +
    `<div class="flex flex-col gap-2">` +
    `<h1 class="text-lg font-semibold text-primary">You're offline</h1>` +
    `<p class="text-sm text-tertiary">Wedding Planner needs a connection to show guests, RSVPs and plans. Nothing is kept on this device, so everything will be here as soon as you're back online.</p>` +
    `</div>` +
    `<a href="" class="inline-flex items-center justify-center gap-1 rounded-lg bg-brand-solid px-3.5 py-2.5 text-sm font-semibold text-white shadow-xs-skeuomorphic ring-1 ring-transparent ring-inset outline-brand transition duration-100 ease-linear hover:bg-brand-solid_hover focus-visible:outline-2 focus-visible:outline-offset-2">Try again</a>` +
    `<a href="${escape(adminHome)}" class="text-sm font-semibold text-brand-secondary hover:text-brand-secondary_hover">Open the wedding admin</a>` +
    `</div></main></div>`;
