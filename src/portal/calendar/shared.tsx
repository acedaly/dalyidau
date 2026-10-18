// Pieces every Calendar page shares: the page header with its notifications, the failing
// subscriptions notice, colour swatches and small formatting helpers. Built from Untitled UI's
// page header, dropdown, badges and the PRO calendar's event colours.
import { type ReactNode, useState } from "react";
import { AlertTriangle, Bell01, X } from "@untitledui/icons";
import { Button as AriaButton, Dialog as AriaDialog, DialogTrigger as AriaDialogTrigger, Popover as AriaPopover } from "react-aria-components";
import { eventViewColors } from "@/components/application/calendar/base-components/calendar-month-view-event";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Notice } from "@/portal/components/notice";
import { PageHeader } from "@/portal/components/page-header";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import { formatRelative } from "@/portal/lib/format";
import { CALENDAR_COLORS, type CalendarColor, type CalendarNotification, type CalendarShell } from "@/shared/calendar/types";
import { cx } from "@/utils/cx";
import { calendarApi } from "./api";

export const COLOR_LABELS: Record<CalendarColor, string> = {
    brand: "Purple",
    blue: "Blue",
    indigo: "Indigo",
    purple: "Violet",
    pink: "Pink",
    orange: "Orange",
    yellow: "Yellow",
    green: "Green",
    gray: "Grey",
};

export const ColorDot = ({ color, className }: { color: CalendarColor; className?: string }) => (
    <span aria-hidden="true" className={cx("inline-block size-2.5 shrink-0 rounded-full", eventViewColors[color].dot, className)} />
);

/** A row of colour choices, as radio buttons. */
export const ColorPicker = ({ value, onChange, label = "Colour" }: { value: CalendarColor; onChange: (color: CalendarColor) => void; label?: string }) => (
    <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-sm font-medium text-secondary">{label}</legend>
        <div className="flex flex-wrap gap-2">
            {CALENDAR_COLORS.map((c) => (
                <label key={c} className="relative cursor-pointer">
                    <input type="radio" name={label} value={c} checked={value === c} onChange={() => onChange(c)} className="peer sr-only" />
                    <span
                        className={cx(
                            "flex size-8 items-center justify-center rounded-full ring-1 ring-secondary transition duration-100 ease-linear ring-inset",
                            "peer-checked:ring-2 peer-checked:ring-brand peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus-ring",
                        )}
                    >
                        <ColorDot color={c} className="size-4" />
                    </span>
                    <span className="sr-only">{COLOR_LABELS[c]}</span>
                </label>
            ))}
        </div>
    </fieldset>
);

