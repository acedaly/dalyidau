// Inbox, All knowledge, Archive and Trash: one list with filters, sorting, bulk actions and
// "load more". Filters live in the URL so a filtered view can be bookmarked.
import { useState } from "react";
import { Archive, BookOpen01, Bookmark, Edit05, Inbox01, RefreshCcw01, Trash01 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { PortalDialog } from "@/portal/components/dialog";
import { DateField } from "@/portal/components/date-field";
import { type DataColumn, DataTable } from "@/portal/components/data-table";
import { Empty } from "@/portal/components/empty";
import { Timestamp } from "@/portal/components/timestamp";
import { useToast } from "@/portal/components/toast";
import { api, errorMessage } from "@/portal/lib/api";
import { pluralise } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { type KnowledgeObjectSummary, type LinkFilter, type ListFilters, type ListView, roleAtLeast } from "@/shared/knowledge/types";
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

const LINK_LABELS: Record<LinkFilter, string> = {
    any: "Any links",
    unlinked: "Not linked at all",
    no_backlinks: "Nothing links here",
    no_outgoing: "Links nowhere",
};

/** URL parameters for a set of filters (the same names the API reads). */
const filterParams = (f: ListFilters): Record<string, string | null> => ({
    type: f.typeId,
    tag: f.tag,
    sort: f.sort === "updated" ? null : f.sort,
    links: f.links && f.links !== "any" ? f.links : null,
    created_from: f.createdFrom ?? null,
    created_to: f.createdTo ?? null,
    updated_from: f.updatedFrom ?? null,
    updated_to: f.updatedTo ?? null,
});


export const KnowledgeListPage = ({ data }: { data: PageData<"knowledge-list"> }) => {
    const { space, spaces, types, filters } = data;
    const toast = useToast();
    const view = VIEWS[filters.view];
    const [objects, setObjects] = useState(data.objects);
    const [total, setTotal] = useState(data.total);
    const [loading, setLoading] = useState(false);
    const canEdit = roleAtLeast(space.role, "editor");
    const [saveOpen, setSaveOpen] = useState(false);
    const [viewName, setViewName] = useState("");
    const [shareView, setShareView] = useState(false);
    const saved = data.savedView;
    const [editViewOpen, setEditViewOpen] = useState(false);
    const [savedViewName, setSavedViewName] = useState(saved?.name ?? "");

    const go = (next: Partial<ListFilters>) => window.location.assign(spaceHref(view.path, space, filterParams({ ...filters, ...next })));

    const saveView = async () => {
        try {
            const { view: created } = await knowledgeApi.createView(space.id, { name: viewName, shared: shareView, definition: filters });
            setSaveOpen(false);
            const target = spaceHref("/portal/knowledge/all", space, { saved: created.id });
            // The modal has a 200 ms exit animation. Navigating before it finishes can leave the
            // newly rendered document inert to assistive technology, so wait for that cleanup.
            window.setTimeout(() => window.location.assign(target), 250);
        } catch (e) {
            toast.error("Couldn't save the view", errorMessage(e));
        }
    };

    const deleteView = async () => {
        if (!saved) return;
        try {
            await knowledgeApi.deleteView(saved.id);
            go({});
        } catch (e) {
            toast.error("Couldn't delete the view", errorMessage(e));
        }
    };

    const renameView = async () => {
        if (!saved) return;
        try {
            const { view: updated } = await knowledgeApi.updateView(saved.id, { version: saved.version, name: savedViewName });
            setEditViewOpen(false);
            const target = spaceHref("/portal/knowledge/all", space, { saved: updated.id });
            window.setTimeout(() => window.location.assign(target), 250);
        } catch (e) {
            toast.error("Couldn't rename the view", errorMessage(e));
        }
    };

    const loadMore = async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams({ view: filters.view, offset: String(objects.length), limit: String(PAGE) });
            for (const [key, value] of Object.entries(filterParams(filters))) if (value) params.set(key, value);
            params.set("sort", filters.sort);
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
            <KnowledgeHeader
                title={saved?.name ?? view.title}
                description={saved ? `A saved view${saved.shared ? " shared with everyone in this space" : " only you can see"}.` : view.description}
                space={space}
                spaces={spaces}
                types={types}
                templates={data.templates}
                crumb={saved ? "Saved views" : view.title}
                actions={
                    <>
                        {data.views.length > 0 && (
                            <Select
                                aria-label="Saved views"
                                size="sm"
                                className="w-full sm:w-48"
                                placeholder="Saved views"
                                value={saved?.id ?? null}
                                onChange={(key) => key && window.location.assign(spaceHref("/portal/knowledge/all", space, { saved: String(key) }))}
                                items={data.views.map((v) => ({ id: v.id, label: v.name, supportingText: v.shared ? "Shared" : "Private" }))}
                            >
                                {(item) => (
                                    <Select.Item id={item.id} supportingText={item.supportingText}>
                                        {item.label}
                                    </Select.Item>
                                )}
                            </Select>
                        )}
                        {saved ? (
                            (saved.mine || canEdit) && (
                                <>
                                    <Button size="sm" color="secondary" iconLeading={Edit05} onClick={() => setEditViewOpen(true)}>
                                        Rename view
                                    </Button>
                                    <Button size="sm" color="tertiary-destructive" onClick={() => void deleteView()}>
                                        Delete view
                                    </Button>
                                </>
                            )
                        ) : (
                            <Button size="sm" color="secondary" iconLeading={Bookmark} onClick={() => setSaveOpen(true)}>
                                Save view
                            </Button>
                        )}
                    </>
                }
            />

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
                activeFilterCount={
                    (filters.typeId ? 1 : 0) +
                    (filters.tag ? 1 : 0) +
                    (filters.links && filters.links !== "any" ? 1 : 0) +
                    (filters.createdFrom || filters.createdTo ? 1 : 0) +
                    (filters.updatedFrom || filters.updatedTo ? 1 : 0)
                }
                onClearFilters={() => go({ typeId: null, tag: null, links: "any", createdFrom: null, createdTo: null, updatedFrom: null, updatedTo: null })}
                filters={
                    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
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
                        <Select
                            aria-label="Links"
                            size="sm"
                            className="sm:w-48"
                            value={filters.links ?? "any"}
                            onChange={(key) => go({ links: key as LinkFilter })}
                            items={(Object.keys(LINK_LABELS) as LinkFilter[]).map((id) => ({ id, label: LINK_LABELS[id] }))}
                        >
                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                        </Select>
                        <DateField label="Created from" value={filters.createdFrom ?? null} onChange={(value) => go({ createdFrom: value })} />
                        <DateField label="Created to" value={filters.createdTo ?? null} onChange={(value) => go({ createdTo: value })} />
                        <DateField label="Updated from" value={filters.updatedFrom ?? null} onChange={(value) => go({ updatedFrom: value })} />
                        <DateField label="Updated to" value={filters.updatedTo ?? null} onChange={(value) => go({ updatedTo: value })} />
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

            <PortalDialog
                isOpen={saveOpen}
                onOpenChange={setSaveOpen}
                title="Save this view"
                icon={Bookmark}
                description="Saves these filters and this sort under a name, so you can come back to them from the Saved views menu."
                onSubmit={() => void saveView()}
                footer={
                    <>
                        <Button color="secondary" onClick={() => setSaveOpen(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" isDisabled={!viewName.trim()}>
                            Save view
                        </Button>
                    </>
                }
            >
                <div className="flex flex-col gap-4">
                    <Input label="Name" value={viewName} onChange={setViewName} placeholder="e.g. Wedding people" autoFocus />
                    {space.kind === "shared" && canEdit && (
                        <Checkbox label="Share with everyone in this space" hint="Otherwise only you see it." isSelected={shareView} onChange={setShareView} />
                    )}
                </div>
            </PortalDialog>

            <PortalDialog
                isOpen={editViewOpen}
                onOpenChange={setEditViewOpen}
                title="Rename saved view"
                icon={Edit05}
                onSubmit={() => void renameView()}
                footer={
                    <>
                        <Button color="secondary" onClick={() => setEditViewOpen(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" isDisabled={!savedViewName.trim() || savedViewName.trim() === saved?.name}>
                            Save
                        </Button>
                    </>
                }
            >
                <Input label="Name" value={savedViewName} onChange={setSavedViewName} autoFocus />
            </PortalDialog>

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
