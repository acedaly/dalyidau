// Inbox, All knowledge, Archive and Trash: one list with filters, sorting, bulk actions and
// "load more". Filters live in the URL so a filtered view can be bookmarked.
import { useState } from "react";
import { Archive, BookOpen01, Inbox01, RefreshCcw01, Trash01 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Select } from "@/components/base/select/select";
import { type DataColumn, DataTable } from "@/portal/components/data-table";
import { Empty } from "@/portal/components/empty";
import { Timestamp } from "@/portal/components/timestamp";
import { useToast } from "@/portal/components/toast";
import { api, errorMessage } from "@/portal/lib/api";
import { pluralise } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { type KnowledgeObjectSummary, type ListView, roleAtLeast } from "@/shared/knowledge/types";
import { KnowledgeHeader } from "../knowledge-header";
import { QuickCapture } from "../quick-capture";
import { TypeIconFor, knowledgeApi, objectHref, spaceHref, titleOf } from "../shared";

const VIEWS: Record<ListView, { title: string; path: string; description: string; empty: string; icon: typeof Inbox01 }> = {
    inbox: {
        title: "Inbox",
        path: "/portal/knowledge/inbox",
        description: "Things you've captured but not yet organised. Give each one a type, links or tags, then mark it done.",
        empty: "Nothing waiting. Capture anything above and sort it out later.",
        icon: Inbox01,
    },
    all: {
        title: "All knowledge",
        path: "/portal/knowledge/all",
        description: "Everything in this space that isn't archived or in the trash.",
        empty: "Nothing here yet. Use New to create your first object.",
        icon: BookOpen01,
    },
    archived: {
        title: "Archive",
        path: "/portal/knowledge/archive",
        description: "Kept and searchable, but out of everyday lists.",
        empty: "Nothing archived.",
        icon: Archive,
    },
    trashed: {
        title: "Trash",
        path: "/portal/knowledge/trash",
        description: "Restore anything from here. Owners can delete permanently, one object at a time, from the object itself.",
        empty: "The trash is empty.",
        icon: Trash01,
    },
};

const PAGE = 200;

