import { useState } from "react";
import { ArrowLeft, ArrowRight, Download01, SearchLg, ShieldTick } from "@untitledui/icons";
import { Table, TableCard } from "@/components/application/table/table";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { PortalDialog } from "@/portal/components/dialog";
import { Empty } from "@/portal/components/empty";
import { PageHeader } from "@/portal/components/page-header";
import { Timestamp } from "@/portal/components/timestamp";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import type { AuditEntry } from "@/shared/portal/types";

const ENTITY_LABELS: Record<string, string> = {
    guest: "Guests",
    household: "Households",
    event: "Events",
    message: "Messages",
    template: "Templates",
    task: "Tasks",
    timeline_item: "Timeline",
    supplier: "Suppliers",
    budget_item: "Budget",
    custom_field: "Custom fields",
    settings: "Settings",
    feature_flag: "Features",
    portal_user: "People",
    export: "Exports",
};

const actorLabel = (actor: string) => (actor.startsWith("rsvp:") ? "Online RSVP" : actor);

const href = (filters: { q: string; entity: string | null }, page: number) => {
    const params = new URLSearchParams();
    if (filters.q) params.set("q", filters.q);
    if (filters.entity) params.set("entity", filters.entity);
    if (page > 1) params.set("page", String(page));
    const query = params.toString();
    return `/portal/audit${query ? `?${query}` : ""}`;
};

/** Paged on the server: the audit log grows without bound, unlike the other lists. */
export const AuditPage = ({ data }: { data: PageData<"audit"> }) => {
    const { can } = usePortal();
    const [q, setQ] = useState(data.filters.q);
    const [entity, setEntity] = useState(data.filters.entity ?? "all");
    const [detail, setDetail] = useState<AuditEntry | null>(null);

    const apply = (next: { q: string; entity: string }) =>
        window.location.assign(href({ q: next.q.trim(), entity: next.entity === "all" ? null : next.entity }, 1));

    return (
        <>
            <PageHeader
                title="Audit log"
                description="Every change made in the portal and through the RSVP form: who, what and when."
                breadcrumbs={[{ label: "Audit log" }]}
                actions={
                    can("portal.audit.view") && (
                        <Button color="secondary" iconLeading={Download01} href="/api/portal/export/audit.csv" download>
                            Export CSV
                        </Button>
                    )
                }
            />

            <TableCard.Root>
                <TableCard.Header
                    title="Activity"
                    badge={`Page ${data.page} of ${data.totalPages}`}
                    contentTrailing={
                        <form
                            role="search"
                            className="flex w-full flex-col gap-3 sm:flex-row md:w-auto"
                            onSubmit={(e) => {
                                e.preventDefault();
                                apply({ q, entity });
                            }}
                        >
                            <Input
                                aria-label="Search the audit log"
                                placeholder="Search"
                                icon={SearchLg}
                                size="sm"
                                value={q}
                                onChange={setQ}
                                className="sm:w-56"
                            />
                            <Select
                                aria-label="Type"
                                size="sm"
                                className="sm:w-44"
                                items={[{ id: "all", label: "Everything" }, ...Object.entries(ENTITY_LABELS).map(([id, label]) => ({ id, label }))]}
                                value={entity}
                                onChange={(v) => {
                                    setEntity(String(v));
                                    apply({ q, entity: String(v) });
                                }}
                            >
                                {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                            </Select>
                            <Button type="submit" size="sm" color="secondary">
                                Search
                            </Button>
                        </form>
                    }
                />
                {data.entries.length === 0 ? (
                    <div className="py-10">
                        <Empty
                            icon={ShieldTick}
                            title={data.filters.q || data.filters.entity ? "No matching activity" : "No activity yet"}
                            description={
                                data.filters.q || data.filters.entity
                                    ? "Try a different search."
                                    : "Changes will be recorded here as soon as anyone edits anything."
                            }
                        />
                    </div>
                ) : (
                    <Table aria-label="Audit log" onRowAction={(key) => setDetail(data.entries.find((e) => String(e.id) === String(key)) ?? null)}>
                        <Table.Header>
                            <Table.Head id="at" label="When" />
                            <Table.Head id="summary" label="What" isRowHeader />
                            <Table.Head id="actor" label="Who" className="max-md:hidden" />
                            <Table.Head id="type" label="Type" className="max-lg:hidden" />
                        </Table.Header>
                        <Table.Body items={data.entries}>
                            {(entry) => (
                                <Table.Row id={entry.id} className="cursor-pointer">
                                    <Table.Cell className="whitespace-nowrap">
                                        <Timestamp iso={entry.at} />
                                    </Table.Cell>
                                    <Table.Cell className="text-secondary">{entry.summary}</Table.Cell>
                                    <Table.Cell className="max-md:hidden">{actorLabel(entry.actor)}</Table.Cell>
                                    <Table.Cell className="max-lg:hidden">
                                        <Badge size="sm" type="modern" color="gray">
                                            {ENTITY_LABELS[entry.entityType] ?? entry.entityType}
                                        </Badge>
                                    </Table.Cell>
                                </Table.Row>
                            )}
                        </Table.Body>
                    </Table>
                )}
                {data.totalPages > 1 && (
                    <nav aria-label="Pagination" className="flex items-center justify-between border-t border-secondary px-4 py-3 md:px-6">
                        <Button size="sm" color="secondary" iconLeading={ArrowLeft} href={href(data.filters, data.page - 1)} isDisabled={data.page <= 1}>
                            Newer
                        </Button>
                        <span className="text-sm text-secondary">
                            Page {data.page} of {data.totalPages}
                        </span>
                        <Button
                            size="sm"
                            color="secondary"
                            iconTrailing={ArrowRight}
                            href={href(data.filters, data.page + 1)}
                            isDisabled={data.page >= data.totalPages}
                        >
                            Older
                        </Button>
                    </nav>
                )}
            </TableCard.Root>

            <PortalDialog
                isOpen={!!detail}
                onOpenChange={(o) => !o && setDetail(null)}
                title={detail?.summary ?? ""}
                description={
                    detail && (
                        <>
                            {actorLabel(detail.actor)} · <Timestamp iso={detail.at} /> · {detail.action}
                        </>
                    )
                }
                icon={ShieldTick}
                size="lg"
                footer={
                    <Button color="secondary" size="lg" onClick={() => setDetail(null)}>
                        Close
                    </Button>
                }
            >
                {detail?.changes ? (
                    <pre className="max-h-96 overflow-auto rounded-lg bg-secondary p-4 font-mono text-xs whitespace-pre-wrap text-secondary">
                        {JSON.stringify(detail.changes, null, 2)}
                    </pre>
                ) : (
                    <p className="text-sm text-tertiary">No field-level details were recorded for this change.</p>
                )}
            </PortalDialog>
        </>
    );
};
