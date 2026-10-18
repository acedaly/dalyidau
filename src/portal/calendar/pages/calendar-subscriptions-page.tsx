// External calendar subscriptions: paste an ICS or webcal address (Google, Apple, Outlook, a school,
// a sports club, public holidays) and its events appear here, read-only, refreshed about every six
// hours. A subscription stays in step with its source; a one-time import (Settings) is a copy.
import { useState } from "react";
import { AlertCircle, CheckCircle, Plus, RefreshCw01, Rss01, Trash01 } from "@untitledui/icons";
import { BadgeWithDot } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { Toggle } from "@/components/base/toggle/toggle";
import { ConfirmDialog } from "@/portal/components/dialog";
import { Empty } from "@/portal/components/empty";
import { FormError } from "@/portal/components/form";
import { Notice } from "@/portal/components/notice";
import { useToast } from "@/portal/components/toast";
import { ApiError, errorMessage } from "@/portal/lib/api";
import { formatRelative } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import type { CalendarColor, SubscriptionInfo } from "@/shared/calendar/types";
import { calendarApi, clientId } from "../api";
import { CalendarHeader, Card, ColorDot, ColorPicker } from "../shared";

const INTERVALS = [
    { id: "60", label: "Every hour" },
    { id: "180", label: "Every 3 hours" },
    { id: "360", label: "Every 6 hours (recommended)" },
    { id: "720", label: "Every 12 hours" },
    { id: "1440", label: "Once a day" },
    { id: "10080", label: "Once a week" },
];

const PROVIDER_LABELS: Record<SubscriptionInfo["provider"], string> = {
    google: "Google Calendar",
    apple: "Apple iCloud",
    outlook: "Outlook",
    other: "Web calendar",
};

const Status = ({ s }: { s: SubscriptionInfo }) => {
    if (!s.enabled)
        return (
            <BadgeWithDot size="sm" color="gray">
                Paused
            </BadgeWithDot>
        );
    if (s.consecutiveFailures > 0 || s.lastStatus === "error")
        return (
            <BadgeWithDot size="sm" color="error">
                {s.consecutiveFailures > 1 ? `Failing (${s.consecutiveFailures} tries)` : "Last refresh failed"}
            </BadgeWithDot>
        );
    if (!s.lastSuccessAt)
        return (
            <BadgeWithDot size="sm" color="warning">
                Waiting for first refresh
            </BadgeWithDot>
        );
    return (
        <BadgeWithDot size="sm" color="success">
            Up to date
        </BadgeWithDot>
    );
};

