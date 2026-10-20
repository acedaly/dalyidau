// Wallboard display (/display#t=…): a full-screen, read-only view of one wallboard for a monitor,
// TV or kiosk, with no portal navigation (docs/INTELLIGENCE_CENTRE_9_1.md#display-behaviour).
//
// The display credential stays in the URL fragment (never sent to a server) and goes to the
// Worker only in the Authorization header. The page refreshes on the wallboard's interval, keeps
// the last good data through network failures, and says plainly and prominently when what it shows
// is stale. Official warnings in the board's area are pinned above every view and never covered.
// Official, observed and derived panels are labelled apart. It's not an official warning service
// or guaranteed real-time monitoring, and says so on screen.
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Maximize01, PauseCircle, Play, WifiOff } from "@untitledui/icons";
import { PRESET_LABELS } from "@/shared/centre/wallboard";
import { cx } from "@/utils/cx";
import { ago, clock, dayLabel } from "./display-format";
import { AlertStrip, DisplayView } from "./display-view";
import "./display.css";
import { tokenFromHash, useWallboard } from "./use-wallboard";

export { tokenFromHash, useWallboard };

// Sized by the smaller of width and height, so ultrawide screens don't get oversized text:
// about 17 px at 1080p, 22 px at 1440p, 34 px at 4K.
const BASE_FONT = "clamp(14px, min(0.88vw, 1.6vh), 40px)";

const HeaderButton = ({ onClick, pressed, label, icon: Icon }: { onClick: () => void; pressed?: boolean; label: string; icon: typeof Play }) => (
    <button
        type="button"
        onClick={onClick}
        aria-pressed={pressed}
        aria-label={label}
        title={label}
        className="flex cursor-pointer items-center justify-center rounded-lg p-[0.45rem] text-secondary ring-1 ring-primary transition duration-100 ease-linear hover:bg-primary_hover focus-visible:outline-4 focus-visible:outline-focus-ring"
    >
        <Icon aria-hidden="true" className="size-[1.4rem]" />
    </button>
);

