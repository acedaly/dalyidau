// One knowledge object: its title and document, properties, tags, links and backlinks, history,
// and archive/trash/restore. Everything saves as you go.
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import {
    Archive,
    ClockRewind,
    DotsVertical,
    Download01,
    File06,
    FolderClosed,
    FolderPlus,
    HomeLine,
    Inbox01,
    Link03,
    Pin02,
    RefreshCcw01,
    Star01,
    Trash01,
    XClose,
} from "@untitledui/icons";
import { Breadcrumbs } from "@/components/application/breadcrumbs/breadcrumbs";
import { BadgeWithDot } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { Tag, TagGroup, TagList } from "@/components/base/tags/tags";
import { PortalDialog } from "@/portal/components/dialog";
import { Skeleton } from "@/portal/components/empty";
import { Notice } from "@/portal/components/notice";
import { Timestamp } from "@/portal/components/timestamp";
import { useToast } from "@/portal/components/toast";
import { api, errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import { type DocNode, normaliseDocument } from "@/shared/knowledge/content";
import type { KnowledgeCollection, KnowledgeLink, KnowledgeRevision, KnowledgeRevisionDetail, KnowledgeType } from "@/shared/knowledge/types";
import { roleAtLeast } from "@/shared/knowledge/types";
import { useCreateObject } from "../knowledge-header";
import { ObjectPicker } from "../object-picker";
import { PropertyFields } from "../property-fields";
import { RelatedKnowledge } from "../related-knowledge";
import { TypeIconFor, collectionHref, downloadExport, keepNotices, knowledgeApi, objectHref, spaceHref, takeNotices, titleOf } from "../shared";
import { type SaveState, useObjectSaver } from "../use-object-saver";

const KnowledgeEditor = lazy(() => import("../editor/knowledge-editor"));

const SAVE_LABELS: Record<SaveState, { label: string; color: "success" | "gray" | "warning" | "error" }> = {
    saved: { label: "Saved", color: "success" },
    pending: { label: "Unsaved changes", color: "gray" },
    saving: { label: "Saving…", color: "gray" },
    error: { label: "Not saved", color: "error" },
    conflict: { label: "Not saved: newer version", color: "warning" },
};

const Section = ({ title, children, actions }: { title: string; children: React.ReactNode; actions?: React.ReactNode }) => (
    <section className="flex flex-col gap-3 border-t border-secondary pt-5 first:border-t-0 first:pt-0">
        <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-primary">{title}</h2>
            {actions}
        </div>
        {children}
    </section>
);

const RELATION_PRESETS = [
    { id: "related", label: "Related to" },
    { id: "part_of", label: "Part of" },
    { id: "depends_on", label: "Depends on" },
    { id: "supports", label: "Supports" },
    { id: "source", label: "Source" },
    { id: "follow_up", label: "Follow-up" },
];
const relationLabel = (link: KnowledgeLink) =>
    link.origin === "content"
        ? "Mentioned"
        : (RELATION_PRESETS.find((p) => p.id === link.relationType)?.label ?? link.relationType.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()));

const LinkList = ({
    links,
    types,
    onRemove,
    empty,
    propertyLabel,
}: {
    links: KnowledgeLink[];
    types: KnowledgeType[];
    onRemove?: (link: KnowledgeLink) => void;
    empty: string;
    propertyLabel: (link: KnowledgeLink) => string;
}) =>
    links.length === 0 ? (
        <p className="text-sm text-tertiary">{empty}</p>
    ) : (
        <ul className="flex flex-col gap-1.5">
            {links.map((link) => (
                <li key={link.relationId} className="flex items-center gap-2 text-sm">
                    <TypeIconFor type={types.find((t) => t.id === link.object.typeId)} />
                    <a
                        href={objectHref(link.object.id)}
                        className="min-w-0 flex-1 truncate font-medium text-secondary hover:text-brand-secondary hover:underline"
                    >
                        {titleOf(link.object.title)}
                    </a>
                    <span className="shrink-0 text-xs text-tertiary">{link.origin === "property" ? propertyLabel(link) : relationLabel(link)}</span>
                    {onRemove && link.origin === "manual" && (
                        <ButtonUtility size="xs" color="tertiary" icon={XClose} tooltip="Remove link" onClick={() => onRemove(link)} />
                    )}
                </li>
            ))}
        </ul>
    );