const SubscriptionCard = ({ initial, onRemoved }: { initial: SubscriptionInfo; onRemoved: () => void }) => {
    const toast = useToast();
    const [s, setS] = useState(initial);
    const [refreshing, setRefreshing] = useState(false);
    const [confirm, setConfirm] = useState(false);
    const [name, setName] = useState(s.name);
    const update = async (body: { name?: string; color?: CalendarColor; kind?: "personal" | "shared"; enabled?: boolean; refreshMinutes?: number }) => {
        try {
            setS((await calendarApi.updateSubscription(s.id, { ...body, version: s.version })).subscription);
        } catch (error) {
            toast.error("Couldn't save that", errorMessage(error));
        }
    };
    const refresh = async () => {
        setRefreshing(true);
        try {
            const { subscription } = await calendarApi.refreshSubscription(s.id);
            setS(subscription);
            if (subscription.lastStatus === "error") toast.error("The refresh failed", subscription.lastError ?? undefined);
            else
                toast.success(
                    subscription.lastStatus === "not_modified" ? "No changes since the last refresh" : `Refreshed: ${subscription.eventCount} events`,
                );
        } catch (error) {
            toast.error("Couldn't refresh", errorMessage(error));
        } finally {
            setRefreshing(false);
        }
    };
    return (
        <Card
            title={s.name}
            description={
                <span className="flex flex-wrap items-center gap-2">
                    <ColorDot color={s.color} />
                    {PROVIDER_LABELS[s.provider]} · <span className="font-mono text-xs">{s.urlDisplay}</span> · {s.kind === "shared" ? "shared" : "personal"}
                </span>
            }
            actions={<Status s={s} />}
        >
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div>
                    <dt className="text-xs text-quaternary">Last updated</dt>
                    <dd className="text-secondary">{s.lastSuccessAt ? formatRelative(s.lastSuccessAt) : "Never"}</dd>
                </div>
                <div>
                    <dt className="text-xs text-quaternary">Events</dt>
                    <dd className="text-secondary">{s.eventCount}</dd>
                </div>
                <div>
                    <dt className="text-xs text-quaternary">Next refresh</dt>
                    <dd className="text-secondary">{s.enabled ? formatRelative(s.nextRefreshAt) : "Paused"}</dd>
                </div>
                <div>
                    <dt className="text-xs text-quaternary">Last tried</dt>
                    <dd className="text-secondary">{s.lastAttemptAt ? formatRelative(s.lastAttemptAt) : "Never"}</dd>
                </div>
            </dl>
            {s.lastError && (
                <p role="status" className="flex items-start gap-2 rounded-lg bg-error-primary p-3 text-sm text-error-primary">
                    <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                    {s.lastError}
                </p>
            )}
            {s.canManage ? (
                <div className="flex flex-col gap-4 border-t border-secondary pt-4">
                    <div className="flex flex-wrap items-end gap-3">
                        <Input
                            label="Name"
                            size="sm"
                            value={name}
                            onChange={setName}
                            className="min-w-48 flex-1"
                            onBlur={() => name.trim() && name !== s.name && void update({ name })}
                        />
                        <Select
                            size="sm"
                            label="Refresh"
                            className="w-60"
                            value={String(s.refreshMinutes)}
                            onChange={(k) => k && void update({ refreshMinutes: Number(k) })}
                            items={INTERVALS}
                        >
                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                        </Select>
                        <Select
                            size="sm"
                            label="Who sees it"
                            className="w-48"
                            value={s.kind}
                            onChange={(k) => k && void update({ kind: k as "personal" | "shared" })}
                            items={[
                                { id: "personal", label: "Only me" },
                                { id: "shared", label: "Shared calendar" },
                            ]}
                        >
                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                        </Select>
                    </div>
                    <ColorPicker value={s.color} onChange={(color: CalendarColor) => void update({ color })} />
                    <div className="flex flex-wrap items-center gap-4">
                        <Toggle label="Keep refreshing" isSelected={s.enabled} onChange={(enabled) => void update({ enabled })} />
                        <Toggle
                            label="Show in my calendar"
                            isSelected={!s.hidden}
                            onChange={async (shown) => {
                                await calendarApi.personal(s.calendarId, { hidden: !shown });
                                setS({ ...s, hidden: !shown });
                            }}
                        />
                        <span className="flex-1" />
                        <Button
                            size="sm"
                            color="secondary"
                            iconLeading={RefreshCw01}
                            isLoading={refreshing}
                            showTextWhileLoading
                            onClick={() => void refresh()}
                        >
                            Refresh now
                        </Button>
                        <Button size="sm" color="secondary-destructive" iconLeading={Trash01} onClick={() => setConfirm(true)}>
                            Remove
                        </Button>
                    </div>
                    {s.kind === "shared" && (
                        <p className="text-sm text-tertiary">
                            Choose who can see it in{" "}
                            <a href="/portal/calendar/calendars" className="font-medium text-brand-secondary hover:underline">
                                Calendars and sharing
                            </a>
                            . They can view it but never see its address.
                        </p>
                    )}
                </div>
            ) : (
                <p className="text-sm text-tertiary">Shared with you. Only the person who added it can change or remove it.</p>
            )}
            <ConfirmDialog
                isOpen={confirm}
                onOpenChange={setConfirm}
                title={`Remove ${s.name}?`}
                description="Its events disappear from Daly Calendar for everyone it's shared with. The calendar itself, wherever it comes from, isn't touched."
                confirmLabel="Remove"
                destructive
                onConfirm={async () => {
                    await calendarApi.unsubscribe(s.id);
                    setConfirm(false);
                    onRemoved();
                }}
            />
        </Card>
    );
};

