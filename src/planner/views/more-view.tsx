// More: the rest of the wedding in the app (seating, the day's timeline, suppliers), links into the
// full portal for what's best done on a bigger screen, and the account.
import { ArrowUpRight, ClipboardCheck, Clock, Globe02, LayoutGrid01, LogOut01, Mail01, MarkerPin01, Phone, User01 } from "@untitledui/icons";
import { BadgeWithDot } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ProgressBar } from "@/components/base/progress-indicators/progress-indicators";
import { formatDate, formatTime, percent, pluralise } from "@/portal/lib/format";
import { usePortal } from "@/portal/portal-context";
import type { DashboardStats, SeatingState, Supplier, SupplierStatus, TimelineItem } from "@/shared/portal/types";
import { EmptyRow, LoadError, LoadingRows, PageTitle, Row, RowList, Section, SectionLink, StatGrid, StatTile } from "../components";
import { DASHBOARD, SEATING, SUPPLIERS, TIMELINE, useApi } from "../data";
import { useNavigation } from "../navigation";

export const MoreView = () => {
    const { user, can, isOn } = usePortal();
    const { go, portalUrl } = useNavigation();
    const { data } = useApi<{ stats: DashboardStats }>(DASHBOARD);
    const stats = data?.stats;
    const comms = stats?.communications;

    return (
        <>
            <PageTitle title="More" />
            <Section label="Wedding" flush>
                <RowList>
                    {isOn("module.planning") && (
                        <Row
                            leading={<LayoutGrid01 aria-hidden="true" className="size-5 text-fg-quaternary" />}
                            title="Seating"
                            detail={stats?.seating ? `${stats.seating.seated} of ${stats.seating.attending} guests seated` : undefined}
                            onPress={() => go("seating")}
                        />
                    )}
                    {isOn("module.planning") && (
                        <Row
                            leading={<Clock aria-hidden="true" className="size-5 text-fg-quaternary" />}
                            title="Timeline"
                            detail="The run sheet for the day"
                            onPress={() => go("timeline")}
                        />
                    )}
                    {isOn("module.budget") && can("wedding.budget.view") && (
                        <Row
                            leading={<ClipboardCheck aria-hidden="true" className="size-5 text-fg-quaternary" />}
                            title="Suppliers"
                            detail="Who's booked, and how to reach them"
                            onPress={() => go("suppliers")}
                        />
                    )}
                </RowList>
            </Section>

            <Section label="In the full portal" flush>
                <RowList>
                    {isOn("module.communications") && (
                        <Row
                            leading={<Mail01 aria-hidden="true" className="size-5 text-fg-quaternary" />}
                            title="Communications"
                            detail={
                                comms
                                    ? `${pluralise(comms.sent, "message")} sent · ${comms.drafts} drafts${comms.failed ? ` · ${comms.failed} failed` : ""}`
                                    : undefined
                            }
                            external
                            href={`${portalUrl}/communications`}
                        />
                    )}
                    <Row
                        leading={<Globe02 aria-hidden="true" className="size-5 text-fg-quaternary" />}
                        title="Website & invitations"
                        external
                        href={`${portalUrl}/website`}
                    />
                    <Row
                        leading={<LayoutGrid01 aria-hidden="true" className="size-5 text-fg-quaternary" />}
                        title="Open the full portal"
                        detail="Households, imports, catering and settings"
                        external
                        href={portalUrl}
                    />
                </RowList>
            </Section>

            <Section label="Account" flush>
                <RowList>
                    <Row leading={<User01 aria-hidden="true" className="size-5 text-fg-quaternary" />} title={user.name ?? user.email} detail={user.email} />
                    <Row leading={<LogOut01 aria-hidden="true" className="size-5 text-fg-quaternary" />} title="Sign out" href="/cdn-cgi/access/logout" />
                </RowList>
            </Section>
        </>
    );
};

const BackToMore = () => {
    const { go } = useNavigation();
    return <SectionLink onClick={() => go("more")}>Back</SectionLink>;
};