const NotificationsButton = ({ initial }: { initial: CalendarNotification[] }) => {
    const [items, setItems] = useState(initial);
    const toast = useToast();
    const dismiss = async (id: string | "all") => {
        try {
            setItems((await calendarApi.dismiss(id)).notifications);
        } catch (error) {
            toast.error("Couldn't dismiss that", errorMessage(error));
        }
    };
    return (
        <AriaDialogTrigger>
            <AriaButton
                aria-label={items.length ? `Notifications, ${items.length} new` : "Notifications"}
                className="relative flex size-10 cursor-pointer items-center justify-center rounded-lg text-fg-quaternary ring-1 ring-primary outline-focus-ring transition duration-100 ease-linear ring-inset hover:bg-primary_hover hover:text-fg-quaternary_hover focus-visible:outline-2 focus-visible:outline-offset-2"
            >
                <Bell01 aria-hidden="true" className="size-5" />
                {items.length > 0 && (
                    <span className="absolute -top-1 -right-1 flex min-w-4.5 items-center justify-center rounded-full bg-fg-error-primary px-1 text-[10px] font-bold text-white">
                        {items.length > 9 ? "9+" : items.length}
                    </span>
                )}
            </AriaButton>
            <AriaPopover
                placement="bottom end"
                className="w-[min(22rem,calc(100vw-2rem))] rounded-xl bg-primary shadow-lg ring-1 ring-secondary_alt outline-hidden"
            >
                <AriaDialog aria-label="Calendar notifications" className="outline-hidden">
                    <div className="flex items-center justify-between border-b border-secondary px-4 py-3">
                        <h2 className="text-sm font-semibold text-primary">Notifications</h2>
                        {items.length > 0 && (
                            <Button size="sm" color="link-gray" onClick={() => void dismiss("all")}>
                                Dismiss all
                            </Button>
                        )}
                    </div>
                    {items.length ? (
                        <ul className="max-h-96 divide-y divide-secondary overflow-y-auto">
                            {items.map((n) => (
                                <li key={n.id} className="flex items-start gap-3 px-4 py-3">
                                    <div className="min-w-0 flex-1">
                                        {n.url ? (
                                            <a href={n.url} className="text-sm font-medium text-primary hover:underline">
                                                {n.title}
                                            </a>
                                        ) : (
                                            <p className="text-sm font-medium text-primary">{n.title}</p>
                                        )}
                                        {n.detail && <p className="text-sm text-tertiary">{n.detail}</p>}
                                        <p className="mt-0.5 text-xs text-quaternary">{formatRelative(n.fireAt)}</p>
                                    </div>
                                    <ButtonUtility size="xs" color="tertiary" icon={X} tooltip="Dismiss" onClick={() => void dismiss(n.id)} />
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="px-4 py-6 text-center text-sm text-tertiary">Nothing new. Reminders, upcoming leave and school holidays appear here.</p>
                    )}
                </AriaDialog>
            </AriaPopover>
        </AriaDialogTrigger>
    );
};

/** The header on every Calendar page: breadcrumbs, title, actions and the notifications button. */
export const CalendarHeader = ({
    shell,
    title,
    description,
    crumb,
    actions,
    children,
}: {
    shell: CalendarShell;
    title: string;
    description?: ReactNode;
    crumb?: { label: string; href?: string };
    actions?: ReactNode;
    children?: ReactNode;
}) => (
    <>
        <PageHeader
            title={title}
            description={description}
            breadcrumbs={[{ label: "Daly Calendar", href: "/portal/calendar" }, ...(crumb ? [crumb] : [])]}
            actions={
                <>
                    {actions}
                    <NotificationsButton initial={shell.notifications} />
                </>
            }
        >
            {children}
        </PageHeader>
        {shell.failingSubscriptions > 0 && (
            <Notice
                color="warning"
                title={`${shell.failingSubscriptions === 1 ? "A calendar subscription isn't" : `${shell.failingSubscriptions} calendar subscriptions aren't`} updating`}
                actions={
                    <Button size="sm" color="secondary" href="/portal/calendar/subscriptions" iconLeading={AlertTriangle}>
                        See subscriptions
                    </Button>
                }
            >
                Their events may be out of date. The last copy is still shown, and they'll keep being tried.
            </Notice>
        )}
    </>
);

/** A white card with a heading, used for settings and summaries. */
export const Card = ({
    title,
    description,
    actions,
    children,
    className,
}: {
    title?: string;
    description?: ReactNode;
    actions?: ReactNode;
    children: ReactNode;
    className?: string;
}) => (
    <section className={cx("flex min-w-0 flex-col gap-4 rounded-xl bg-primary p-4 shadow-xs ring-1 ring-secondary ring-inset sm:p-5", className)}>
        {(title || actions) && (
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                    {title && <h2 className="text-md font-semibold text-primary">{title}</h2>}
                    {description && <div className="text-sm text-tertiary">{description}</div>}
                </div>
                {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
            </div>
        )}
        {children}
    </section>
);

export const REMINDER_CHOICES = [
    { minutes: 0, label: "At the start" },
    { minutes: 10, label: "10 minutes before" },
    { minutes: 30, label: "30 minutes before" },
    { minutes: 60, label: "1 hour before" },
    { minutes: 120, label: "2 hours before" },
    { minutes: 1440, label: "1 day before" },
    { minutes: 2880, label: "2 days before" },
    { minutes: 10080, label: "1 week before" },
];

export const reminderLabel = (minutes: number) =>
    REMINDER_CHOICES.find((c) => c.minutes === minutes)?.label ??
    (minutes % 1440 === 0 ? `${minutes / 1440} days before` : minutes % 60 === 0 ? `${minutes / 60} hours before` : `${minutes} minutes before`);

export const TIME_ZONES = [
    "Australia/Sydney",
    "Australia/Melbourne",
    "Australia/Brisbane",
    "Australia/Adelaide",
    "Australia/Darwin",
    "Australia/Perth",
    "Australia/Hobart",
    "Australia/Lord_Howe",
    "Pacific/Auckland",
    "Asia/Singapore",
    "Asia/Tokyo",
    "Europe/London",
    "America/Los_Angeles",
    "America/New_York",
    "UTC",
];

/** Downloads a file from the API through fetch, so a failure shows a message instead of an error page. */
export async function download(path: string) {
    const response = await fetch(path, { credentials: "same-origin" });
    if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `The download failed (${response.status})`);
    }
    const name = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ?? "download";
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
