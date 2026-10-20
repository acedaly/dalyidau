// Wallboard display (/display#t=…): a full-screen, read-only view of one wallboard for a monitor,
// TV or kiosk, with no portal navigation.
//
// The display credential stays in the URL fragment (never sent to a server) and goes to the
// Worker only in the Authorization header. The page refreshes on the wallboard's interval, keeps
// the last good data through network failures (reconnecting with backoff), and says plainly and
// prominently when what it shows is stale. Official warnings, observations and interpretation are
// shown in separate, labelled areas. It's not an official warning service or guaranteed real-time
// monitoring, and says so on screen.
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, PauseCircle, Play, WifiOff } from "@untitledui/icons";
import { CentreMap, type MapFeature, MapLegend } from "@/portal/centre/map/centre-map";
import { FireDangerBadge, LevelBadge } from "@/portal/centre/shared";
import { SOURCE_STATUS_LABELS } from "@/shared/centre/sources";
import type { CentreRecord, WallboardLayout, WallboardPayload } from "@/shared/centre/types";
import { CHANGE_KIND_LABELS, WALLBOARD_LAYOUT_LABELS } from "@/shared/centre/types";
import { cx } from "@/utils/cx";

const ENDPOINT = "/api/display/wallboard";
const MAX_BACKOFF_MS = 5 * 60_000;

export const tokenFromHash = (hash: string): string | null => /(?:^#|&)t=([A-Za-z0-9_-]{43})(?:&|$)/.exec(hash)?.[1] ?? null;

type Status =
    | { kind: "loading" }
    | { kind: "ok" }
    | { kind: "offline"; since: number }
    | { kind: "refused"; reason: "not_found" | "rate_limited" }
    | { kind: "no_token" };

const clock = (date: Date, timeZone: string, seconds = false) =>
    new Intl.DateTimeFormat("en-AU", { timeZone, hour: "numeric", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) }).format(date);
const dayLabel = (date: Date, timeZone: string) => new Intl.DateTimeFormat("en-AU", { timeZone, weekday: "long", day: "numeric", month: "long" }).format(date);
const at = (iso: string | null | undefined, timeZone: string) =>
    iso
        ? new Intl.DateTimeFormat("en-AU", { timeZone, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso))
        : "time not given";
