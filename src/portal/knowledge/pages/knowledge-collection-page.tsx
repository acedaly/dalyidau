// One collection: its objects in their own order (pinned first), with filtering, reordering by
// keyboard or touch (move up and down), pinning, adding and removing. Removing an object, or
// deleting the whole collection, never touches the objects themselves.
import { useState } from "react";
import { ArrowDown, ArrowUp, Archive, Edit05, FolderClosed, Pin02, SearchLg, Trash01, XClose } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Input } from "@/components/base/input/input";
import { TextArea } from "@/components/base/textarea/textarea";
import { PortalDialog } from "@/portal/components/dialog";
import { Empty } from "@/portal/components/empty";
import { Notice } from "@/portal/components/notice";
import { Timestamp } from "@/portal/components/timestamp";
import { useToast } from "@/portal/components/toast";
import { api, errorMessage } from "@/portal/lib/api";
import { pluralise } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { type CollectionItem, roleAtLeast } from "@/shared/knowledge/types";
import { KnowledgeHeader } from "../knowledge-header";
import { ObjectPicker } from "../object-picker";
import { TypeIconFor, knowledgeApi, objectHref, spaceHref, titleOf } from "../shared";

export const KnowledgeCollectionPage = ({ data }: { data: PageData<"knowledge-collection"> }) => {
    const { space, spaces, types } = data;
    const toast = useToast();
    const canEdit = roleAtLeast(space.role, "editor");
    const [collection, setCollection] = useState(data.collection);
    const [items, setItems] = useState(data.items);
    const [total, setTotal] = useState(data.total);
    const [filter, setFilter] = useState("");
    const [editOpen, setEditOpen] = useState(false);
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [name, setName] = useState(collection.name);
    const [description, setDescription] = useState(collection.description);
    const [busy, setBusy] = useState(false);

    const reload = async () => {
        const fresh = await api<{ items: CollectionItem[]; total: number }>("GET", `/api/portal/knowledge/collections/${collection.id}`);
        setItems(fresh.items);
        setTotal(fresh.total);
    };

    const act = async (label: string, run: () => Promise<unknown>) => {
        if (busy) return;
        setBusy(true);
        try {
            await run();
            await reload();
        } catch (e) {
            toast.error(label, errorMessage(e));
        } finally {
            setBusy(false);
        }
    };

    const needle = filter.trim().toLowerCase();
    const shown = needle ? items.filter((i) => `${i.title} ${i.excerpt} ${i.tags.join(" ")}`.toLowerCase().includes(needle)) : items;

    // Moving within its group (pinned or not): up goes after the item two above, down after the next.
    const move = (item: CollectionItem, direction: -1 | 1) => {
        const group = items.filter((i) => i.pinned === item.pinned);
        const index = group.findIndex((i) => i.id === item.id);
        const target = index + direction;
        if (target < 0 || target >= group.length) return;
        const afterId = direction === -1 ? (group[index - 2]?.id ?? null) : group[index + 1].id;
        void act("Couldn't move it", () => knowledgeApi.moveInCollection(collection.id, item.id, afterId));
    };

    const saveDetails = async () => {
        try {
            const updated = await knowledgeApi.updateCollection(collection.id, { version: collection.version, name, description });
            setCollection(updated.collection);
            setEditOpen(false);
        } catch (e) {
            toast.error("Couldn't save the collection", errorMessage(e));
        }
    };

    const setArchived = async (archived: boolean) => {
        try {
            setCollection((await knowledgeApi.updateCollection(collection.id, { version: collection.version, archived })).collection);
        } catch (e) {
            toast.error("Couldn't change the collection", errorMessage(e));
        }
    };

    const remove = async () => {
        try {
            await knowledgeApi.deleteCollection(collection.id);
            window.location.assign(spaceHref("/portal/knowledge/collections", space));
        } catch (e) {
            toast.error("Couldn't delete the collection", errorMessage(e));
        }
    };

    return (
        <>
            <KnowledgeHeader
                title={collection.name}
                description={collection.description || `${pluralise(total, "object")} in this collection.`}
                space={space}
                spaces={spaces}
                types={types}
                templates={data.templates}
                crumb="Collections"
                actions={
                    canEdit && (
                        <>
                            <ButtonUtility size="sm" color="secondary" icon={Edit05} tooltip="Rename" onClick={() => setEditOpen(true)} />
                            <ButtonUtility
                                size="sm"
                                color="secondary"
                                icon={Archive}
                                tooltip={collection.archived ? "Unarchive" : "Archive"}
                                onClick={() => void setArchived(!collection.archived)}
                            />
                            <ButtonUtility size="sm" color="secondary" icon={Trash01} tooltip="Delete collection" onClick={() => setDeleteOpen(true)} />
                        </>
                    )
                }
            />

            {collection.archived && <Notice title="This collection is archived">It's hidden from the sidebar and home. Its objects are unaffected.</Notice>}

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                {items.length > 0 && (
                    <Input aria-label="Filter this collection" icon={SearchLg} size="sm" placeholder="Filter by title, text or tag" value={filter} onChange={setFilter} className="sm:w-72" />
                )}
                {canEdit && (
                    <div className="sm:ml-auto sm:w-80">
                        <ObjectPicker
                            spaceId={space.id}
                            types={types}
                            placeholder="Add an object to this collection"
                            exclude={items.map((i) => i.id)}
                            onPick={(picked) => void act("Couldn't add it", () => knowledgeApi.addToCollection(collection.id, [picked.id]))}
                        />
                    </div>
                )}
            </div>

            {shown.length ? (
                <ol aria-label="Objects in this collection" className="flex flex-col divide-y divide-secondary rounded-xl bg-primary shadow-xs ring-1 ring-secondary ring-inset">
                    {shown.map((item) => {
                        const type = types.find((t) => t.id === item.typeId);
                        return (
                            <li key={item.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4 sm:px-5">
                                <div className="flex min-w-0 flex-1 items-start gap-3">
                                    <TypeIconFor type={type} className="mt-0.5" />
                                    <div className="min-w-0 flex-1">
                                        <a href={objectHref(item.id)} className="block truncate text-sm font-medium text-primary hover:underline">
                                            {titleOf(item.title)}
                                        </a>
                                        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-tertiary">
                                            {item.pinned && (
                                                <Badge size="sm" color="brand">
                                                    Pinned
                                                </Badge>
                                            )}
                                            <span>{type?.name}</span>
                                            <span>
                                                · updated <Timestamp iso={item.updatedAt} relative />
                                            </span>
                                            {item.tags.slice(0, 3).map((tag) => (
                                                <Badge key={tag} size="sm" color="gray">
                                                    {tag}
                                                </Badge>
                                            ))}
                                        </p>
                                    </div>
                                </div>
                                {canEdit && !needle && (
                                    <div className="flex shrink-0 items-center gap-1 self-end sm:self-auto">
                                        <ButtonUtility size="xs" color="tertiary" icon={ArrowUp} tooltip={`Move ${titleOf(item.title)} up`} onClick={() => move(item, -1)} />
                                        <ButtonUtility size="xs" color="tertiary" icon={ArrowDown} tooltip={`Move ${titleOf(item.title)} down`} onClick={() => move(item, 1)} />
                                        <ButtonUtility
                                            size="xs"
                                            color={item.pinned ? "secondary" : "tertiary"}
                                            icon={Pin02}
                                            tooltip={item.pinned ? "Unpin" : "Pin to the top"}
                                            aria-pressed={item.pinned}
                                            onClick={() => void act("Couldn't pin it", () => knowledgeApi.pinInCollection(collection.id, item.id, !item.pinned))}
                                        />
                                        <ButtonUtility
                                            size="xs"
                                            color="tertiary"
                                            icon={XClose}
                                            tooltip={`Remove ${titleOf(item.title)} from this collection`}
                                            onClick={() => void act("Couldn't remove it", () => knowledgeApi.removeFromCollection(collection.id, item.id))}
                                        />
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ol>
            ) : items.length ? (
                <p className="text-sm text-tertiary">Nothing in this collection matches “{filter}”.</p>
            ) : (
                <Empty
                    icon={FolderClosed}
                    title="This collection is empty"
                    description={canEdit ? "Add objects with the box above, or from an object's page." : "Nothing has been added yet."}
                />
            )}
            {items.length < total && <p className="text-sm text-tertiary">Showing the first {items.length} of {total}.</p>}

            <PortalDialog
                isOpen={editOpen}
                onOpenChange={setEditOpen}
                title="Rename collection"
                icon={Edit05}
                onSubmit={() => void saveDetails()}
                footer={
                    <>
                        <Button color="secondary" onClick={() => setEditOpen(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" isDisabled={!name.trim()}>
                            Save
                        </Button>
                    </>
                }
            >
                <div className="flex flex-col gap-4">
                    <Input label="Name" value={name} onChange={setName} />
                    <TextArea label="Description" value={description} onChange={setDescription} rows={3} />
                </div>
            </PortalDialog>

            <PortalDialog
                isOpen={deleteOpen}
                onOpenChange={setDeleteOpen}
                title="Delete this collection?"
                icon={Trash01}
                iconColor="error"
                description={`The collection goes, but its ${pluralise(total, "object")} stay exactly as they are, in your space and in any other collection.`}
                footer={
                    <>
                        <Button color="secondary" onClick={() => setDeleteOpen(false)}>
                            Cancel
                        </Button>
                        <Button color="primary-destructive" onClick={() => void remove()}>
                            Delete collection
                        </Button>
                    </>
                }
            />
        </>
    );
};
