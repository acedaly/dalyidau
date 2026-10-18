// Calendars and sharing: your calendars, who can see each one (owner, editor, viewer or free/busy
// only), each person's own colour and show/hide, ICS export, and private feeds for Apple Calendar,
// Outlook and Google Calendar. Feeds are one-way: changes made in another app don't come back.
import { useState } from "react";
import { Copy01, Download01, Edit01, Plus, RefreshCw01, Rss01, Trash01, Users01 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { TextArea } from "@/components/base/textarea/textarea";
import { ConfirmDialog, PortalDialog } from "@/portal/components/dialog";
import { Notice } from "@/portal/components/notice";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import { formatRelative } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import {
    CALENDAR_PURPOSES,
    CALENDAR_ROLE_LABELS,
    type CalendarColor,
    type CalendarFeedInfo,
    type CalendarInfo,
    type CalendarMember,
    type CalendarPurpose,
    type CalendarRole,
    type FeedScope,
} from "@/shared/calendar/types";
import { featuresHref } from "@/shared/portal/settings-sections";
import { calendarApi } from "../api";
import { CalendarHeader, Card, ColorDot, ColorPicker, download } from "../shared";

const PURPOSE_LABELS: Record<CalendarPurpose, string> = {
    general: "General",
    family: "Family",
    work: "Work",
    school: "School",
    care: "Care arrangements",
    birthdays: "Birthdays and anniversaries",
    travel: "Travel and holidays",
    subscription: "Subscription",
};

const CalendarDialog = ({ calendar, onClose, onSaved }: { calendar: CalendarInfo | "new"; onClose: () => void; onSaved: (c: CalendarInfo) => void }) => {
    const toast = useToast();
    const existing = calendar === "new" ? null : calendar;
    const [name, setName] = useState(existing?.name ?? "");
    const [description, setDescription] = useState(existing?.description ?? "");
    const [color, setColor] = useState<CalendarColor>(existing?.color ?? "blue");
    const [kind, setKind] = useState<"personal" | "shared">(existing?.kind ?? "shared");
    const [purpose, setPurpose] = useState<CalendarPurpose>(existing?.purpose ?? "family");
    const [busy, setBusy] = useState(false);
    const save = async () => {
        setBusy(true);
        try {
            const result = existing
                ? await calendarApi.updateCalendar(existing.id, {
                      version: existing.version,
                      name,
                      description: description || null,
                      color,
                      ...(existing.source === "local" && !existing.isDefault ? { kind, purpose } : {}),
                  })
                : await calendarApi.createCalendar({ name, description: description || null, color, kind, purpose });
            onSaved(result.calendar);
            onClose();
        } catch (error) {
            toast.error("Couldn't save the calendar", errorMessage(error));
        } finally {
            setBusy(false);
        }
    };
    return (
        <PortalDialog
            isOpen
            onOpenChange={(open) => !open && onClose()}
            title={existing ? "Edit calendar" : "New calendar"}
            description={
                existing ? undefined : "A shared calendar is seen by the people you add. A personal one is yours (others can only be given free/busy)."
            }
            onSubmit={() => void save()}
            footer={
                <>
                    <Button color="secondary" size="lg" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button type="submit" size="lg" isLoading={busy} isDisabled={!name.trim()}>
                        {existing ? "Save" : "Create calendar"}
                    </Button>
                </>
            }
        >
            <Input label="Name" isRequired value={name} onChange={setName} autoFocus />
            <TextArea label="Description" rows={2} value={description} onChange={setDescription} />
            {(!existing || (existing.source === "local" && !existing.isDefault)) && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Select
                        label="Who"
                        value={kind}
                        onChange={(k) => k && setKind(k as "personal" | "shared")}
                        items={[
                            { id: "shared", label: "Shared with the household" },
                            { id: "personal", label: "Personal" },
                        ]}
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                    <Select
                        label="Used for"
                        value={purpose}
                        onChange={(k) => k && setPurpose(k as CalendarPurpose)}
                        items={CALENDAR_PURPOSES.filter((p) => p !== "subscription").map((p) => ({ id: p, label: PURPOSE_LABELS[p] }))}
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                </div>
            )}
            <ColorPicker value={color} onChange={setColor} />
        </PortalDialog>
    );
};