const TitleField = ({
    value,
    onChange,
    editable,
    onEnter,
    autoFocus,
}: {
    value: string;
    onChange: (v: string) => void;
    editable: boolean;
    onEnter: () => void;
    autoFocus: boolean;
}) => {
    const ref = useRef<HTMLTextAreaElement>(null);
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = `${el.scrollHeight}px`;
    }, [value]);
    useEffect(() => {
        if (autoFocus) ref.current?.focus();
    }, [autoFocus]);
    return (
        <textarea
            ref={ref}
            aria-label="Title"
            rows={1}
            value={value}
            readOnly={!editable}
            placeholder="Untitled"
            maxLength={300}
            onChange={(event) => onChange(event.target.value.replace(/\n/g, " "))}
            onKeyDown={(event) => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    onEnter();
                }
            }}
            className="w-full resize-none overflow-hidden bg-transparent text-display-xs font-semibold text-primary outline-hidden placeholder:text-placeholder lg:text-display-sm"
        />
    );
};

const HistoryDialog = ({
    objectId,
    isOpen,
    onOpenChange,
    canRestore,
    onRestore,
}: {
    objectId: string;
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    canRestore: boolean;
    onRestore: (revision: KnowledgeRevision) => void;
}) => {
    const [revisions, setRevisions] = useState<KnowledgeRevision[] | null>(null);
    const [selected, setSelected] = useState<KnowledgeRevisionDetail | null>(null);
    const toast = useToast();
    useEffect(() => {
        if (!isOpen) return;
        setSelected(null);
        api<{ revisions: KnowledgeRevision[] }>("GET", `/api/portal/knowledge/objects/${objectId}/revisions`)
            .then((r) => setRevisions(r.revisions))
            .catch((e) => toast.error("Couldn't load the history", errorMessage(e)));
    }, [isOpen, objectId, toast]);
    const open = (revision: KnowledgeRevision) =>
        api<{ revision: KnowledgeRevisionDetail }>("GET", `/api/portal/knowledge/objects/${objectId}/revisions/${revision.id}`)
            .then((r) => setSelected(r.revision))
            .catch((e) => toast.error("Couldn't load that version", errorMessage(e)));
    let preview = "";
    if (selected) {
        try {
            preview = normaliseDocument(selected.content).text;
        } catch {
            preview = "";
        }
    }
    return (
        <PortalDialog
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            title="Version history"
            icon={ClockRewind}
            size="lg"
            description="Every editing session is kept. Restoring a version saves it as a new one, so nothing is lost."
        >
            <div className="grid gap-4 sm:grid-cols-[14rem_minmax(0,1fr)]">
                <ul className="flex max-h-96 flex-col gap-1 overflow-y-auto" aria-label="Versions">
                    {(revisions ?? []).map((revision) => (
                        <li key={revision.id}>
                            <button
                                type="button"
                                onClick={() => open(revision)}
                                aria-current={selected?.id === revision.id}
                                className="aria-[current=true]:bg-active w-full rounded-md px-3 py-2 text-left text-sm transition duration-100 ease-linear hover:bg-primary_hover"
                            >
                                <span className="block font-medium text-secondary">
                                    <Timestamp iso={revision.changedAt} />
                                </span>
                                <span className="block text-xs text-tertiary">
                                    {revision.kind === "create" ? "Created" : revision.kind === "restore" ? "Restored" : "Edited"} by {revision.changedBy}
                                </span>
                            </button>
                        </li>
                    ))}
                    {revisions === null && <Skeleton className="h-24" />}
                </ul>
                <div className="flex min-h-48 flex-col gap-3 rounded-lg bg-secondary p-4">
                    {selected ? (
                        <>
                            <p className="text-md font-semibold text-primary">{titleOf(selected.title)}</p>
                            <p className="max-h-72 overflow-y-auto text-sm whitespace-pre-wrap text-secondary">{preview || "No text."}</p>
                            {canRestore && (
                                <div>
                                    <Button size="sm" color="secondary" iconLeading={RefreshCcw01} onClick={() => onRestore(selected)}>
                                        Restore this version
                                    </Button>
                                </div>
                            )}
                        </>
                    ) : (
                        <p className="text-sm text-tertiary">Choose a version to see what it said.</p>
                    )}
                </div>
            </div>
        </PortalDialog>
    );
};

