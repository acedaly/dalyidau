// Keeping a wallboard up to date (docs/INTELLIGENCE_CENTRE_9_1.md#display-behaviour).
//
// One refresh at a time, on the board's own interval. The screen sends back the state key it last
// had and a 304 means nothing changed (still a successful refresh). Failures keep the last good data
// and back off (5 s doubling to 5 minutes); the network or the tab coming back retries at once. A
// renewable credential near its expiry is swapped for a new one, which replaces the old in the
// address without reloading. The credential only ever travels in the Authorization header.
import { useCallback, useEffect, useRef, useState } from "react";
import type { WallboardPayloadV2 } from "@/shared/centre/wallboard";

const ENDPOINT = "/api/display/wallboard?v=2";
const RENEW = "/api/display/renew";
const MAX_BACKOFF_MS = 5 * 60_000;

export const tokenFromHash = (hash: string): string | null => /(?:^#|&)t=([A-Za-z0-9_-]{43})(?:&|$)/.exec(hash)?.[1] ?? null;

export type DisplayStatus =
    | { kind: "loading" }
    | { kind: "ok" }
    | { kind: "offline"; since: number }
    | { kind: "refused"; reason: "not_found" | "rate_limited" }
    | { kind: "no_token" };

export function useWallboard(initialToken: string | null) {
    const [token, setToken] = useState(initialToken);
    const [payload, setPayload] = useState<WallboardPayloadV2 | null>(null);
    const [status, setStatus] = useState<DisplayStatus>(initialToken ? { kind: "loading" } : { kind: "no_token" });
    const [lastSuccess, setLastSuccess] = useState<number | null>(null);
    const tokenRef = useRef(initialToken);
    const stateKey = useRef<string | null>(null);
    const refresh = useRef(60);
    const failures = useRef(0);
    const renewing = useRef(false);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const inFlight = useRef(false);

    const renew = useCallback(async () => {
        if (renewing.current || !tokenRef.current) return;
        renewing.current = true;
        try {
            const response = await fetch(RENEW, {
                method: "POST",
                headers: { Authorization: `Bearer ${tokenRef.current}`, Accept: "application/json" },
                cache: "no-store",
                credentials: "omit",
                referrerPolicy: "no-referrer",
            });
            if (!response.ok) return;
            const body = (await response.json()) as { token: string };
            if (!/^[A-Za-z0-9_-]{43}$/.test(body.token)) return;
            tokenRef.current = body.token;
            setToken(body.token);
            // replaceState doesn't fire hashchange, so the board keeps running.
            window.history.replaceState(null, "", `${window.location.pathname}#t=${body.token}`);
        } catch {
            // Tried again at a later refresh: the old credential still works until it expires.
        } finally {
            renewing.current = false;
        }
    }, []);

    const load = useCallback(async () => {
        if (!tokenRef.current || inFlight.current) return;
        clearTimeout(timer.current);
        inFlight.current = true;
        let next = refresh.current * 1000;
        try {
            const response = await fetch(ENDPOINT, {
                headers: {
                    Authorization: `Bearer ${tokenRef.current}`,
                    Accept: "application/json",
                    ...(stateKey.current ? { "If-None-Match": `"${stateKey.current}"` } : {}),
                },
                cache: "no-store",
                credentials: "omit",
                referrerPolicy: "no-referrer",
            });
            if (response.status === 304) {
                setLastSuccess(Date.now());
                setStatus({ kind: "ok" });
                failures.current = 0;
            } else if (response.status === 404 || response.status === 429) {
                setStatus({ kind: "refused", reason: response.status === 404 ? "not_found" : "rate_limited" });
                // A revoked or switched-off display checks back rarely, in case it's switched on again.
                next = response.status === 404 ? 5 * 60_000 : 60_000;
                stateKey.current = null;
            } else if (!response.ok) throw new Error(String(response.status));
            else {
                const body = (await response.json()) as { wallboard: WallboardPayloadV2 };
                setPayload(body.wallboard);
                stateKey.current = body.wallboard.stateKey;
                refresh.current = body.wallboard.board.refreshSeconds;
                next = refresh.current * 1000;
                setLastSuccess(Date.now());
                setStatus({ kind: "ok" });
                failures.current = 0;
                if (body.wallboard.renewal.due) void renew();
            }
        } catch {
            failures.current++;
            setStatus((s) => (s.kind === "offline" ? s : { kind: "offline", since: Date.now() }));
            next = Math.min(MAX_BACKOFF_MS, 5_000 * 2 ** Math.min(failures.current - 1, 6));
        } finally {
            inFlight.current = false;
        }
        timer.current = setTimeout(() => void load(), next);
    }, [renew]);

    useEffect(() => {
        void load();
        // Reconnect straight away when the network or the tab comes back.
        const again = () => document.visibilityState !== "hidden" && void load();
        window.addEventListener("online", again);
        document.addEventListener("visibilitychange", again);
        return () => {
            clearTimeout(timer.current);
            window.removeEventListener("online", again);
            document.removeEventListener("visibilitychange", again);
        };
    }, [load]);

    return { payload, status, lastSuccess, token };
}