const Members = ({
    calendar,
    members,
    people,
    onMembers,
}: {
    calendar: CalendarInfo;
    members: CalendarMember[];
    people: PageData<"calendar-calendars">["people"];
    onMembers: (m: CalendarMember[]) => void;
}) => {
    const toast = useToast();
    const [email, setEmail] = useState<string | null>(null);
    const roles: CalendarRole[] =
        calendar.kind === "personal"
            ? ["freebusy"]
            : calendar.source === "subscription"
              ? ["owner", "viewer", "freebusy"]
              : ["owner", "editor", "viewer", "freebusy"];
    const [role, setRole] = useState<CalendarRole>(roles.includes("editor") ? "editor" : roles.includes("viewer") ? "viewer" : "freebusy");
    const candidates = people.filter((p) => !members.some((m) => m.email === p.email));
    const add = async () => {
        if (!email) return;
        try {
            onMembers((await calendarApi.addMember(calendar.id, email, role)).members);
            setEmail(null);
        } catch (error) {
            toast.error("Couldn't add them", errorMessage(error));
        }
    };
    const remove = async (target: string) => {
        try {
            onMembers((await calendarApi.removeMember(calendar.id, target)).members);
        } catch (error) {
            toast.error("Couldn't remove them", errorMessage(error));
        }
    };
    return (
        <div className="flex flex-col gap-3">
            <ul className="flex flex-col divide-y divide-secondary">
                {members.map((m) => (
                    <li key={m.email} className="flex items-center justify-between gap-3 py-2">
                        <span className="min-w-0">
                            <span className="block truncate text-sm font-medium text-primary">{m.name ?? m.email}</span>
                            <span className="text-xs text-tertiary">{CALENDAR_ROLE_LABELS[m.role].label}</span>
                        </span>
                        {m.email !== calendar.ownerEmail && (
                            <ButtonUtility
                                size="xs"
                                color="tertiary"
                                icon={Trash01}
                                tooltip={`Remove ${m.name ?? m.email}`}
                                onClick={() => void remove(m.email)}
                            />
                        )}
                    </li>
                ))}
            </ul>
            {candidates.length > 0 ? (
                <div className="flex flex-wrap items-end gap-2">
                    <Select
                        size="sm"
                        label="Add someone"
                        placeholder="Choose a person"
                        className="min-w-48 flex-1"
                        value={email}
                        onChange={(k) => setEmail(k ? String(k) : null)}
                        items={candidates.map((p) => ({ id: p.email, label: p.name ?? p.email }))}
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                    <Select
                        size="sm"
                        label="As"
                        className="w-40"
                        value={role}
                        onChange={(k) => k && setRole(k as CalendarRole)}
                        items={roles.map((r) => ({ id: r, label: CALENDAR_ROLE_LABELS[r].label }))}
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                    <Button size="sm" color="secondary" iconLeading={Plus} onClick={() => void add()} isDisabled={!email}>
                        Add
                    </Button>
                </div>
            ) : (
                <p className="text-xs text-tertiary">Everyone who can open Calendar already has access. Add more people in Portal settings.</p>
            )}
            <p className="text-xs text-quaternary">{CALENDAR_ROLE_LABELS[role].description}</p>
        </div>
    );
};

