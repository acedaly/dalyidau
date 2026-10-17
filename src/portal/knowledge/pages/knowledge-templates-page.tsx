// Templates: reusable starting points for a type (a meeting's headings, a person's sections). New
// objects made from one are copies, so changing a template later never changes them.
import { useState } from "react";
import { File06, Plus } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { PortalDialog } from "@/portal/components/dialog";
import { Empty } from "@/portal/components/empty";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import { roleAtLeast } from "@/shared/knowledge/types";
import { KnowledgeHeader } from "../knowledge-header";
import { TypeIconFor, knowledgeApi, templateHref } from "../shared";

export const KnowledgeTemplatesPage = ({ data }: { data: PageData<"knowledge-templates"> }) => {
    const { space, spaces, types, allTemplates } = data;
    const toast = useToast();
    const canEdit = roleAtLeast(space.role, "editor");
    const liveTypes = types.filter((t) => !t.archived);
    const [open, setOpen] = useState(false);
    const [name, setName] = useState("");
    const [typeId, setTypeId] = useState(liveTypes[0]?.id ?? "");

    const create = async () => {
        try {
            const { template } = await knowledgeApi.createTemplate(space.id, { name, typeId });
            window.location.assign(templateHref(template.id));
        } catch (e) {
            toast.error("Couldn't create the template", errorMessage(e));
        }
    };

    const groups = types.map((type) => ({ type, templates: allTemplates.filter((t) => t.typeId === type.id) })).filter((g) => g.templates.length);

    return (
        <>
            <KnowledgeHeader
                title="Templates"
                description="Starting points for new objects: headings, prompts and property values. Objects made from a template are copies."
                space={space}
                spaces={spaces}
                types={types}
                templates={data.templates}
                crumb="Templates"
                actions={
                    canEdit && (
                        <Button size="sm" color="secondary" iconLeading={Plus} onClick={() => setOpen(true)}>
                            New template
                        </Button>
                    )
                }
            />

            {groups.length ? (
                <div className="flex flex-col gap-6">
                    {groups.map(({ type, templates }) => (
                        <section key={type.id} className="flex flex-col gap-2">
                            <h2 className="flex items-center gap-2 text-sm font-semibold text-secondary">
                                <TypeIconFor type={type} />
                                {type.name}
                            </h2>
                            <ul className="flex flex-col divide-y divide-secondary rounded-xl bg-primary shadow-xs ring-1 ring-secondary ring-inset">
                                {templates.map((t) => (
                                    <li key={t.id}>
                                        <a
                                            href={templateHref(t.id)}
                                            className="flex items-center gap-3 px-4 py-3 transition duration-100 ease-linear hover:bg-primary_hover sm:px-5"
                                        >
                                            <File06 aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
                                            <span className="min-w-0 flex-1">
                                                <span className="block truncate text-sm font-medium text-primary">{t.name}</span>
                                                {t.description && <span className="line-clamp-1 text-sm text-tertiary">{t.description}</span>}
                                            </span>
                                            {t.isDefault && (
                                                <Badge size="sm" color="brand">
                                                    Default
                                                </Badge>
                                            )}
                                            {t.archived && (
                                                <Badge size="sm" color="gray">
                                                    Archived
                                                </Badge>
                                            )}
                                        </a>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    ))}
                </div>
            ) : (
                <Empty
                    icon={File06}
                    title="No templates yet"
                    description="A meeting template might have Purpose, Attendees, Discussion, Decisions and Actions headings. A person template might have Background and Follow-up."
                    actions={
                        canEdit && (
                            <Button iconLeading={Plus} onClick={() => setOpen(true)}>
                                New template
                            </Button>
                        )
                    }
                />
            )}

            <PortalDialog
                isOpen={open}
                onOpenChange={setOpen}
                title="New template"
                icon={File06}
                description="Choose the type it makes. You'll write its content next."
                onSubmit={() => void create()}
                footer={
                    <>
                        <Button color="secondary" onClick={() => setOpen(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" isDisabled={!name.trim() || !typeId}>
                            Create
                        </Button>
                    </>
                }
            >
                <div className="flex flex-col gap-4">
                    <Input label="Name" value={name} onChange={setName} placeholder="e.g. Meeting notes" autoFocus />
                    <Select label="Type" value={typeId} onChange={(key) => key && setTypeId(String(key))} items={liveTypes.map((t) => ({ id: t.id, label: t.name }))}>
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                </div>
            </PortalDialog>
        </>
    );
};