export const CalendarSubscriptionsPage = ({ data }: { data: PageData<"calendar-subscriptions"> }) => {
    const toast = useToast();
    const [subs, setSubs] = useState(data.subscriptions);
    const [url, setUrl] = useState("");
    const [name, setName] = useState("");
    const [kind, setKind] = useState<"personal" | "shared">("personal");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [requestId] = useState(clientId);

    const add = async () => {
        setBusy(true);
        setError(null);
        try {
            const { subscription } = await calendarApi.subscribe({ url, ...(name.trim() ? { name: name.trim() } : {}), kind, clientId: requestId });
            setSubs([subscription, ...subs.filter((s) => s.id !== subscription.id)]);
            setUrl("");
            setName("");
            toast.success("Subscribed", subscription.lastSuccessAt ? `${subscription.eventCount} events added` : "It will be fetched shortly");
        } catch (e) {
            setError(e instanceof ApiError ? e.message : errorMessage(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <CalendarHeader
                shell={data}
                title="Subscriptions"
                description="Calendars from elsewhere (Google, Apple, Outlook, school, sport, public holidays), kept up to date automatically. Their events are read-only here."
                crumb={{ label: "Subscriptions" }}
            />
            <Card
                title="Add a subscription"
                description="Paste the calendar's ICS or webcal address. It's treated as a password: stored securely, never shown again in full, and never sent anywhere but the calendar it came from."
            >
                <form
                    className="flex flex-col gap-4"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void add();
                    }}
                >
                    <FormError message={error} />
                    <Input
                        label="Calendar address"
                        isRequired
                        placeholder="webcal://… or https://….ics"
                        value={url}
                        onChange={setUrl}
                        type="url"
                        icon={Rss01}
                    />
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <Input label="Name" placeholder="Uses the calendar's own name if empty" value={name} onChange={setName} />
                        <Select
                            label="Who sees it"
                            value={kind}
                            onChange={(k) => k && setKind(k as "personal" | "shared")}
                            items={[
                                { id: "personal", label: "Only me" },
                                { id: "shared", label: "Shared calendar (choose people afterwards)" },
                            ]}
                        >
                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                        </Select>
                    </div>
                    <div>
                        <Button type="submit" size="md" iconLeading={Plus} isLoading={busy} showTextWhileLoading isDisabled={url.trim().length < 8}>
                            Subscribe
                        </Button>
                    </div>
                </form>
                <details className="bg-secondary_subtle rounded-lg p-3 text-sm text-tertiary">
                    <summary className="cursor-pointer font-medium text-secondary">Where to find a calendar's address</summary>
                    <ul className="mt-2 list-disc space-y-1 pl-5">
                        <li>
                            <strong>Google Calendar:</strong> Settings → the calendar → Integrate calendar → “Secret address in iCal format” (or the public
                            address for a public calendar).
                        </li>
                        <li>
                            <strong>Apple iCloud:</strong> Calendar → the calendar's share button → Public Calendar → copy the webcal link.
                        </li>
                        <li>
                            <strong>Outlook / Microsoft 365:</strong> Settings → Calendar → Shared calendars → Publish a calendar → copy the ICS link.
                        </li>
                        <li>
                            <strong>Schools, clubs and holidays:</strong> look for “Subscribe”, “iCal” or “Add to calendar”. Only https and webcal addresses
                            work.
                        </li>
                    </ul>
                    <p className="mt-2">To copy events in once without keeping them in step, use Import in Settings instead.</p>
                </details>
            </Card>
            {subs.length ? (
                <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                    {subs.map((s) => (
                        <SubscriptionCard key={s.id} initial={s} onRemoved={() => setSubs(subs.filter((x) => x.id !== s.id))} />
                    ))}
                </div>
            ) : (
                <div className="rounded-xl bg-primary px-6 py-12 shadow-xs ring-1 ring-secondary ring-inset">
                    <Empty
                        icon={Rss01}
                        title="No subscriptions yet"
                        description="Add a school calendar, a team's fixtures or a shared family calendar from another app."
                    />
                </div>
            )}
            {subs.some((s) => s.lastStatus === "ok") && (
                <Notice color="success" title="Refreshed automatically">
                    <span className="flex items-center gap-1">
                        <CheckCircle aria-hidden="true" className="size-4" /> Each subscription is checked on its schedule. Unchanged calendars cost almost
                        nothing to check.
                    </span>
                </Notice>
            )}
        </>
    );
};