const FeedDialog = ({
    calendars,
    feed,
    onClose,
    onCreated,
}: {
    calendars: CalendarInfo[];
    feed: CalendarFeedInfo | null;
    onClose: () => void;
    onCreated: (address: string | null) => void;
}) => {
    const toast = useToast();
    const local = calendars.filter((c) => c.source === "local");
    const [name, setName] = useState(feed?.name ?? "My Daly calendar");
    const [scope, setScope] = useState<FeedScope>(
        feed?.scope ?? { calendarIds: local.filter((c) => c.isDefault).map((c) => c.id), leave: true, tasks: "none", detail: "full" },
    );
    const [busy, setBusy] = useState(false);
    const save = async () => {
        setBusy(true);
        try {
            if (feed) {
                await calendarApi.updateFeed(feed.id, { name, scope });
                onCreated(null);
            } else onCreated((await calendarApi.createFeed(name, scope)).address);
            onClose();
        } catch (error) {
            toast.error("Couldn't save the feed", errorMessage(error));
        } finally {
            setBusy(false);
        }
    };
    return (
        <PortalDialog
            isOpen
            onOpenChange={(open) => !open && onClose()}
            title={feed ? "Edit feed" : "New subscription address"}
            description="Add this address to Apple Calendar, Outlook or Google Calendar to see these events there. It's one-way and read-only."
            onSubmit={() => void save()}
            footer={
                <>
                    <Button color="secondary" size="lg" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button
                        type="submit"
                        size="lg"
                        isLoading={busy}
                        isDisabled={!name.trim() || (!scope.calendarIds.length && !scope.leave && scope.tasks === "none")}
                    >
                        {feed ? "Save" : "Create address"}
                    </Button>
                </>
            }
        >
            <Input label="Name" isRequired value={name} onChange={setName} />
            <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-medium text-secondary">Calendars</legend>
                {local.map((c) => (
                    <Checkbox
                        key={c.id}
                        label={c.name}
                        hint={c.role === "freebusy" ? "Free/busy only" : undefined}
                        isSelected={scope.calendarIds.includes(c.id)}
                        onChange={(on) => setScope({ ...scope, calendarIds: on ? [...scope.calendarIds, c.id] : scope.calendarIds.filter((x) => x !== c.id) })}
                    />
                ))}
            </fieldset>
            <Checkbox label="My approved and requested leave" isSelected={scope.leave} onChange={(on) => setScope({ ...scope, leave: on })} />
            <Select
                label="Task due dates"
                value={scope.tasks}
                onChange={(k) => k && setScope({ ...scope, tasks: k as FeedScope["tasks"] })}
                items={[
                    { id: "none", label: "None" },
                    { id: "deadlines", label: "Deadlines only" },
                    { id: "dated", label: "Every task with a due date" },
                ]}
            >
                {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
            </Select>
            <Select
                label="Details"
                value={scope.detail}
                onChange={(k) => k && setScope({ ...scope, detail: k as FeedScope["detail"] })}
                items={[
                    { id: "full", label: "Titles, places and notes", supportingText: "Private and sensitive events are always just Busy" },
                    { id: "busy", label: "Busy times only" },
                ]}
                hint="Anyone who has the address can read what it publishes."
            >
                {(item) => (
                    <Select.Item id={item.id} supportingText={item.supportingText}>
                        {item.label}
                    </Select.Item>
                )}
            </Select>
        </PortalDialog>
    );
};

export const CalendarCalendarsPage = ({ data }: { data: PageData<"calendar-calendars"> }) => {
    const toast = useToast();
    const [calendars, setCalendars] = useState(data.calendars);
    const [members, setMembers] = useState(data.members);
    const [feeds, setFeeds] = useState(data.feeds);
    const [editing, setEditing] = useState<CalendarInfo | "new" | null>(null);
    const [deleting, setDeleting] = useState<CalendarInfo | null>(null);
    const [feedDialog, setFeedDialog] = useState<CalendarFeedInfo | "new" | null>(null);
    const [address, setAddress] = useState<string | null>(null);
    const [revoking, setRevoking] = useState<CalendarFeedInfo | null>(null);

    const saved = (c: CalendarInfo) => setCalendars((all) => (all.some((x) => x.id === c.id) ? all.map((x) => (x.id === c.id ? c : x)) : [...all, c]));
    const exportIcs = async (c: CalendarInfo) => {
        try {
            await download(`/api/portal/calendar/calendars/${c.id}/export.ics`);
        } catch (error) {
            toast.error("The export failed", errorMessage(error));
        }
    };
    const refreshFeeds = async () => setFeeds((await calendarApi.feeds()).feeds);

    return (
        <>
            <CalendarHeader
                shell={data}
                title="Calendars and sharing"
                description="Your calendars, who can see them, and private addresses for other calendar apps."
                crumb={{ label: "Calendars and sharing" }}
                actions={
                    <Button size="md" iconLeading={Plus} onClick={() => setEditing("new")}>
                        New calendar
                    </Button>
                }
            />
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                {calendars.map((c) => (
                    <Card
                        key={c.id}
                        title={c.name}
                        description={
                            <span className="flex flex-wrap items-center gap-2">
                                <ColorDot color={c.color} />
                                {c.source === "subscription" ? "Subscribed" : c.kind === "shared" ? "Shared" : "Personal"} · {PURPOSE_LABELS[c.purpose]} ·
                                you're {CALENDAR_ROLE_LABELS[c.role].label.toLowerCase()}
                                {c.isDefault && (
                                    <Badge size="sm" color="brand">
                                        Default
                                    </Badge>
                                )}
                            </span>
                        }
                        actions={
                            <>
                                <ButtonUtility size="sm" color="tertiary" icon={Download01} tooltip="Export as ICS" onClick={() => void exportIcs(c)} />
                                {c.role === "owner" && <ButtonUtility size="sm" color="tertiary" icon={Edit01} tooltip="Edit" onClick={() => setEditing(c)} />}
                                {c.role === "owner" && !c.isDefault && c.source === "local" && (
                                    <ButtonUtility size="sm" color="tertiary" icon={Trash01} tooltip="Delete" onClick={() => setDeleting(c)} />
                                )}
                            </>
                        }
                    >
                        {c.description && <p className="text-sm text-tertiary">{c.description}</p>}
                        {c.role === "owner" ? (
                            <Members calendar={c} members={members[c.id] ?? []} people={data.people} onMembers={(m) => setMembers({ ...members, [c.id]: m })} />
                        ) : (
                            <p className="flex items-center gap-2 text-sm text-tertiary">
                                <Users01 aria-hidden="true" className="size-4" /> Shared with you by {c.ownerEmail}. {c.memberCount} people can see it.
                            </p>
                        )}
                        <ColorPicker
                            label="Your colour for it"
                            value={c.color}
                            onChange={async (color) => saved((await calendarApi.personal(c.id, { color })).calendar)}
                        />
                    </Card>
                ))}
            </div>

            <Card
                title="Subscribe from other calendar apps"
                description="Private addresses that publish chosen calendars, your leave and task due dates to Apple Calendar, Outlook or Google Calendar. One-way: nothing comes back. Revoke an address at any time."
                actions={
                    <Button size="sm" iconLeading={Rss01} onClick={() => setFeedDialog("new")}>
                        New address
                    </Button>
                }
            >
                {!data.switches.feeds && (
                    <Notice color="warning" title="Subscription addresses are switched off">
                        You can create addresses now, but they answer “not found” until an owner turns on <strong>Calendar subscription addresses</strong> in{" "}
                        <a href={featuresHref("calendar")} className="font-semibold underline underline-offset-2 outline-focus-ring focus-visible:outline-2">
                            Portal settings → Features
                        </a>
                        .
                    </Notice>
                )}
                {address && (
                    <Notice
                        color="success"
                        title="Copy this address now"
                        actions={
                            <Button
                                size="sm"
                                color="secondary"
                                iconLeading={Copy01}
                                onClick={() => void navigator.clipboard.writeText(address).then(() => toast.success("Address copied"))}
                            >
                                Copy address
                            </Button>
                        }
                    >
                        <span className="block font-mono text-xs break-all">{address}</span>
                        It won't be shown again. Anyone with it can read what it publishes. In Apple Calendar use File → New Calendar Subscription; in Outlook,
                        Add calendar → Subscribe from web; in Google Calendar, Other calendars → From URL.
                    </Notice>
                )}
                {feeds.length ? (
                    <ul className="flex flex-col divide-y divide-secondary">
                        {feeds.map((f) => (
                            <li key={f.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                                <span className="min-w-0">
                                    <span className="flex items-center gap-2 text-sm font-medium text-primary">
                                        {f.name}
                                        {f.revokedAt && (
                                            <Badge size="sm" color="gray">
                                                Revoked
                                            </Badge>
                                        )}
                                    </span>
                                    <span className="text-xs text-tertiary">
                                        …{f.tokenHint} · {f.scope.calendarIds.length} calendar{f.scope.calendarIds.length === 1 ? "" : "s"}
                                        {f.scope.leave ? " · leave" : ""}
                                        {f.scope.tasks !== "none" ? " · tasks" : ""} · {f.scope.detail === "busy" ? "busy times only" : "with details"}
                                        {f.lastAccessedAt ? ` · last read ${formatRelative(f.lastAccessedAt)}` : " · not read yet"}
                                    </span>
                                </span>
                                {!f.revokedAt && (
                                    <span className="flex gap-2">
                                        <Button size="sm" color="secondary" onClick={() => setFeedDialog(f)}>
                                            Edit
                                        </Button>
                                        <Button
                                            size="sm"
                                            color="secondary"
                                            iconLeading={RefreshCw01}
                                            onClick={async () => {
                                                try {
                                                    setAddress((await calendarApi.rotateFeed(f.id)).address);
                                                    await refreshFeeds();
                                                } catch (error) {
                                                    toast.error("Couldn't make a new address", errorMessage(error));
                                                }
                                            }}
                                        >
                                            New address
                                        </Button>
                                        <Button size="sm" color="secondary-destructive" onClick={() => setRevoking(f)}>
                                            Revoke
                                        </Button>
                                    </span>
                                )}
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="text-sm text-tertiary">No addresses yet.</p>
                )}
            </Card>

            {editing && <CalendarDialog calendar={editing} onClose={() => setEditing(null)} onSaved={saved} />}
            {feedDialog && (
                <FeedDialog
                    calendars={calendars}
                    feed={feedDialog === "new" ? null : feedDialog}
                    onClose={() => setFeedDialog(null)}
                    onCreated={(a) => {
                        if (a) setAddress(a);
                        void refreshFeeds();
                    }}
                />
            )}
            <ConfirmDialog
                isOpen={!!deleting}
                onOpenChange={(open) => !open && setDeleting(null)}
                title={`Delete ${deleting?.name ?? "this calendar"}?`}
                description="Its events are deleted for everyone who can see it. Export it first if you might want them. This can't be undone."
                confirmLabel="Delete calendar"
                destructive
                onConfirm={async () => {
                    if (!deleting) return;
                    try {
                        setCalendars((await calendarApi.deleteCalendar(deleting.id)).calendars);
                        setDeleting(null);
                    } catch (error) {
                        toast.error("Couldn't delete it", errorMessage(error));
                    }
                }}
            />
            <ConfirmDialog
                isOpen={!!revoking}
                onOpenChange={(open) => !open && setRevoking(null)}
                title="Revoke this address?"
                description="Calendar apps using it stop getting updates straight away. This can't be undone; you can create a new address."
                confirmLabel="Revoke"
                destructive
                onConfirm={async () => {
                    if (!revoking) return;
                    try {
                        setFeeds((await calendarApi.revokeFeed(revoking.id)).feeds);
                        setRevoking(null);
                    } catch (error) {
                        toast.error("Couldn't revoke it", errorMessage(error));
                    }
                }}
            />
        </>
    );
};