const ago = (iso: string | null | undefined, now: number) => {
    if (!iso) return "never";
    const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
    return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

export function useWallboard(token: string | null) {
    const [payload, setPayload] = useState<WallboardPayload | null>(null);
    const [status, setStatus] = useState<Status>(token ? { kind: "loading" } : { kind: "no_token" });
    const [lastSuccess, setLastSuccess] = useState<number | null>(null);
    const failures = useRef(0);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    const load = useCallback(async () => {
        if (!token) return;
        clearTimeout(timer.current);
        let next = (payload?.board.refreshSeconds ?? 60) * 1000;
        try {
            const response = await fetch(ENDPOINT, {
                headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
                cache: "no-store",
                credentials: "omit",
                referrerPolicy: "no-referrer",
            });
            if (response.status === 404 || response.status === 429) {
                setStatus({ kind: "refused", reason: response.status === 404 ? "not_found" : "rate_limited" });
                // A revoked or switched-off display checks back rarely, in case it's switched on again.
                next = response.status === 404 ? 5 * 60_000 : 60_000;
            } else if (!response.ok) throw new Error(String(response.status));
            else {
                const body = (await response.json()) as { wallboard: WallboardPayload };
                setPayload(body.wallboard);
                setLastSuccess(Date.now());
                setStatus({ kind: "ok" });
                failures.current = 0;
                next = body.wallboard.board.refreshSeconds * 1000;
            }
        } catch {
            failures.current++;
            setStatus((s) => (s.kind === "offline" ? s : { kind: "offline", since: Date.now() }));
            next = Math.min(MAX_BACKOFF_MS, 5_000 * 2 ** Math.min(failures.current, 6));
        }
        timer.current = setTimeout(() => void load(), next);
    }, [token, payload?.board.refreshSeconds]);

    useEffect(() => {
        void load();
        // Reconnect straight away when the network or the tab comes back.
        const again = () => void load();
        window.addEventListener("online", again);
        document.addEventListener("visibilitychange", again);
        return () => {
            clearTimeout(timer.current);
            window.removeEventListener("online", again);
            document.removeEventListener("visibilitychange", again);
        };
        // load changes when the refresh interval does; one schedule at a time.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token]);

    return { payload, status, lastSuccess };
}

const Panel = ({
    title,
    label,
    children,
    className,
}: {
    title: string;
    label: "Official" | "Observed" | "Derived, not official";
    children: React.ReactNode;
    className?: string;
}) => (
    <section aria-label={title} className={cx("flex min-h-0 flex-col gap-3 rounded-2xl bg-secondary p-5 ring-1 ring-secondary", className)}>
        <div className="flex items-center justify-between gap-3">
            <h2 className="text-2xl font-semibold text-primary">{title}</h2>
            <span
                className={cx(
                    "rounded-md px-2 py-0.5 text-base font-medium ring-1",
                    label === "Official"
                        ? "text-brand-secondary ring-brand"
                        : label === "Observed"
                          ? "text-secondary ring-primary"
                          : "text-tertiary ring-secondary",
                )}
            >
                {label}
            </span>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </section>
);

const RecordLine = ({ r, timeZone }: { r: CentreRecord; timeZone: string }) => (
    <li className="flex flex-col gap-1 border-b border-secondary py-2.5 last:border-0">
        <div className="flex flex-wrap items-center gap-2">
            <LevelBadge record={r} size="lg" />
            <span className="text-xl font-semibold text-primary">{r.title}</span>
        </div>
        <span className="text-lg text-tertiary">
            {[r.status, r.areaName, r.provider].filter(Boolean).join(" · ")} · updated {at(r.updatedAt ?? r.publishedAt ?? r.observedAt, timeZone)}
        </span>
    </li>
);

const officialFirst = (records: CentreRecord[]) =>
    records
        .filter((r) => r.kind === "warning" || r.kind === "incident" || r.kind === "disruption" || r.kind === "event")
        .sort((a, b) => b.severityRank - a.severityRank);

const metric = (r: CentreRecord, key: string) => {
    const m = r.metrics.find((x) => x.key === key);
    return m ? `${m.value}${m.unit ? ` ${m.unit}` : ""}` : "–";
};

const Observations = ({ data, limit = 8 }: { data: WallboardPayload; limit?: number }) => {
    const stations = data.observations.filter((o) => o.category === "weather").slice(0, limit);
    const others = data.observations.filter((o) => o.category !== "weather").slice(0, 4);
    if (!stations.length && !others.length) return <p className="text-xl text-tertiary">No observations in this area.</p>;
    return (
        <table className="w-full text-left text-lg">
            <thead className="text-base text-tertiary">
                <tr>
                    <th scope="col" className="pb-2 font-medium">
                        Where
                    </th>
                    <th scope="col" className="pb-2 font-medium">
                        Reading
                    </th>
                    <th scope="col" className="pb-2 font-medium">
                        Observed
                    </th>
                </tr>
            </thead>
            <tbody>
                {stations.map((s) => (
                    <tr key={s.id} className="border-t border-secondary">
                        <td className="py-1.5 pr-3 text-primary">{s.title}</td>
                        <td className="py-1.5 pr-3 text-secondary tabular-nums">
                            {metric(s, "air_temperature")} · wind {metric(s, "wind_spd_kmh")}
                            {s.metrics.some((m) => m.key === "gust_kmh") ? ` (gusts ${metric(s, "gust_kmh")})` : ""} · rain {metric(s, "rainfall")}
                        </td>
                        <td className="py-1.5 text-tertiary">{at(s.observedAt, data.timeZone)}</td>
                    </tr>
                ))}
                {others.map((s) => (
                    <tr key={s.id} className="border-t border-secondary">
                        <td className="py-1.5 pr-3 text-primary">{s.title}</td>
                        <td className="py-1.5 pr-3 text-secondary">
                            {s.status ?? s.metrics.map((m) => `${m.label} ${m.value}${m.unit ? ` ${m.unit}` : ""}`).join(" · ")}
                        </td>
                        <td className="py-1.5 text-tertiary">{at(s.observedAt, data.timeZone)}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
};

const FireDanger = ({ data }: { data: WallboardPayload }) =>
    data.fireDanger.length ? (
        <ul className="grid grid-cols-1 gap-x-6 gap-y-2 text-lg 2xl:grid-cols-2">
            {data.fireDanger.map((d) => (
                <li key={d.district} className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-primary">{d.district}</span>
                    <span className="flex items-center gap-2">
                        <FireDangerBadge rating={d.today} size="lg" />
                        {d.banToday && <span className="rounded-md bg-error-solid px-2 py-0.5 text-base font-semibold text-white">Total Fire Ban</span>}
                    </span>
                </li>
            ))}
        </ul>
    ) : (
        <p className="text-xl text-tertiary">Fire danger isn't being collected.</p>
    );

const Interpretation = ({ data }: { data: WallboardPayload }) =>
    data.interpretation?.items.length ? (
        <ul className="flex flex-col gap-2 text-xl text-secondary">
            {data.interpretation.items.map((i) => (
                <li key={i.text}>{i.text}</li>
            ))}
        </ul>
    ) : (
        <p className="text-lg text-tertiary">No interpretation prepared.</p>
    );

const BoardMap = ({ data, className }: { data: WallboardPayload; className?: string }) => (
    <CentreMap
        display
        features={data.map.features as MapFeature[]}
        layers={data.board.layers}
        frame={data.frame}
        watches={data.outline ? [{ id: "outline", name: data.areaLabel, ring: data.outline }] : []}
        label={`Map of ${data.areaLabel}. The same records are listed beside the map.`}
        className={className}
    />
);

const Layout = ({ data, layout }: { data: WallboardPayload; layout: WallboardLayout }) => {
    const official = officialFirst(data.records);
    switch (layout) {
        case "map":
            return (
                <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
                    <BoardMap data={data} className="min-h-[50vh]" />
                    <div className="flex min-h-0 flex-col gap-5">
                        <Panel title="Legend" label="Official">
                            <MapLegend large className="sm:grid-cols-1" />
                        </Panel>
                        <Panel title="Most serious" label="Official" className="flex-1">
                            <ul>
                                {official.slice(0, 5).map((r) => (
                                    <RecordLine key={r.id} r={r} timeZone={data.timeZone} />
                                ))}
                            </ul>
                        </Panel>
                    </div>
                </div>
            );
        case "weather":
            return (
                <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 lg:grid-cols-2">
                    <Panel title="Weather observations" label="Observed">
                        <Observations data={data} limit={14} />
                    </Panel>
                    <div className="flex min-h-0 flex-col gap-5">
                        <Panel title="Fire danger today" label="Official">
                            <FireDanger data={data} />
                        </Panel>
                        <Panel title="Weather and flood warnings" label="Official" className="flex-1">
                            <ul>
                                {official
                                    .filter((r) => r.category === "weather" || r.category === "flood")
                                    .slice(0, 6)
                                    .map((r) => (
                                        <RecordLine key={r.id} r={r} timeZone={data.timeZone} />
                                    ))}
                            </ul>
                            {!official.some((r) => r.category === "weather" || r.category === "flood") && (
                                <p className="text-xl text-tertiary">None in the sources collected.</p>
                            )}
                        </Panel>
                    </div>
                </div>
            );
        default:
            return (
                <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
                    <div className="flex min-h-0 flex-col gap-5">
                        <BoardMap data={data} className="min-h-[42vh] flex-1" />
                        <Panel
                            title={layout === "local" ? "Warnings and incidents here" : "Warnings and incidents in NSW"}
                            label="Official"
                            className="shrink-0"
                        >
                            {official.length ? (
                                <ul>
                                    {official.slice(0, layout === "local" ? 6 : 8).map((r) => (
                                        <RecordLine key={r.id} r={r} timeZone={data.timeZone} />
                                    ))}
                                </ul>
                            ) : (
                                <p className="text-xl text-tertiary">
                                    Nothing current in the sources collected. That isn't confirmation: follow official channels.
                                </p>
                            )}
                        </Panel>
                    </div>
                    <div className="flex min-h-0 flex-col gap-5">
                        <Panel title="Fire danger today" label="Official">
                            <FireDanger data={data} />
                        </Panel>
                        <Panel title="Weather" label="Observed">
                            <Observations data={data} limit={layout === "local" ? 4 : 6} />
                        </Panel>
                        {data.interpretation && (
                            <Panel title="Interpretation" label="Derived, not official">
                                <Interpretation data={data} />
                            </Panel>
                        )}
                    </div>
                </div>
            );
    }
};

export const DisplayApp = () => {
    const [token] = useState(() => (typeof window === "undefined" ? null : tokenFromHash(window.location.hash)));
    const { payload, status, lastSuccess } = useWallboard(token);
    const [now, setNow] = useState(() => new Date());
    const [paused, setPaused] = useState(false);
    const [index, setIndex] = useState(0);

    useEffect(() => {
        const t = setInterval(() => setNow(new Date()), 1000);
        return () => clearInterval(t);
    }, []);

    // Keep the screen awake where the browser allows it (kiosk browsers, Chrome, Safari 16.4+).
    useEffect(() => {
        let lock: { release: () => Promise<void> } | null = null;
        const request = () =>
            (navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock
                ?.request("screen")
                .then((l) => (lock = l))
                .catch(() => undefined);
        void request();
        const again = () => document.visibilityState === "visible" && void request();
        document.addEventListener("visibilitychange", again);
        return () => {
            document.removeEventListener("visibilitychange", again);
            void lock?.release().catch(() => undefined);
        };
    }, []);

    const rotation = payload?.board.rotation.length ? payload.board.rotation : null;
    useEffect(() => {
        if (!rotation || paused) return;
        const t = setInterval(() => setIndex((i) => (i + 1) % rotation.length), (payload?.board.rotationSeconds ?? 60) * 1000);
        return () => clearInterval(t);
    }, [rotation?.join(","), paused, payload?.board.rotationSeconds]);

    // A new address pasted into an open display (only the fragment changes) loads that board.
    useEffect(() => {
        const reload = () => window.location.reload();
        window.addEventListener("hashchange", reload);
        return () => window.removeEventListener("hashchange", reload);
    }, []);

    // Space or P pauses rotation (kiosk keyboards and remotes).
    useEffect(() => {
        const key = (e: KeyboardEvent) => {
            if (e.key === " " || e.key.toLowerCase() === "p") {
                e.preventDefault();
                setPaused((p) => !p);
            }
        };
        window.addEventListener("keydown", key);
        return () => window.removeEventListener("keydown", key);
    }, []);

    if (status.kind === "no_token" || (status.kind === "refused" && !payload))
        return (
            <main className="flex min-h-dvh items-center justify-center p-10 text-center">
                <div className="flex max-w-3xl flex-col gap-4">
                    <h1 className="text-4xl font-semibold text-primary">Wallboard</h1>
                    <p className="text-2xl text-tertiary">
                        {status.kind === "no_token"
                            ? "This screen needs its display address. Create one in Intelligence Centre → Wallboards and open it here."
                            : status.reason === "rate_limited"
                              ? "Too many requests from this display. It will try again shortly."
                              : "This display address isn't valid: it may have been revoked or have expired, or wallboards are switched off. It will check again every few minutes."}
                    </p>
                </div>
            </main>
        );
    if (!payload)
        return (
            <main className="flex min-h-dvh items-center justify-center">
                <p className="text-3xl text-tertiary" role="status">
                    {status.kind === "offline" ? "Can't reach the portal. Retrying…" : "Loading…"}
                </p>
            </main>
        );

    const layout: WallboardLayout = rotation ? rotation[index % rotation.length] : payload.board.layout;
    const tz = payload.timeZone;
    // Stale: no successful refresh for two intervals, or the data itself is old.
    const staleMs = Math.max(2 * payload.board.refreshSeconds * 1000, 3 * 60_000);
    const stale = status.kind === "offline" || status.kind === "refused" || (lastSuccess !== null && now.getTime() - lastSuccess > staleMs);
    const staleSources = payload.sources.filter((s) => s.status === "stale" || s.status === "error");

    return (
        <main className="flex h-dvh flex-col gap-5 overflow-hidden p-6 text-primary">
            <header className="flex flex-wrap items-end justify-between gap-4">
                <div className="flex flex-col">
                    <h1 className="text-4xl font-semibold">{payload.areaLabel}</h1>
                    <p className="text-xl text-tertiary">
                        {WALLBOARD_LAYOUT_LABELS[layout]}
                        {rotation ? ` · view ${(index % rotation.length) + 1} of ${rotation.length}` : ""} · Last refreshed{" "}
                        {lastSuccess ? clock(new Date(lastSuccess), tz) : "never"}
                    </p>
                </div>
                <div className="flex items-end gap-6">
                    {rotation && (
                        <button
                            type="button"
                            onClick={() => setPaused((p) => !p)}
                            className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-xl text-secondary ring-1 ring-primary focus-visible:outline-4 focus-visible:outline-focus-ring"
                            aria-pressed={paused}
                        >
                            {paused ? <Play aria-hidden="true" className="size-6" /> : <PauseCircle aria-hidden="true" className="size-6" />}
                            {paused ? "Resume rotation" : "Pause rotation"}
                        </button>
                    )}
                    <div className="text-right" aria-live="off">
                        <p className="text-5xl font-semibold tabular-nums">{clock(now, tz, true)}</p>
                        <p className="text-xl text-tertiary">{dayLabel(now, tz)}</p>
                    </div>
                </div>
            </header>

            {stale && (
                <div role="alert" className="flex items-center gap-3 rounded-2xl bg-warning-solid px-5 py-3 text-2xl font-semibold text-white">
                    <WifiOff aria-hidden="true" className="size-8 shrink-0" />
                    {status.kind === "refused"
                        ? "This display has stopped receiving updates (revoked, expired or switched off). What's shown is old."
                        : `Not updating: last successful refresh ${ago(lastSuccess ? new Date(lastSuccess).toISOString() : null, now.getTime())}. Reconnecting…`}
                </div>
            )}
            {payload.highlights.length > 0 && (
                <div role="alert" className="flex flex-col gap-1 rounded-2xl bg-error-solid px-5 py-3 text-white motion-safe:animate-pulse">
                    <span className="flex items-center gap-2 text-2xl font-semibold">
                        <AlertTriangle aria-hidden="true" className="size-8" />
                        Official warning changes in this area (last two hours)
                    </span>
                    <ul className="text-xl">
                        {payload.highlights.slice(0, 3).map((h) => (
                            <li key={h.id}>
                                {CHANGE_KIND_LABELS[h.kind]}: {h.summary} ({at(h.at, tz)})
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            <Layout data={payload} layout={layout} />

            <footer className="flex shrink-0 flex-col gap-1 text-base text-tertiary">
                <p className="flex flex-wrap gap-x-4 gap-y-1">
                    <span>
                        {payload.sources.filter((s) => s.status === "active").length} of {payload.sources.length} sources up to date · newest data{" "}
                        {ago(
                            payload.sources
                                .map((s) => s.lastSuccessAt)
                                .filter((x): x is string => !!x)
                                .sort()
                                .pop(),
                            now.getTime(),
                        )}
                    </span>
                    {/* Only sources with a problem are named: those are the ones to be wary of. */}
                    {staleSources.map((s) => (
                        <span key={s.id} className="font-semibold text-warning-primary">
                            {s.provider}: {s.dataset} — {SOURCE_STATUS_LABELS[s.status]}, last retrieved {ago(s.lastSuccessAt, now.getTime())}
                        </span>
                    ))}
                </p>
                <p>
                    Public information for awareness only: not an official warning service and not guaranteed real-time. Follow official warnings and
                    directions. In an emergency call Triple Zero (000).
                </p>
                <p className="text-sm text-quaternary">{[...new Set(payload.sources.map((s) => s.attribution).filter(Boolean))].join(" ")}</p>
            </footer>
        </main>
    );
};
