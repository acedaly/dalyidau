// The address a public page is cached under at the edge (worker/index.ts cachedPage). On its own so it can be
// tested without the Worker around it.

/** The query parameters a public page's content depends on (readFilters; `q` is never cached). */
const PAGE_PARAMS = ["category", "page", "tag"];

/**
 * The address a page is cached under: its path, the parameters pages read (in a fixed order), and what the
 * copy was built from (the code, the content, the design). Everything else in the query string is left
 * out: tracking parameters (utm_*, fbclid…) would otherwise give every shared link its own copy, and a
 * visitor could never write the three internal parts themselves.
 */
export function pageCacheKey(url: URL, build: string, content: string, variant: string): string {
    const params = new URLSearchParams();
    for (const name of PAGE_PARAMS) for (const value of url.searchParams.getAll(name)) params.append(name, value);
    params.set("__b", build);
    params.set("__c", content);
    params.set("__v", variant);
    return `${url.origin}${url.pathname}?${params}`;
}
