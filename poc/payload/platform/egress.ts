// Phase 1 staging: the Worker may not call anything on the internet.
//
// Staging has no provider credentials and its delivery switches are "log", so nothing should try to
// send. This makes that a guarantee rather than a configuration detail: every global fetch to a host
// outside the allow-list is refused (as a network error, which every caller already handles) and
// logged with the host only. Bindings (D1, R2, assets, service bindings) don't go through global fetch
// and are unaffected.

export type EgressRule = (url: URL) => boolean;

/** Nothing is allowed out. */
export const DENY_ALL: EgressRule = () => false;

/** `original`, refusing every request whose URL `allow` doesn't accept. */
export function lockedFetch(original: typeof fetch, allow: EgressRule = DENY_ALL): typeof fetch {
    return (input, init) => {
        let url: URL;
        try {
            url = new URL(input instanceof Request ? input.url : String(input));
        } catch {
            return Promise.reject(new TypeError("egress refused: unparseable URL"));
        }
        if (!allow(url)) {
            console.log(JSON.stringify({ event: "egress_refused", host: url.hostname }));
            return Promise.reject(new TypeError(`egress refused: ${url.hostname}`));
        }
        return original(input, init);
    };
}

let installed = false;

export function lockEgress(allow: EgressRule = DENY_ALL): void {
    if (installed) return;
    installed = true;
    globalThis.fetch = lockedFetch(globalThis.fetch.bind(globalThis), allow);
}
