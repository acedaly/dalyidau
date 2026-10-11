const dateFormat = new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "Australia/Sydney" });
const shortDateFormat = new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "Australia/Sydney" });

/** Formats in Sydney time on both server and browser, so hydration always matches. */
export const formatDate = (iso: string | null | undefined, short = false) => {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return (short ? shortDateFormat : dateFormat).format(date);
};

export const sameDay = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && formatDate(a) === formatDate(b);

export const blogHref = (params: { q?: string | null; category?: string | null; tag?: string | null; page?: number }) => {
    const search = new URLSearchParams();
    if (params.q) search.set("q", params.q);
    if (params.category) search.set("category", params.category);
    if (params.tag) search.set("tag", params.tag);
    if (params.page && params.page > 1) search.set("page", String(params.page));
    const query = search.toString();
    return `/blog${query ? `?${query}` : ""}`;
};
