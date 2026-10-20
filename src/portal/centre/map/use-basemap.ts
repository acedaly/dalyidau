// Which basemap the portal's maps draw (docs/INTELLIGENCE_CENTRE_9_1.md#detailed-basemap): asked of
// the Worker once per page and shared by every map on it. Anything going wrong means the outline.
import { useEffect, useState } from "react";
import type { BasemapInfo } from "@/shared/centre/wallboard";

let pending: Promise<BasemapInfo | null> | null = null;

const load = () => {
    pending ??= fetch("/api/portal/centre/basemap", { credentials: "same-origin", headers: { Accept: "application/json" } })
        .then((r) => (r.ok ? (r.json() as Promise<{ basemap: BasemapInfo }>) : null))
        .then((body) => body?.basemap ?? null)
        .catch(() => null);
    return pending;
};

/** undefined while loading, null when it couldn't be asked (the outline is drawn), otherwise the answer. */
export function useBasemap(enabled: boolean): BasemapInfo | null | undefined {
    const [info, setInfo] = useState<BasemapInfo | null | undefined>(undefined);
    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        void load().then((b) => !cancelled && setInfo(b));
        return () => {
            cancelled = true;
        };
    }, [enabled]);
    return enabled ? info : null;
}
