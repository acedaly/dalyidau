// What the server sends inside #root for a portal page. The portal is private and noindex, so it
// renders in the browser rather than on the Worker: a full React render of a page like the
// dashboard costs more CPU than a Worker request is allowed (see docs/PRODUCTION_READINESS.md).
// This is plain HTML, kept in src/ so Tailwind sees its classes. Every value is escaped.
const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const portalBootShell = (title: string) =>
    `<div class="flex min-h-dvh items-center justify-center bg-primary px-4" data-portal-boot>` +
    `<div class="flex flex-col items-center gap-2 text-center" role="status" aria-live="polite">` +
    `<p class="text-md font-semibold text-primary">${escape(title)}</p>` +
    `<p class="text-sm text-tertiary">Loading…</p>` +
    `<noscript><p class="text-sm text-tertiary">Wedding Planner needs JavaScript. Turn it on and reload the page.</p></noscript>` +
    `</div></div>`;
