// Editing a template: its name, the new object's title, its starting document and property values,
// and whether it's the type's default. Saved with an explicit Save carrying the version it started
// from, so two people editing the same template can't overwrite each other.
import { Suspense, lazy, useState } from "react";
import { Archive, File06, Save01, Trash01 } from "@untitledui/icons";
import { BadgeWithDot } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Toggle } from "@/components/base/toggle/toggle";
import { PortalDialog } from "@/portal/components/dialog";
import { Skeleton } from "@/portal/components/empty";
import { Notice } from "@/portal/components/notice";
import { useToast } from "@/portal/components/toast";
import { ApiError, errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import type { DocNode } from "@/shared/knowledge/content";
import { type PropertyValue, isReferenceType } from "@/shared/knowledge/properties";
import { roleAtLeast } from "@/shared/knowledge/types";
import { KnowledgeHeader } from "../knowledge-header";
import { PropertyFields } from "../property-fields";
import { knowledgeApi, spaceHref } from "../shared";

const KnowledgeEditor = lazy(() => import("../editor/knowledge-editor"));

export const KnowledgeTemplatePage = ({ data }: { data: PageData<"knowledge-template"> }) => {
    const { space, spaces, types } = data;
    const toast = useToast();
    const canEdit = roleAtLeast(space.role, "editor");
    const [template, setTemplate] = useState(data.template);
    const [name, setName] = useState(template.name);
    const [description, setDescription] = useState(template.description);
    const [title, setTitle] = useState(template.title);
    const [content, setContent] = useState<DocNode>(template.content);
    const [properties, setProperties] = useState(template.properties);
    const [isDefault, setIsDefault] = useState(template.isDefault);
    const [dirty, setDirty] = useState(false);
    const [stale, setStale] = useState(false);
    const [saving, setSaving] = useState(false);
    const [deleteOpen, setDeleteOpen] = useState(false);
    const type = types.find((t) => t.id === template.typeId);
    // Templates hold starting values only; links to particular objects aren't copied.
    const defs = (type?.schema.properties ?? []).filter((d) => !isReferenceType(d.type)).map((d) => ({ ...d, required: false }));
    const edit = <T,>(set: (v: T) => void) => (v: T) => {
        set(v);
        setDirty(true);
    };

    const save = async (extra: Record<string, unknown> = {}) => {
        setSaving(true);
        try {
            const saved = await knowledgeApi.updateTemplate(template.id, {
                version: template.version,
                name,
                description,
                title,
                content,
                properties,
                isDefault,
                ...extra,
            });
            setTemplate(saved.template);
            setIsDefault(saved.template.isDefault);
            setDirty(false);
            toast.success("Template saved");
        } catch (e) {
            if (e instanceof ApiError && e.status === 409) setStale(true);
            else toast.error("Couldn't save the template", errorMessage(e));
        } finally {
            setSaving(false);
        }
    };

    const remove = async () => {
        try {
            await knowledgeApi.deleteTemplate(template.id);
            window.location.assign(spaceHref("/portal/knowledge/templates", space));
        } catch (e) {
            toast.error("Couldn't delete it", errorMessage(e));
        }
    };

    return (
        <>
            <KnowledgeHeader
                title={template.name}
                description={`A template for ${type?.name ?? "objects"}. Objects made from it are copies; changing it later doesn't change them.`}
                space={space}
                spaces={spaces}
                types={types}
                templates={data.templates}
                crumb="Templates"
                actions={
                    canEdit && (
                        <>
                            {dirty && (
                                <BadgeWithDot size="sm" color="gray">
                                    Unsaved changes
                                </BadgeWithDot>
                            )}
                            <Button size="sm" iconLeading={Save01} isLoading={saving} isDisabled={!dirty || stale || !name.trim()} onClick={() => void save()}>
                                Save
                            </Button>
                            <Button size="sm" color="secondary" iconLeading={Archive} onClick={() => void save({ archived: !template.archived })} isDisabled={stale}>
                                {template.archived ? "Unarchive" : "Archive"}
                            </Button>
                            <Button size="sm" color="tertiary-destructive" iconLeading={Trash01} onClick={() => setDeleteOpen(true)}>
                                Delete
                            </Button>
                        </>
                    )
                }
            />

            {stale && (
                <Notice
                    title="Someone else saved this template"
                    color="warning"
                    actions={
                        <Button size="sm" color="secondary" onClick={() => window.location.reload()}>
                            Load their version
                        </Button>
                    }
                >
                    Your changes haven't been saved. Copy anything you need, then load their version.
                </Notice>
            )}
            {template.archived && <Notice title="Archived">Archived templates aren't offered under New. Unarchive it to use it again.</Notice>}

            <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
                <div className="flex min-w-0 flex-col gap-4">
                    <Input
                        label="Title of new objects"
                        value={title}
                        onChange={edit(setTitle)}
                        isDisabled={!canEdit}
                        placeholder="Leave empty to start untitled"
                        hint="{date} becomes the day it's used, e.g. “Meeting {date}”."
                    />
                    <div className="rounded-xl p-4 ring-1 ring-secondary ring-inset">
                        <Suspense fallback={<Skeleton className="h-48 w-full" />}>
                            <KnowledgeEditor
                                initial={template.content}
                                editable={canEdit}
                                placeholder="Headings, prompts and checklists every new object should start with…"
                                onChange={edit(setContent)}
                                lookup={async (q) => (await knowledgeApi.lookup(space.id, q)).results.map((r) => ({ id: r.id, title: r.title }))}
                                createPage={async (newTitle) => {
                                    const created = await knowledgeApi.create(space.id, { title: newTitle });
                                    return { id: created.object.id, title: created.object.title };
                                }}
                            />
                        </Suspense>
                    </div>
                </div>
                <aside className="flex flex-col gap-5" aria-label="Template settings">
                    <Input label="Name" value={name} onChange={edit(setName)} isDisabled={!canEdit} />
                    <Input label="Description" value={description} onChange={edit(setDescription)} isDisabled={!canEdit} hint="Optional" />
                    <Toggle
                        label={`Default for ${type?.name ?? "this type"}`}
                        hint="Used when someone chooses this type under New."
                        isSelected={isDefault}
                        isDisabled={!canEdit || template.archived}
                        onChange={edit(setIsDefault)}
                    />
                    <section className="flex flex-col gap-3 border-t border-secondary pt-5">
                        <h2 className="flex items-center gap-2 text-sm font-semibold text-primary">
                            <File06 aria-hidden="true" className="size-4 text-fg-quaternary" />
                            Starting values
                        </h2>
                        <PropertyFields
                            defs={defs}
                            values={properties}
                            editable={canEdit}
                            spaceId={space.id}
                            types={types}
                            referenced={{}}
                            onChange={(key, value: PropertyValue | null) => {
                                const next = { ...properties };
                                if (value === null) delete next[key];
                                else next[key] = value;
                                setProperties(next);
                                setDirty(true);
                            }}
                        />
                    </section>
                </aside>
            </div>

            <PortalDialog
                isOpen={deleteOpen}
                onOpenChange={setDeleteOpen}
                title="Delete this template?"
                icon={Trash01}
                iconColor="error"
                description="Objects already made from it are kept as they are."
                footer={
                    <>
                        <Button color="secondary" onClick={() => setDeleteOpen(false)}>
                            Cancel
                        </Button>
                        <Button color="primary-destructive" onClick={() => void remove()}>
                            Delete template
                        </Button>
                    </>
                }
            />
        </>
    );
};