export const DisplayApp = () => {
    const [initial] = useState(() => (typeof window === "undefined" ? null : tokenFromHash(window.location.hash)));
    const { payload, status, lastSuccess, token } = useWallboard(initial);
    const [now, setNow] = useState(() => Date.now());
    const [paused, setPaused] = useState(false);
    const [index, setIndex] = useState(0);
    const [fade, setFade] = useState(false);
    const [shift, setShift] = useState<[number, number]>([0, 0]);
    const [fullscreenNote, setFullscreenNote] = useState<string | null>(null);

    useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), 1000);
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

    // Theme and type size: the resolution-based size, times the board's own scale.
    const theme = payload?.board.theme ?? "dark";
    const scale = payload?.board.scale ?? 100;
    useEffect(() => {
        document.documentElement.classList.toggle("wb-hc", theme === "high_contrast");
        document.documentElement.style.fontSize = scale === 100 ? BASE_FONT : `calc(${BASE_FONT} * ${scale / 100})`;
    }, [theme, scale]);

    const views = payload?.views ?? [];
    const rotating = !!payload?.board.rotate && views.length > 1;
    const show = (next: (i: number) => number) => {
        // A short fade where the viewer hasn't asked for less motion; an instant switch otherwise.
        setFade(true);
        setTimeout(() => {
            setIndex((i) => (views.length ? (next(i) + views.length) % views.length : 0));
            setFade(false);
        }, 150);
    };
    useEffect(() => {
        if (!rotating || paused) return;
        const t = setInterval(() => show((i) => i + 1), (payload?.board.rotationSeconds ?? 60) * 1000);
        return () => clearInterval(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rotating, paused, payload?.board.rotationSeconds, views.length]);

    // Burn-in mitigation for OLED and plasma screens: the whole picture moves a few pixels every few minutes.
    useEffect(() => {
        if (!payload?.board.burnIn) return setShift([0, 0]);
        const steps: [number, number][] = [
            [0, 0],
            [3, 1],
            [1, 3],
            [-2, 2],
            [-3, -1],
            [0, -3],
        ];
        let i = 0;
        const t = setInterval(() => setShift(steps[++i % steps.length]), 3 * 60_000);
        return () => clearInterval(t);
    }, [payload?.board.burnIn]);

    // A new address pasted into an open display (only the fragment changes) loads that board. A
    // renewal replaces the address itself without firing this.
    useEffect(() => {
        const reload = () => window.location.reload();
        window.addEventListener("hashchange", reload);
        return () => window.removeEventListener("hashchange", reload);
    }, []);

    const fullscreen = () => {
        const el = document.documentElement;
        if (document.fullscreenElement) return void document.exitFullscreen().catch(() => undefined);
        if (!el.requestFullscreen) return setFullscreenNote("This browser can't go full screen from the page: use its own full-screen or kiosk mode.");
        el.requestFullscreen().then(
            () => setFullscreenNote(null),
            () => setFullscreenNote("Full screen needs a click or key press on this screen (browsers don't allow it automatically)."),
        );
    };

    // Keyboards and remotes: Space or P pauses rotation, arrows move between views, F goes full screen.
    useEffect(() => {
        const key = (e: KeyboardEvent) => {
            const k = e.key.toLowerCase();
            if (k === " " || k === "p") {
                e.preventDefault();
                setPaused((p) => !p);
            } else if (k === "arrowright") show((i) => i + 1);
            else if (k === "arrowleft") show((i) => i - 1);
            else if (k === "f") fullscreen();
        };
        window.addEventListener("keydown", key);
        return () => window.removeEventListener("keydown", key);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [views.length]);

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

    const tz = payload.timeZone;
    const current = views.length ? index % views.length : 0;
    const view = views[current];
    // Stale: no successful refresh for two intervals (at least 3 minutes), or refused.
    const staleMs = Math.max(2 * payload.board.refreshSeconds * 1000, 3 * 60_000);
    const stale = status.kind === "offline" || status.kind === "refused" || (lastSuccess !== null && now - lastSuccess > staleMs);
    const problems = payload.sources.filter((s) => s.status === "stale" || s.status === "error");
    const hc = theme === "high_contrast";

    return (
        <main
            className="flex min-h-dvh flex-col gap-[0.6rem] p-[1rem] text-primary lg:landscape:h-dvh lg:landscape:overflow-hidden"
            style={shift[0] || shift[1] ? { transform: `translate(${shift[0]}px, ${shift[1]}px)` } : undefined}
        >
            <header className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-4">
                <div className="flex min-w-0 flex-col">
                    <h1 className="truncate text-[1.9rem] leading-tight font-semibold">{payload.board.name}</h1>
                    <p className="truncate text-base text-tertiary">
                        {view ? `${view.name || PRESET_LABELS[view.preset]} · view ${current + 1} of ${views.length}` : "No views"}
                        {rotating && paused ? " · rotation paused" : ""} · Last refreshed {lastSuccess ? clock(new Date(lastSuccess), tz) : "never"}
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    {views.length > 1 && (
                        <>
                            <HeaderButton onClick={() => show((i) => i - 1)} label="Previous view" icon={ChevronLeft} />
                            <HeaderButton onClick={() => show((i) => i + 1)} label="Next view" icon={ChevronRight} />
                        </>
                    )}
                    {rotating && (
                        <HeaderButton
                            onClick={() => setPaused((p) => !p)}
                            pressed={paused}
                            label={paused ? "Resume rotation" : "Pause rotation"}
                            icon={paused ? Play : PauseCircle}
                        />
                    )}
                    <HeaderButton onClick={fullscreen} label="Full screen" icon={Maximize01} />
                </div>
                {payload.board.clock ? (
                    <div className="text-right" aria-live="off">
                        <p className="text-[2.3rem] leading-none font-semibold whitespace-nowrap tabular-nums">{clock(new Date(now), tz, true)}</p>
                        <p className="text-base whitespace-nowrap text-tertiary">{dayLabel(new Date(now), tz)}</p>
                    </div>
                ) : (
                    <span />
                )}
            </header>
            {fullscreenNote && (
                <p role="status" className="shrink-0 text-base text-warning-primary">
                    {fullscreenNote}
                </p>
            )}

            {stale && (
                <div role="alert" className="flex shrink-0 items-center gap-3 rounded-2xl bg-warning-solid px-4 py-2 text-[1.3rem] font-semibold text-white">
                    <WifiOff aria-hidden="true" className="size-7 shrink-0" />
                    {status.kind === "refused"
                        ? "This display has stopped receiving updates (revoked, expired or switched off). What's shown is old."
                        : `Not updating: last successful refresh ${ago(lastSuccess ? new Date(lastSuccess).toISOString() : null, now)}. Reconnecting…`}
                </div>
            )}
            <AlertStrip alerts={payload.alerts} timeZone={tz} />

            <DisplayView
                payload={payload}
                viewIndex={current}
                ctx={{ timeZone: tz, areaLabel: payload.areaLabel, now, hc, token, basemap: payload.basemap, flavor: hc ? "black" : "dark" }}
                className={cx("motion-safe:transition-opacity motion-safe:duration-300", fade ? "motion-safe:opacity-0" : "opacity-100")}
            />

            <footer className="flex shrink-0 flex-col gap-0.5 text-sm text-tertiary">
                <p className="flex flex-wrap gap-x-3 gap-y-0.5">
                    <span>
                        {payload.sources.filter((s) => s.status === "active").length} of {payload.sources.length} sources up to date · newest data{" "}
                        {ago(
                            payload.sources
                                .map((s) => s.lastSuccessAt)
                                .filter((x): x is string => !!x)
                                .sort()
                                .pop(),
                            now,
                        )}
                    </span>
                    {/* Only sources with a problem are named: those are the ones to be wary of. */}
                    {problems.map((s) => (
                        <span key={s.id} className="font-semibold text-warning-primary">
                            {s.provider}: {s.dataset}, last retrieved {ago(s.lastSuccessAt, now)}
                        </span>
                    ))}
                    <span>
                        Public information for awareness only: not an official warning service and not guaranteed real-time. Follow official warnings and
                        directions. In an emergency call Triple Zero (000).
                    </span>
                </p>
                <p className="line-clamp-2 text-[0.68rem] leading-snug text-quaternary">
                    {[...new Set(payload.sources.map((s) => s.attribution).filter(Boolean))].join(" ")}
                    {payload.basemap.kind === "detailed" ? ` Map: ${payload.basemap.attribution}` : " Map: Natural Earth."}
                </p>
            </footer>
        </main>
    );
};