export const SeatingView = () => {
    const { portalUrl } = useNavigation();
    const { data, error, reload } = useApi<SeatingState>(SEATING);
    const attending = data?.guests.filter((guest) => guest.status === "attending") ?? [];
    const seated = attending.filter((guest) => guest.tableId);
    const unseated = attending.filter((guest) => !guest.tableId);
    const seats = data?.tables.reduce((sum, table) => sum + table.capacity, 0) ?? 0;

    return (
        <>
            <PageTitle title="Seating" subtitle={data?.event ? `For the ${data.event.name}` : undefined} actions={<BackToMore />} />
            {error && !data ? (
                <Section>
                    <LoadError error={error} onRetry={reload} />
                </Section>
            ) : !data ? (
                <Section flush>
                    <LoadingRows />
                </Section>
            ) : (
                <>
                    <Section>
                        <StatGrid>
                            <StatTile label="Tables" value={data.tables.length} />
                            <StatTile label="Seats" value={seats} />
                            <StatTile label="Seated" value={seated.length} tone="success" />
                            <StatTile label="Not seated" value={unseated.length} tone={unseated.length ? "warning" : "default"} />
                        </StatGrid>
                        {attending.length > 0 && (
                            <div className="mt-4">
                                <ProgressBar
                                    value={percent(seated.length, attending.length)}
                                    labelPosition="bottom"
                                    aria-label="Guests seated"
                                    valueFormatter={() => `${percent(seated.length, attending.length)}% seated`}
                                />
                            </div>
                        )}
                        <Button color="secondary" size="sm" href={`${portalUrl}/seating`} iconTrailing={ArrowUpRight} className="mt-4">
                            Arrange seats in the portal
                        </Button>
                    </Section>

                    <Section label="Tables" flush>
                        {data.tables.length === 0 ? (
                            <EmptyRow icon={LayoutGrid01}>No tables yet. Add them in the portal.</EmptyRow>
                        ) : (
                            <RowList>
                                {data.tables.map((table) => {
                                    const at = data.guests.filter((guest) => guest.tableId === table.id);
                                    return (
                                        <Row
                                            key={table.id}
                                            title={table.name}
                                            detail={at.length ? at.map((guest) => guest.name).join(", ") : "Nobody seated yet"}
                                            trailing={
                                                <span
                                                    className={
                                                        at.length > table.capacity
                                                            ? "text-sm font-medium text-error-primary"
                                                            : "text-sm text-tertiary tabular-nums"
                                                    }
                                                >
                                                    {at.length}/{table.capacity}
                                                </span>
                                            }
                                        />
                                    );
                                })}
                            </RowList>
                        )}
                    </Section>

                    {unseated.length > 0 && (
                        <Section label="Not seated yet" flush>
                            <RowList>
                                {unseated.map((guest) => (
                                    <Row key={guest.id} title={guest.name} detail={guest.householdName ?? undefined} />
                                ))}
                            </RowList>
                        </Section>
                    )}
                </>
            )}
        </>
    );
};

export const TimelineView = () => {
    const { portalUrl } = useNavigation();
    const { data, error, reload } = useApi<{ items: TimelineItem[] }>(TIMELINE);
    const items = [...(data?.items ?? [])].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    const days = [...new Set(items.map((item) => item.startsAt.slice(0, 10)))];

    return (
        <>
            <PageTitle title="Timeline" subtitle="Who needs to be where, and when" actions={<BackToMore />} />
            {error && !data ? (
                <Section>
                    <LoadError error={error} onRetry={reload} />
                </Section>
            ) : !data ? (
                <Section flush>
                    <LoadingRows />
                </Section>
            ) : items.length === 0 ? (
                <Section>
                    <EmptyRow icon={Clock}>Nothing on the timeline yet.</EmptyRow>
                </Section>
            ) : (
                days.map((day) => (
                    <Section key={day} label={formatDate(day, { weekday: "long", day: "numeric", month: "long" })} flush>
                        <ol className="divide-y divide-secondary">
                            {items
                                .filter((item) => item.startsAt.startsWith(day))
                                .map((item) => (
                                    <li key={item.id} className="flex gap-4 px-4 py-3">
                                        <span className="w-16 shrink-0 pt-0.5 text-sm font-semibold text-brand-secondary tabular-nums">
                                            {formatTime(item.startsAt)}
                                        </span>
                                        <span className="flex min-w-0 flex-col gap-1">
                                            <span className="text-sm font-medium text-primary">{item.title}</span>
                                            {(item.location || item.owner) && (
                                                <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-tertiary">
                                                    {item.location && (
                                                        <span className="flex items-center gap-1">
                                                            <MarkerPin01 aria-hidden="true" className="size-3.5 text-fg-quaternary" />
                                                            {item.location}
                                                        </span>
                                                    )}
                                                    {item.owner && (
                                                        <span className="flex items-center gap-1">
                                                            <User01 aria-hidden="true" className="size-3.5 text-fg-quaternary" />
                                                            {item.owner}
                                                        </span>
                                                    )}
                                                </span>
                                            )}
                                            {item.notes && <span className="text-xs whitespace-pre-line text-tertiary">{item.notes}</span>}
                                        </span>
                                    </li>
                                ))}
                        </ol>
                    </Section>
                ))
            )}
            <Button color="secondary" size="sm" href={`${portalUrl}/timeline`} iconTrailing={ArrowUpRight} className="self-start">
                Edit the timeline in the portal
            </Button>
        </>
    );
};

