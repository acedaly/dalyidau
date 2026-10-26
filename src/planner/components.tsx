// Wedding Planner's building blocks: one calm column of cards (like Daly Home), each with a small
// uppercase label, compact list rows and stat tiles. Composed from Untitled UI's tokens, Badge,
// Button and empty-state patterns.
import type { FC, ReactNode } from "react";
import { AlertCircle, ArrowUpRight, ChevronRight } from "@untitledui/icons";
import { BadgeWithDot } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Skeleton } from "@/portal/components/empty";
import type { ApiError } from "@/portal/lib/api";
import type { RsvpStatus } from "@/shared/portal/types";
import { cx } from "@/utils/cx";

export const PageTitle = ({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) => (
    <div className="flex items-end justify-between gap-3 pt-2">
        <div className="min-w-0">
            <h1 className="text-display-xs font-semibold text-primary">{title}</h1>
            {subtitle && <p className="mt-0.5 text-sm text-tertiary">{subtitle}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
);

/** A card with a small uppercase label and an optional link or button on the right. */
export const Section = ({
    label,
    action,
    children,
    className,
    flush,
}: {
    label?: string;
    action?: ReactNode;
    children: ReactNode;
    className?: string;
    /** Rows reach the card's edges (lists); otherwise the card is padded. */
    flush?: boolean;
}) => {
    const id = label ? `section-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : undefined;
    return (
        <section aria-labelledby={id} className={cx("rounded-2xl bg-primary shadow-xs ring-1 ring-secondary ring-inset", !flush && "p-4", className)}>
            {(label || action) && (
                <div className={cx("flex items-center justify-between gap-3", flush ? "px-4 pt-4 pb-1" : "mb-3")}>
                    {label && (
                        <h2 id={id} className="text-xs font-semibold tracking-wide text-tertiary uppercase">
                            {label}
                        </h2>
                    )}
                    {action}
                </div>
            )}
            {children}
        </section>
    );
};

/** "All" / "Open" style links in a section header. */
export const SectionLink = ({ href, onClick, children }: { href?: string; onClick?: () => void; children: ReactNode }) =>
    href ? (
        <Button size="sm" color="link-color" href={href}>
            {children}
        </Button>
    ) : (
        <Button size="sm" color="link-color" onClick={onClick}>
            {children}
        </Button>
    );

export const StatTile = ({ label, value, tone = "default" }: { label: string; value: ReactNode; tone?: "default" | "success" | "warning" | "error" }) => (
    <div className="flex min-w-0 flex-col items-center gap-0.5 rounded-xl bg-secondary px-2 py-3 text-center">
        <span
            className={cx(
                "text-xl font-semibold text-primary tabular-nums",
                tone === "success" && "text-success-primary",
                tone === "warning" && "text-warning-primary",
                tone === "error" && "text-error-primary",
            )}
        >
            {value}
        </span>
        <span className="truncate text-xs text-tertiary">{label}</span>
    </div>
);

export const StatGrid = ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={cx("grid grid-cols-2 gap-2 min-[400px]:grid-cols-4", className)}>{children}</div>
);

export const RowList = ({ children, label }: { children: ReactNode; label?: string }) => (
    <ul aria-label={label} className="divide-y divide-secondary">
        {children}
    </ul>
);

interface RowProps {
    title: ReactNode;
    detail?: ReactNode;
    leading?: ReactNode;
    trailing?: ReactNode;
    /** Opens something: the row becomes a button (or link with href) with a chevron. */
    onPress?: () => void;
    href?: string;
    /** The link leaves the app (the full portal): an outward arrow instead of the chevron. */
    external?: boolean;
    className?: string;
    /** Inside another list item (e.g. beside a row's own checkbox, which mustn't open the row): no <li> of its own. */
    bare?: boolean;
}

export const Row = ({ title, detail, leading, trailing, onPress, href, external, className, bare }: RowProps) => {
    const body = (
        <>
            {leading && <span className="shrink-0">{leading}</span>}
            <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium text-primary">{title}</span>
                {detail && <span className="truncate text-xs text-tertiary">{detail}</span>}
            </span>
            {trailing && <span className="flex shrink-0 items-center gap-2">{trailing}</span>}
            {external ? (
                <ArrowUpRight aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
            ) : (
                (onPress || href) && <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
            )}
        </>
    );
    const classes = cx("flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left", className);
    const interactive = "outline-focus-ring transition duration-100 ease-linear hover:bg-primary_hover focus-visible:outline-2 focus-visible:-outline-offset-2";
    const row = href ? (
        <a href={href} className={cx(classes, interactive)}>
            {body}
        </a>
    ) : onPress ? (
        <button type="button" onClick={onPress} className={cx(classes, interactive, "cursor-pointer")}>
            {body}
        </button>
    ) : (
        <div className={classes}>{body}</div>
    );
    return bare ? row : <li>{row}</li>;
};

export const RSVP_LABELS: Record<RsvpStatus | "not_invited", string> = {
    attending: "Coming",
    declined: "Declined",
    pending: "Awaiting",
    not_invited: "Not invited",
};

export const RsvpBadge = ({ status }: { status: RsvpStatus | "not_invited" }) => (
    <BadgeWithDot
        size="sm"
        type="pill-color"
        color={status === "attending" ? "success" : status === "declined" ? "error" : status === "pending" ? "warning" : "gray"}
    >
        {RSVP_LABELS[status]}
    </BadgeWithDot>
);

export const LoadingRows = ({ rows = 4 }: { rows?: number }) => (
    <div className="flex flex-col gap-3 p-4" aria-label="Loading" role="status">
        {Array.from({ length: rows }, (_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
        ))}
    </div>
);

/** A load that failed: the server's message and a retry. A module that's switched off says so. */
export const LoadError = ({ error, onRetry }: { error: ApiError; onRetry: () => void }) => (
    <div className="flex items-start gap-3 p-4" role="alert">
        <AlertCircle aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-fg-error-secondary" />
        <div className="flex min-w-0 flex-col gap-2">
            <p className="text-sm text-secondary">{error.code === "module_off" ? "This part of the Wedding Planner is switched off." : error.message}</p>
            {error.code !== "module_off" && error.status !== 403 && (
                <Button size="sm" color="secondary" onClick={onRetry} className="self-start">
                    Try again
                </Button>
            )}
        </div>
    </div>
);

export const EmptyRow = ({ icon: Icon, children }: { icon: FC<{ className?: string }>; children: ReactNode }) => (
    <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
        <Icon aria-hidden="true" className="size-6 text-fg-quaternary" />
        <p className="text-sm text-tertiary">{children}</p>
    </div>
);
