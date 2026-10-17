// Collections: named groups of objects. An object can be in any number of them and nothing is
// copied; deleting a collection leaves its objects exactly where they were.
import { useState } from "react";
import { FolderClosed, FolderPlus } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { TextArea } from "@/components/base/textarea/textarea";
import { PortalDialog } from "@/portal/components/dialog";
import { Empty } from "@/portal/components/empty";
import { Timestamp } from "@/portal/components/timestamp";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import { pluralise } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { roleAtLeast } from "@/shared/knowledge/types";
import { KnowledgeHeader } from "../knowledge-header";
import { collectionHref, knowledgeApi } from "../shared";

export const KnowledgeCollectionsPage = ({ data }: { data: PageData<"knowledge-collections"> }) => {
    const { space, spaces, types } = data;
    const toast = useToast();
    const canEdit = roleAtLeast(space.role, "editor");
    const [open, setOpen] = useState(false);
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const live = data.collections.filter((c) => !c.archived);
    const archived = data.collections.filter((c) => c.archived);

    const create = async () => {
        try {
            const { collection } = await knowledgeApi.createCollection(space.id, { name, description });
            window.location.assign(collectionHref(collection.id));
        } catch (e) {
            toast.error("Couldn't create the collection", errorMessage(e));
        }
    };

    const Grid = ({ items }: { items: typeof data.collections }) => (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((c) => (
                <li key={c.id}>
                    <a
                        href={collectionHref(c.id)}
                        className="flex h-full flex-col gap-1 rounded-xl bg-primary p-4 shadow-xs ring-1 ring-secondary transition duration-100 ease-linear ring-inset hover:bg-primary_hover"
                    >
                        <span className="flex items-center gap-2">
                            <FolderClosed aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
                            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-primary">{c.name}</span>
                            {c.archived && (
                                <Badge size="sm" color="gray">
                                    Archived
                                </Badge>
                            )}
                        </span>
                        {c.description && <span className="line-clamp-2 text-sm text-tertiary">{c.description}</span>}
                        <span className="mt-auto pt-2 text-xs text-tertiary">
                            {pluralise(c.itemCount, "object")} · updated <Timestamp iso={c.updatedAt} relative />
                        </span>
                    </a>
                </li>
            ))}
        </ul>
    );

    return (
        <>
            <KnowledgeHeader
                title="Collections"
                description="Group related objects without copying them. An object can be in as many collections as you like."
                space={space}
                spaces={spaces}
                types={types}
                templates={data.templates}
                crumb="Collections"
                actions={
                    canEdit && (
                        <Button size="sm" color="secondary" iconLeading={FolderPlus} onClick={() => setOpen(true)}>
                            New collection
                        </Button>
                    )
                }
            />

            {live.length ? (
                <Grid items={live} />
            ) : (
                <Empty
                    icon={FolderClosed}
                    title="No collections yet"
                    description="Collections are for things that belong together: a trip, a house project, a reading list."
                    actions={
                        canEdit && (
                            <Button iconLeading={FolderPlus} onClick={() => setOpen(true)}>
                                New collection
                            </Button>
                        )
                    }
                />
            )}

            {archived.length > 0 && (
                <section className="flex flex-col gap-3">
                    <h2 className="text-sm font-semibold text-tertiary">Archived</h2>
                    <Grid items={archived} />
                </section>
            )}

            <PortalDialog
                isOpen={open}
                onOpenChange={setOpen}
                title="New collection"
                icon={FolderPlus}
                onSubmit={() => void create()}
                footer={
                    <>
                        <Button color="secondary" onClick={() => setOpen(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" isDisabled={!name.trim()}>
                            Create
                        </Button>
                    </>
                }
            >
                <div className="flex flex-col gap-4">
                    <Input label="Name" value={name} onChange={setName} placeholder="e.g. Kitchen renovation" autoFocus />
                    <TextArea label="Description" value={description} onChange={setDescription} rows={3} hint="Optional" />
                </div>
            </PortalDialog>
        </>
    );
};
