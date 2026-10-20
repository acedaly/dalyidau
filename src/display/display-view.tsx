// One wallboard view laid out on its 12 × 12 grid, and the strip of official warnings pinned above
// every view. Shared by the display itself and the layout editor's preview.
//
// On landscape screens at least 1024 px wide the grid fills the space between the header (and the
// warning strip) and the footer exactly; on narrower or portrait screens the widgets stack in
// reading order with their natural heights, and the page scrolls.
import type { CSSProperties } from "react";
import { AlertTriangle } from "@untitledui/icons";
import type { DisplayAlert, WallboardPayloadV2 } from "@/shared/centre/wallboard";
import { cx } from "@/utils/cx";
import { at, readableLink } from "./display-format";
import { Widget, type WidgetContext } from "./display-widgets";

export const DisplayView = ({
    payload,
    viewIndex,
    ctx,
    className,
}: {
    payload: WallboardPayloadV2;
    viewIndex: number;
    ctx: WidgetContext;
    className?: string;
}) => {
    const view = payload.views[viewIndex % Math.max(1, payload.views.length)];
    if (!view) return <p className="text-xl text-tertiary">This wallboard has no views yet.</p>;
    const ordered = [...view.widgets].sort((a, b) => a.y - b.y || a.x - b.x);
    return (
        <div className={cx("grid min-h-0 flex-1 grid-cols-1 gap-[0.6rem] lg:landscape:grid-cols-12 lg:landscape:grid-rows-12", className)}>
            {ordered.map((w) => (
                <div
                    key={w.id}
                    className={cx(
                        "min-h-0 min-w-0 lg:landscape:[grid-column:var(--wb-col)] lg:landscape:[grid-row:var(--wb-row)]",
                        w.type === "map" && "min-h-[50vh] lg:landscape:min-h-0",
                    )}
                    style={{ "--wb-col": `${w.x + 1} / span ${w.w}`, "--wb-row": `${w.y + 1} / span ${w.h}` } as CSSProperties}
                >
                    <Widget data={payload.data[`${view.id}:${w.id}`]} ctx={ctx} />
                </div>
            ))}
        </div>
    );
};

/** Official warnings in force and recent official changes in the board's area: never covered by a widget. */
export const AlertStrip = ({ alerts, timeZone, compact = false }: { alerts: DisplayAlert[]; timeZone: string; compact?: boolean }) => {
    if (!alerts.length) return null;
    const emergency = alerts.some((a) => a.rank >= 3);
    return (
        <section
            role="alert"
            aria-label="Official warnings in this area"
            className={cx(
                "flex shrink-0 flex-col gap-1 rounded-2xl px-4 py-2 text-white",
                emergency ? "bg-error-solid" : "bg-warning-solid",
                emergency && "motion-safe:animate-pulse motion-safe:[animation-iteration-count:3]",
            )}
        >
            <p className="flex items-center gap-2 text-[1.3rem] font-semibold">
                <AlertTriangle aria-hidden="true" className="size-7 shrink-0" />
                {emergency ? "Emergency Warning in this area" : "Official warning changes in this area (last two hours)"}
                <span className="text-base font-normal">· Official information as published. Follow the official source.</span>
            </p>
            <ul className={cx("grid gap-x-6 gap-y-1", !compact && alerts.length > 1 && "lg:grid-cols-2")}>
                {alerts.slice(0, compact ? 2 : 4).map((a) => (
                    <li key={a.id} className="flex min-w-0 flex-col text-base">
                        <span className="truncate font-semibold">
                            {a.level ? `${a.level}: ` : ""}
                            {a.title}
                        </span>
                        <span className="truncate">
                            {a.change ? `${a.change} · ` : ""}
                            {a.provider} · published {at(a.publishedAt, timeZone)}
                            {a.updatedAt && a.updatedAt !== a.publishedAt ? ` · updated ${at(a.updatedAt, timeZone)}` : ""}
                            {a.sourceUrl ? ` · ${readableLink(a.sourceUrl)}` : ""}
                        </span>
                    </li>
                ))}
            </ul>
        </section>
    );
};