export const KnowledgeObjectPage = ({ data }: { data: PageData<"knowledge-object"> }) => {
    const { space, types } = data;
    const toast = useToast();
    const saver = useObjectSaver(data.detail);
    const { queue, flush } = saver;
    // An object page always starts with its object, so the saver always has one.
    const detail = saver.detail ?? data.detail;
    const object = detail.object;
    const type = types.find((t) => t.id === object.typeId);
    const trashed = object.status === "trashed";
    const editable = roleAtLeast(space.role, "editor") && !trashed;
    const [title, setTitle] = useState(object.title);
    const [tagDraft, setTagDraft] = useState("");
    const [historyOpen, setHistoryOpen] = useState(false);
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [confirmText, setConfirmText] = useState("");
    const [relationType, setRelationType] = useState("related");
    const editor = useRef<Editor | null>(null);
    const createObject = useCreateObject(space);
    const isNew = object.version === 1 && !object.title && !object.excerpt;
    const [favourite, setFavourite] = useState(data.state.favourite);
    const [pinned, setPinned] = useState(data.state.pinned);
    const [inCollections, setInCollections] = useState(data.collections);
    const [collectionOpen, setCollectionOpen] = useState(false);
    const [allCollections, setAllCollections] = useState<KnowledgeCollection[] | null>(null);
    const [templateOpen, setTemplateOpen] = useState(false);
    const [notices, setNotices] = useState<string[]>([]);
    const typeTemplates = data.templates.filter((t) => t.typeId === object.typeId);

    // Template values that didn't fit the type when this was created from one.
    useEffect(() => setNotices(takeNotices(object.id)), [object.id]);

    const toggleFavourite = async () => {
        try {
            await knowledgeApi.favourite(object.id, !favourite);
            setFavourite(!favourite);
            toast.success(favourite ? "Removed from your favourites" : "Added to your favourites");
        } catch (e) {
            toast.error("Couldn't change your favourites", errorMessage(e));
        }
    };

    const togglePin = async () => {
        try {
            await knowledgeApi.pin(object.id, !pinned);
            setPinned(!pinned);
            toast.success(pinned ? "Unpinned from the home page" : "Pinned to the home page");
        } catch (e) {
            toast.error("Couldn't pin it", errorMessage(e));
        }
    };

    const openCollections = async () => {
        setCollectionOpen(true);
        try {
            setAllCollections((await knowledgeApi.collections(space.id)).collections);
        } catch (e) {
            toast.error("Couldn't load collections", errorMessage(e));
        }
    };

    const addToCollection = async (collection: KnowledgeCollection) => {
        try {
            await knowledgeApi.addToCollection(collection.id, [object.id]);
            setInCollections([...inCollections, { id: collection.id, name: collection.name }].sort((a, b) => a.name.localeCompare(b.name)));
            setCollectionOpen(false);
            toast.success(`Added to ${collection.name}`);
        } catch (e) {
            toast.error("Couldn't add it", errorMessage(e));
        }
    };

    const removeFromCollection = async (collection: { id: string; name: string }) => {
        try {
            await knowledgeApi.removeFromCollection(collection.id, object.id);
            setInCollections(inCollections.filter((c) => c.id !== collection.id));
        } catch (e) {
            toast.error("Couldn't remove it", errorMessage(e));
        }
    };

    const applyTemplate = async (templateId: string) => {
        if (!(await flush())) return toast.error("Save your changes first", "There are changes that haven't been saved.");
        try {
            const updated = await knowledgeApi.applyTemplate(object.id, templateId, saver.version.current);
            // The document changed under the editor, so reload; the notices come along.
            keepNotices(object.id, updated.notices);
            window.location.reload();
        } catch (e) {
            toast.error("Couldn't add the template", errorMessage(e));
        }
    };
    const runExport = async (format: "markdown" | "json") => {
        if (!(await flush())) return toast.error("Save your changes first", "There are changes that haven't been saved.");
        try {
            await downloadExport(`/api/portal/knowledge/objects/${object.id}/export?format=${format}`);
        } catch (e) {
            toast.error("Couldn't export it", errorMessage(e));
        }
    };

    const runStatus = async (action: "archive" | "unarchive" | "trash" | "restore") => {
        if (!(await flush())) return toast.error("Save your changes first", "There are changes that haven't been saved.");
        try {
            await knowledgeApi.status(object.id, action);
            window.location.reload();
        } catch (e) {
            toast.error("Couldn't do that", errorMessage(e));
        }
    };

    const deletePermanently = async () => {
        try {
            await api("POST", `/api/portal/knowledge/objects/${object.id}/delete`, { confirm: confirmText });
            window.location.assign(spaceHref("/portal/knowledge/trash", space));
        } catch (e) {
            toast.error("Couldn't delete it", errorMessage(e));
        }
    };

    const restoreRevision = async (revision: KnowledgeRevision) => {
        if (!(await flush())) return toast.error("Save your changes first", "There are changes that haven't been saved.");
        try {
            await api("POST", `/api/portal/knowledge/objects/${object.id}/revisions/${revision.id}/restore`, { version: saver.version.current });
            window.location.reload();
        } catch (e) {
            toast.error("Couldn't restore that version", errorMessage(e));
        }
    };

    const addRelation = async (targetId: string) => {
        if (!(await flush())) return;
        try {
            const updated = await api<typeof detail>("POST", `/api/portal/knowledge/objects/${object.id}/relations`, { targetId, relationType });
            saver.setDetail(updated);
        } catch (e) {
            toast.error("Couldn't link them", errorMessage(e));
        }
    };

    const removeRelation = async (link: KnowledgeLink) => {
        try {
            await api("DELETE", `/api/portal/knowledge/relations/${link.relationId}`);
            saver.setDetail(await knowledgeApi.get(object.id));
        } catch (e) {
            toast.error("Couldn't remove the link", errorMessage(e));
        }
    };

    const addTag = () => {
        const tag = tagDraft.trim().replace(/^#/, "");
        setTagDraft("");
        if (!tag || object.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return;
        queue({ tags: [...object.tags, tag] }, true);
        saver.setDetail({ ...detail, object: { ...object, tags: [...object.tags, tag] } });
    };

    // A property link is named by the property on the object it comes from.
    const labelFrom = (sourceType: KnowledgeType | undefined) => (link: KnowledgeLink) =>
        sourceType?.schema.properties.find((p) => p.key === link.relationType)?.label ?? link.relationType;

    const save = SAVE_LABELS[saver.state];

    return (
        <article className="flex flex-col gap-6">
            <header className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <Breadcrumbs type="button" className="max-lg:hidden">
                        <Breadcrumbs.Item href="/portal" icon={HomeLine}>
                            <span className="sr-only">All applications</span>
                        </Breadcrumbs.Item>
                        <Breadcrumbs.Item href={spaceHref("/portal/knowledge", space)}>Knowledge</Breadcrumbs.Item>
                        <Breadcrumbs.Item href={spaceHref("/portal/knowledge/all", space, { type: object.typeId })}>{type?.name ?? "Objects"}</Breadcrumbs.Item>
                    </Breadcrumbs>
                    <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
                        {!trashed && editable && (
                            <span aria-live="polite">
                                <BadgeWithDot size="sm" color={save.color}>
                                    {save.label}
                                </BadgeWithDot>
                            </span>
                        )}
                        {object.inInbox && !trashed && editable && (
                            <Button
                                size="sm"
                                color="secondary"
                                iconLeading={Inbox01}
                                onClick={() => {
                                    queue({ inInbox: false }, true);
                                    saver.setDetail({ ...detail, object: { ...object, inInbox: false } });
                                }}
                            >
                                Done processing
                            </Button>
                        )}
                        {!trashed && (
                                <ButtonUtility
                                    size="sm"
                                    color={favourite ? "secondary" : "tertiary"}
                                    icon={<Star01 data-icon className={favourite ? "size-4 fill-current text-fg-warning-secondary" : "size-4"} aria-hidden="true" />}
                                    tooltip={favourite ? "Remove from favourites" : "Add to favourites"}
                                    aria-pressed={favourite}
                                    onClick={() => void toggleFavourite()}
                                />
                        )}
                        <Button size="sm" color="secondary" iconLeading={ClockRewind} onClick={() => setHistoryOpen(true)}>
                            History
                        </Button>
                        <Dropdown.Root>
                            <Button size="sm" color="tertiary" iconLeading={DotsVertical} aria-label="More actions" />
                            <Dropdown.Popover className="w-60">
                                <Dropdown.Menu
                                    onAction={(key) => {
                                        if (key === "delete") setDeleteOpen(true);
                                        else if (key === "pin") void togglePin();
                                        else if (key === "collection") void openCollections();
                                        else if (key === "template") setTemplateOpen(true);
                                        else if (key === "export-md") void runExport("markdown");
                                        else if (key === "export-json") void runExport("json");
                                        else void runStatus(key as "archive" | "unarchive" | "trash" | "restore");
                                    }}
                                >
                                    {editable && <Dropdown.Item id="pin" icon={Pin02} label={pinned ? "Unpin from home" : "Pin to home"} />}
                                    {editable && <Dropdown.Item id="collection" icon={FolderPlus} label="Add to a collection…" />}
                                    {editable && <Dropdown.Item id="template" icon={File06} label="Add a template…" />}
                                    <Dropdown.Item id="export-md" icon={Download01} label="Export as Markdown" />
                                    <Dropdown.Item id="export-json" icon={Download01} label="Export as JSON (with history)" />
                                    {roleAtLeast(space.role, "editor") && object.status === "active" && <Dropdown.Item id="archive" icon={Archive} label="Archive" />}
                                    {roleAtLeast(space.role, "editor") && object.status === "archived" && (
                                        <Dropdown.Item id="unarchive" icon={Archive} label="Unarchive" />
                                    )}
                                    {roleAtLeast(space.role, "editor") && !trashed && <Dropdown.Item id="trash" icon={Trash01} label="Move to trash" />}
                                    {roleAtLeast(space.role, "editor") && trashed && <Dropdown.Item id="restore" icon={RefreshCcw01} label="Restore from trash" />}
                                    {trashed && space.role === "owner" && <Dropdown.Item id="delete" icon={Trash01} label="Delete permanently…" />}
                                </Dropdown.Menu>
                            </Dropdown.Popover>
                        </Dropdown.Root>
                    </div>
                </div>

                {trashed && (
                    <Notice
                        title="This is in the trash"
                        color="warning"
                        actions={
                            roleAtLeast(space.role, "editor") ? (
                                <Button size="sm" color="secondary" onClick={() => runStatus("restore")}>
                                    Restore
                                </Button>
                            ) : undefined
                        }
                    >
                        It's hidden from lists, search and backlinks. Restore it to edit it again.
                    </Notice>
                )}
                {object.status === "archived" && (
                    <Notice
                        title="Archived"
                        actions={
                            editable ? (
                                <Button size="sm" color="secondary" onClick={() => runStatus("unarchive")}>
                                    Unarchive
                                </Button>
                            ) : undefined
                        }
                    >
                        Archived objects stay searchable but are kept out of everyday lists.
                    </Notice>
                )}
                {saver.state === "conflict" && (
                    <Notice
                        title="Someone else saved a newer version"
                        color="warning"
                        actions={
                            <>
                                <Button size="sm" onClick={() => void saver.keepMine()}>
                                    Keep my changes
                                </Button>
                                <Button size="sm" color="secondary" onClick={() => window.location.reload()}>
                                    Discard mine and load theirs
                                </Button>
                            </>
                        }
                    >
                        {saver.conflict?.updatedBy ? `${saver.conflict.updatedBy} saved this while you were editing. ` : ""}
                        Your recent changes haven't been saved. Keeping yours saves them on top; their version stays in the history.
                    </Notice>
                )}
                {saver.state === "error" && (
                    <Notice
                        title="Your changes haven't been saved"
                        color="error"
                        actions={
                            <Button size="sm" color="secondary" onClick={() => void flush()}>
                                Try again
                            </Button>
                        }
                    >
                        {saver.error}
                    </Notice>
                )}

                {notices.length > 0 && (
                    <Notice
                        title="Some template values weren't used"
                        actions={
                            <Button size="sm" color="secondary" onClick={() => setNotices([])}>
                                Dismiss
                            </Button>
                        }
                    >
                        <ul className="list-disc pl-5">
                            {notices.map((n) => (
                                <li key={n}>{n}</li>
                            ))}
                        </ul>
                    </Notice>
                )}

                <TitleField
                    value={title}
                    editable={editable}
                    autoFocus={isNew && editable}
                    onChange={(value) => {
                        setTitle(value);
                        queue({ title: value });
                    }}
                    onEnter={() => editor.current?.commands.focus("start")}
                />
            </header>

            <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
                <div className="min-w-0">
                    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
                        <KnowledgeEditor
                            initial={object.content as DocNode}
                            editable={editable}
                            placeholder="Write, type / for blocks or [[ to link…"
                            onChange={(doc) => queue({ content: doc })}
                            onReady={(instance) => {
                                editor.current = instance;
                            }}
                            lookup={async (q) => {
                                const { results } = await knowledgeApi.lookup(space.id, q);
                                return results
                                    .filter((r) => r.id !== object.id)
                                    .map((r) => ({ id: r.id, title: r.title, hint: types.find((t) => t.id === r.typeId)?.name }));
                            }}
                            createPage={async (newTitle) => {
                                const created = await knowledgeApi.create(space.id, { title: newTitle });
                                return { id: created.object.id, title: created.object.title };
                            }}
                        />
                    </Suspense>
                </div>

                <aside className="flex flex-col gap-5 lg:sticky lg:top-6 lg:self-start" aria-label="Details">
                    <Section title="Type">
                        <Select
                            aria-label="Object type"
                            size="sm"
                            isDisabled={!editable}
                            value={object.typeId}
                            onChange={(key) => {
                                if (!key || key === object.typeId) return;
                                queue({ typeId: String(key) }, true);
                            }}
                            items={types.filter((t) => !t.archived || t.id === object.typeId).map((t) => ({ id: t.id, label: t.name }))}
                        >
                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                        </Select>
                    </Section>

                    <Section title="Properties">
                        <PropertyFields
                            defs={type?.schema.properties ?? []}
                            values={object.properties}
                            editable={editable}
                            spaceId={space.id}
                            types={types}
                            referenced={detail.referenced}
                            onChange={(key, value) => queue({ properties: { [key]: value } }, true)}
                        />
                    </Section>

                    <Section title="Tags">
                        {object.tags.length > 0 ? (
                            <TagGroup
                                label="Tags"
                                size="md"
                                onRemove={
                                    editable
                                        ? (keys) => {
                                              const next = object.tags.filter((t) => !keys.has(t));
                                              queue({ tags: next }, true);
                                              saver.setDetail({ ...detail, object: { ...object, tags: next } });
                                          }
                                        : undefined
                                }
                            >
                                <TagList className="flex flex-wrap gap-1.5">
                                    {object.tags.map((tag) => (
                                        <Tag key={tag} id={tag}>
                                            {tag}
                                        </Tag>
                                    ))}
                                </TagList>
                            </TagGroup>
                        ) : (
                            !editable && <p className="text-sm text-tertiary">No tags.</p>
                        )}
                        {editable && (
                            <Input
                                aria-label="Add a tag"
                                size="sm"
                                placeholder="Add a tag and press Enter"
                                value={tagDraft}
                                onChange={setTagDraft}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") {
                                        event.preventDefault();
                                        addTag();
                                    }
                                }}
                            />
                        )}
                    </Section>

                    <Section title="Links">
                        <LinkList
                            links={detail.outgoing}
                            types={types}
                            onRemove={editable ? removeRelation : undefined}
                            empty="No links yet. Type [[ in the text to link."
                            propertyLabel={labelFrom(type)}
                        />
                        {editable && (
                            <div className="flex flex-col gap-2">
                                <Select
                                    aria-label="Kind of link"
                                    size="sm"
                                    value={relationType}
                                    onChange={(key) => setRelationType(String(key))}
                                    items={RELATION_PRESETS}
                                >
                                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                                </Select>
                                <ObjectPicker
                                    spaceId={space.id}
                                    types={types}
                                    placeholder="Link to an object"
                                    exclude={[object.id]}
                                    onPick={(picked) => void addRelation(picked.id)}
                                />
                            </div>
                        )}
                    </Section>

                    <Section title={`Backlinks${detail.backlinks.length ? ` (${detail.backlinks.length})` : ""}`}>
                        <LinkList
                            links={detail.backlinks}
                            types={types}
                            empty="Nothing links here yet."
                            propertyLabel={(link) => labelFrom(types.find((t) => t.id === link.object.typeId))(link)}
                        />
                        {editable && (
                            <Button
                                size="sm"
                                color="link-gray"
                                iconLeading={Link03}
                                onClick={() =>
                                    createObject(undefined, {
                                        title: `Re: ${titleOf(title)}`,
                                        content: {
                                            type: "doc",
                                            content: [
                                                { type: "paragraph", content: [{ type: "objectLink", attrs: { id: object.id, label: titleOf(title) } }] },
                                            ],
                                        },
                                    })
                                }
                            >
                                New note linking here
                            </Button>
                        )}
                    </Section>

                    <Section
                        title="Collections"
                        actions={
                            editable && (
                                <ButtonUtility size="xs" color="tertiary" icon={FolderPlus} tooltip="Add to a collection" onClick={() => void openCollections()} />
                            )
                        }
                    >
                        {inCollections.length ? (
                            <ul className="flex flex-col gap-1.5">
                                {inCollections.map((c) => (
                                    <li key={c.id} className="flex items-center gap-2 text-sm">
                                        <FolderClosed aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
                                        <a
                                            href={collectionHref(c.id)}
                                            className="min-w-0 flex-1 truncate font-medium text-secondary hover:text-brand-secondary hover:underline"
                                        >
                                            {c.name}
                                        </a>
                                        {editable && (
                                            <ButtonUtility
                                                size="xs"
                                                color="tertiary"
                                                icon={XClose}
                                                tooltip={`Remove from ${c.name}`}
                                                onClick={() => void removeFromCollection(c)}
                                            />
                                        )}
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="text-sm text-tertiary">Not in a collection.</p>
                        )}
                    </Section>

                    {!trashed && <RelatedKnowledge objectId={object.id} types={types} />}

                    <Section title="Details">
                        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
                            <dt className="text-tertiary">Created</dt>
                            <dd className="truncate text-secondary">
                                <Timestamp iso={object.createdAt} /> · {object.createdBy}
                            </dd>
                            <dt className="text-tertiary">Updated</dt>
                            <dd className="truncate text-secondary">
                                <Timestamp iso={object.updatedAt} relative /> · {object.updatedBy}
                            </dd>
                            <dt className="text-tertiary">Space</dt>
                            <dd className="truncate text-secondary">{space.name}</dd>
                        </dl>
                    </Section>
                </aside>
            </div>

            <PortalDialog
                isOpen={collectionOpen}
                onOpenChange={setCollectionOpen}
                title="Add to a collection"
                icon={FolderPlus}
                description="An object can be in any number of collections. Nothing is copied."
            >
                {allCollections === null ? (
                    <Skeleton className="h-24" />
                ) : allCollections.filter((c) => !inCollections.some((i) => i.id === c.id)).length ? (
                    <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto" aria-label="Collections">
                        {allCollections
                            .filter((c) => !inCollections.some((i) => i.id === c.id))
                            .map((c) => (
                                <li key={c.id}>
                                    <button
                                        type="button"
                                        onClick={() => void addToCollection(c)}
                                        className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm outline-focus-ring transition duration-100 ease-linear hover:bg-primary_hover focus-visible:outline-2"
                                    >
                                        <FolderClosed aria-hidden="true" className="size-4 text-fg-quaternary" />
                                        <span className="min-w-0 flex-1 truncate font-medium text-secondary">{c.name}</span>
                                        <span className="text-xs text-tertiary tabular-nums">{c.itemCount}</span>
                                    </button>
                                </li>
                            ))}
                    </ul>
                ) : (
                    <p className="text-sm text-tertiary">
                        {allCollections.length ? "It's already in every collection." : "There are no collections yet."}{" "}
                        <a href={spaceHref("/portal/knowledge/collections", space)} className="font-medium text-brand-secondary hover:underline">
                            Manage collections
                        </a>
                    </p>
                )}
            </PortalDialog>

            <PortalDialog
                isOpen={templateOpen}
                onOpenChange={setTemplateOpen}
                title="Add a template"
                icon={File06}
                description="The template's text goes after what's already here, and its values only fill properties that are empty. Nothing is overwritten."
            >
                {typeTemplates.length ? (
                    <ul className="flex flex-col gap-1" aria-label="Templates">
                        {typeTemplates.map((t) => (
                            <li key={t.id}>
                                <button
                                    type="button"
                                    onClick={() => void applyTemplate(t.id)}
                                    className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm outline-focus-ring transition duration-100 ease-linear hover:bg-primary_hover focus-visible:outline-2"
                                >
                                    <File06 aria-hidden="true" className="size-4 text-fg-quaternary" />
                                    <span className="min-w-0 flex-1 truncate font-medium text-secondary">{t.name}</span>
                                </button>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="text-sm text-tertiary">
                        There are no templates for {type?.name ?? "this type"} yet.{" "}
                        <a href={spaceHref("/portal/knowledge/templates", space)} className="font-medium text-brand-secondary hover:underline">
                            Make one
                        </a>
                    </p>
                )}
            </PortalDialog>

            <HistoryDialog objectId={object.id} isOpen={historyOpen} onOpenChange={setHistoryOpen} canRestore={editable} onRestore={restoreRevision} />

            <PortalDialog
                isOpen={deleteOpen}
                onOpenChange={setDeleteOpen}
                title="Delete permanently?"
                icon={Trash01}
                iconColor="error"
                description="This deletes the object and all of its history. It can't be undone. Links from other objects to it disappear."
                onSubmit={() => void deletePermanently()}
                footer={
                    <>
                        <Button color="secondary" onClick={() => setDeleteOpen(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" color="primary-destructive" isDisabled={confirmText !== "DELETE"}>
                            Delete permanently
                        </Button>
                    </>
                }
            >
                <Input label="Type DELETE to confirm" value={confirmText} onChange={setConfirmText} autoComplete="off" />
            </PortalDialog>
        </article>
    );
};