const SUPPLIER_STATUS: Record<SupplierStatus, { label: string; color: "success" | "blue" | "gray" | "error" }> = {
    booked: { label: "Booked", color: "success" },
    quoted: { label: "Quoted", color: "blue" },
    researching: { label: "Researching", color: "gray" },
    cancelled: { label: "Cancelled", color: "error" },
};

export const SuppliersView = () => {
    const { portalUrl } = useNavigation();
    const { data, error, reload } = useApi<{ items: Supplier[] }>(SUPPLIERS);
    const rank: Record<SupplierStatus, number> = { booked: 0, quoted: 1, researching: 2, cancelled: 3 };
    const suppliers = [...(data?.items ?? [])].sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));

    return (
        <>
            <PageTitle title="Suppliers" actions={<BackToMore />} />
            {error && !data ? (
                <Section>
                    <LoadError error={error} onRetry={reload} />
                </Section>
            ) : !data ? (
                <Section flush>
                    <LoadingRows />
                </Section>
            ) : suppliers.length === 0 ? (
                <Section>
                    <EmptyRow icon={ClipboardCheck}>No suppliers yet.</EmptyRow>
                </Section>
            ) : (
                <Section flush>
                    <ul className="divide-y divide-secondary" aria-label="Suppliers">
                        {suppliers.map((supplier) => (
                            <li key={supplier.id} className="flex flex-col gap-2 px-4 py-3">
                                <div className="flex items-start justify-between gap-3">
                                    <span className="flex min-w-0 flex-col">
                                        <span className="truncate text-sm font-medium text-primary">{supplier.name}</span>
                                        <span className="truncate text-xs text-tertiary">
                                            {[supplier.category, supplier.contactName].filter(Boolean).join(" · ")}
                                        </span>
                                    </span>
                                    <BadgeWithDot size="sm" type="pill-color" color={SUPPLIER_STATUS[supplier.status].color}>
                                        {SUPPLIER_STATUS[supplier.status].label}
                                    </BadgeWithDot>
                                </div>
                                {(supplier.phone || supplier.email || supplier.website) && (
                                    <div className="flex flex-wrap gap-2">
                                        {supplier.phone && (
                                            <Button size="sm" color="secondary" iconLeading={Phone} href={`tel:${supplier.phone}`}>
                                                Call
                                            </Button>
                                        )}
                                        {supplier.email && (
                                            <Button size="sm" color="secondary" iconLeading={Mail01} href={`mailto:${supplier.email}`}>
                                                Email
                                            </Button>
                                        )}
                                        {supplier.website && /^https?:\/\//.test(supplier.website) && (
                                            <Button
                                                size="sm"
                                                color="secondary"
                                                iconLeading={Globe02}
                                                href={supplier.website}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                            >
                                                Website
                                            </Button>
                                        )}
                                    </div>
                                )}
                            </li>
                        ))}
                    </ul>
                </Section>
            )}
            <Button color="secondary" size="sm" href={`${portalUrl}/suppliers`} iconTrailing={ArrowUpRight} className="self-start">
                Edit suppliers in the portal
            </Button>
        </>
    );
};