export const KnowledgeListPage = ({ data }: { data: PageData<"knowledge-list"> }) => {
    const { space, spaces, types, filters } = data;
    const toast = useToast();
    const view = VIEWS[filters.view];
    const [objects, setObjects] = useState(data.objects);
    const [total, setTotal] = useState(data.total);
    const [loading, setLoading] = useState(false);
    const canEdit = roleAtLeast(space.role, "editor");

    const go = (next: Partial<typeof filters>) => {
        const merged = { ...filters, ...next };
        window.location.assign(spaceHref(view.path, space, { type: merged.typeId, tag: merged.tag, sort: merged.sort === "updated" ? null : merged.sort }));
    };

    const loadMore = async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams({ view: filters.view, sort: filters.sort, offset: String(objects.length), limit: String(PAGE) });
            if (filters.typeId) params.set("type", filters.typeId);
            if (filters.tag) params.set("tag", filters.tag);
            const more = await api<{ objects: KnowledgeObjectSummary[]; total: number }>("GET", `/api/portal/knowledge/spaces/${space.id}/objects?${params}`);
            setObjects([...objects, ...more.objects]);
            setTotal(more.total);
        } catch (e) {
            toast.error("Couldn't load more", errorMessage(e));
        } finally {
            setLoading(false);
        }
    };

    const bulk = async (ids: string[], action: "archive" | "unarchive" | "trash" | "restore" | "file", clear: () => void) => {
        try {
            const { changed } = await knowledgeApi.bulk(space.id, ids, action);
            setObjects(objects.filter((o) => !ids.includes(o.id)));
            setTotal(total - changed);
            clear();
            toast.success(`${pluralise(changed, "object")} updated`);
        } catch (e) {
            toast.error("Couldn't update them", errorMessage(e));
        }
    };

    const typeOf = (o: KnowledgeObjectSummary) => types.find((t) => t.id === o.typeId);

    const columns: DataColumn<KnowledgeObjectSummary>[] = [
        {
            id: "title",
            label: "Title",
            isRowHeader: true,
            sortValue: (o) => titleOf(o.title),
            render: (o) => (
                <div className="flex min-w-0 items-start gap-3">
                    <TypeIconFor type={typeOf(o)} className="mt-0.5" />
                    <div className="min-w-0">
                        <a href={objectHref(o.id)} className="block truncate font-medium text-primary hover:underline">
                            {titleOf(o.title)}
                        </a>
                        {o.excerpt && <p className="line-clamp-1 text-tertiary">{o.excerpt}</p>}
                    </div>
                </div>
            ),
        },
        {
            id: "type",
            label: "Type",
            sortValue: (o) => typeOf(o)?.name,
            render: (o) => <span className="text-tertiary">{typeOf(o)?.name}</span>,
            className: "max-md:hidden",
        },
        {
            id: "tags",
            label: "Tags",
            render: (o) => (
                <div className="flex flex-wrap gap-1">
                    {o.tags.slice(0, 3).map((tag) => (
                        <Badge key={tag} size="sm" color="gray">
                            {tag}
                        </Badge>
                    ))}
                    {o.tags.length > 3 && <span className="text-xs text-tertiary">+{o.tags.length - 3}</span>}
                </div>
            ),
            className: "max-lg:hidden",
        },
        {
            id: "updated",
            label: filters.view === "trashed" ? "Changed" : "Updated",
            sortValue: (o) => o.updatedAt,
            render: (o) => <Timestamp iso={o.updatedAt} relative className="text-tertiary" />,
        },
    ];

    const Icon = view.icon;

    return (
        <>
            <KnowledgeHeader title={view.title} description={view.description} space={space} spaces={spaces} types={types} crumb={view.title} />

            {filters.view === "inbox" && canEdit && (
                <QuickCapture
                    space={space}
                    onCaptured={(o) => {
                        setObjects([o, ...objects]);
                        setTotal(total + 1);
                    }}
                />
            )}

            <DataTable
                title={view.title}
                description={pluralise(total, "object")}
                rows={objects}
                columns={columns}
                searchText={(o) => `${o.title} ${o.excerpt} ${o.tags.join(" ")}`}
                searchPlaceholder="Filter these by title or text"
                selectable={canEdit}
                onRowAction={(o) => window.location.assign(objectHref(o.id))}
                activeFilterCount={(filters.typeId ? 1 : 0) + (filters.tag ? 1 : 0)}
                onClearFilters={() => go({ typeId: null, tag: null })}
                filters={
                    <div className="flex flex-col gap-3 sm:flex-row">
                        <Select
                            aria-label="Type"
                            size="sm"
                            className="sm:w-48"
                            value={filters.typeId ?? "all"}
                            onChange={(key) => go({ typeId: key === "all" ? null : String(key) })}
                            items={[{ id: "all", label: "All types" }, ...types.map((t) => ({ id: t.id, label: t.name }))]}
                        >
                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                        </Select>
                        {data.tags.length > 0 && (
                            <Select
                                aria-label="Tag"
                                size="sm"
                                className="sm:w-48"
                                value={filters.tag ?? "__all"}
                                onChange={(key) => go({ tag: key === "__all" ? null : String(key) })}
                                items={[{ id: "__all", label: "All tags" }, ...data.tags.map((t) => ({ id: t, label: t }))]}
                            >
                                {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                            </Select>
                        )}
                        {filters.view !== "trashed" && (
                            <Select
                                aria-label="Sort"
                                size="sm"
                                className="sm:w-48"
                                value={filters.sort}
                                onChange={(key) => go({ sort: key as typeof filters.sort })}
                                items={[
                                    { id: "updated", label: "Recently updated" },
                                    { id: "created", label: "Recently created" },
                                    { id: "title", label: "Title" },
                                ]}
                            >
                                {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                            </Select>
                        )}
                    </div>
                }
                bulkActions={(ids, clear) => (
                    <>
                        {filters.view === "inbox" && (
                            <Button size="sm" color="secondary" iconLeading={Inbox01} onClick={() => bulk(ids, "file", clear)}>
                                Done processing
                            </Button>
                        )}
                        {(filters.view === "all" || filters.view === "inbox") && (
                            <Button size="sm" color="secondary" iconLeading={Archive} onClick={() => bulk(ids, "archive", clear)}>
                                Archive
                            </Button>
                        )}
                        {filters.view === "archived" && (
                            <Button size="sm" color="secondary" iconLeading={Archive} onClick={() => bulk(ids, "unarchive", clear)}>
                                Unarchive
                            </Button>
                        )}
                        {filters.view !== "trashed" ? (
                            <Button size="sm" color="secondary-destructive" iconLeading={Trash01} onClick={() => bulk(ids, "trash", clear)}>
                                Move to trash
                            </Button>
                        ) : (
                            <Button size="sm" color="secondary" iconLeading={RefreshCcw01} onClick={() => bulk(ids, "restore", clear)}>
                                Restore
                            </Button>
                        )}
                    </>
                )}
                emptyState={<Empty icon={Icon} title={`${view.title} is empty`} description={view.empty} />}
                initialSort={undefined}
                pageSize={50}
            />

            {objects.length < total && (
                <div className="flex justify-center">
                    <Button color="secondary" isLoading={loading} onClick={loadMore}>
                        Load more ({pluralise(total - objects.length, "more object")})
                    </Button>
                </div>
            )}
        </>
    );
};
