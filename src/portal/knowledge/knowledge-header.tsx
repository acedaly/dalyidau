// The header on every Knowledge page: breadcrumbs, title, the space switcher, a search box and
// "New" for creating an object of any type. Built from the portal PageHeader and Untitled UI parts.
import type { ReactNode } from "react";
import { useState } from "react";
import { Plus, SearchLg } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { PageHeader } from "@/portal/components/page-header";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import { roleAtLeast } from "@/shared/knowledge/types";
import type { KnowledgeSpace, KnowledgeType, TemplateRef } from "@/shared/knowledge/types";
import { KnowledgeCommands } from "./knowledge-commands";
import { TypeIconFor, keepNotices, knowledgeApi, objectHref, spaceHref } from "./shared";

interface KnowledgeHeaderProps {
    title: string;
    description?: ReactNode;
    space: KnowledgeSpace;
    spaces: KnowledgeSpace[];
    types: KnowledgeType[];
    /** Templates offered under "New". */
    templates?: TemplateRef[];
    /** Extra breadcrumb after "Knowledge". */
    crumb?: string;
    actions?: ReactNode;
    children?: ReactNode;
    /** Pages that already have a search box hide this one. */
    hideSearch?: boolean;
}

export const useCreateObject = (space: KnowledgeSpace) => {
    const toast = useToast();
    return async (typeId?: string, extra: Record<string, unknown> = {}) => {
        try {
            const created = await knowledgeApi.create(space.id, { title: "", ...(typeId ? { typeId } : {}), ...extra });
            keepNotices(created.object.id, created.notices);
            window.location.assign(objectHref(created.object.id));
        } catch (error) {
            toast.error("Couldn't create it", errorMessage(error));
        }
    };
};

export const KnowledgeHeader = ({ title, description, space, spaces, types, templates = [], crumb, actions, children, hideSearch }: KnowledgeHeaderProps) => {
    const [query, setQuery] = useState("");
    const create = useCreateObject(space);
    const canEdit = roleAtLeast(space.role, "editor");
    const liveTypes = types.filter((t) => !t.archived);

    return (
        <PageHeader
            title={title}
            description={description}
            breadcrumbs={[{ label: "Knowledge", href: spaceHref("/portal/knowledge", space) }, ...(crumb ? [{ label: crumb }] : [])]}
            actions={
                <>
                    {spaces.length > 1 && (
                        <Select
                            aria-label="Space"
                            size="sm"
                            className="w-full sm:w-52"
                            value={space.id}
                            onChange={(key) => {
                                const next = spaces.find((s) => s.id === key);
                                if (next && next.id !== space.id) window.location.assign(spaceHref(window.location.pathname.replace(/\/o\/.*$/, ""), next));
                            }}
                            items={spaces.map((s) => ({ id: s.id, label: s.name, supportingText: s.kind === "personal" ? "Personal" : s.role }))}
                        >
                            {(item) => (
                                <Select.Item id={item.id} supportingText={item.supportingText}>
                                    {item.label}
                                </Select.Item>
                            )}
                        </Select>
                    )}
                    {!hideSearch && (
                        <form role="search" action="/portal/knowledge/search" method="get" className="w-full sm:w-64">
                            {space.kind !== "personal" && <input type="hidden" name="space" value={space.id} />}
                            <Input aria-label="Search knowledge" name="q" size="sm" icon={SearchLg} placeholder="Search" value={query} onChange={setQuery} />
                        </form>
                    )}
                    <KnowledgeCommands space={space} spaces={spaces} types={types} onNewPage={() => void create(undefined, { useDefaultTemplate: true })} />
                    {actions}
                    {canEdit && (
                        <Dropdown.Root>
                            <Button size="sm" iconLeading={Plus}>
                                New
                            </Button>
                            <Dropdown.Popover className="w-64">
                                <Dropdown.Menu
                                    onAction={(key) => {
                                        const [kind, id] = String(key).split(":");
                                        // A type's default template is used unless they pick another (or "blank").
                                        void (kind === "template" ? create(undefined, { templateId: id }) : create(id, { useDefaultTemplate: true }));
                                    }}
                                >
                                    <Dropdown.Section>
                                        {liveTypes.map((type) => (
                                            <Dropdown.Item key={type.id} id={`type:${type.id}`} textValue={type.name}>
                                                <span className="flex items-center gap-2">
                                                    <TypeIconFor type={type} />
                                                    {type.name}
                                                </span>
                                            </Dropdown.Item>
                                        ))}
                                    </Dropdown.Section>
                                    {templates.length > 0 && (
                                        <Dropdown.Section>
                                            <Dropdown.SectionHeader className="px-4 pt-2 pb-1 text-xs font-semibold text-quaternary">From a template</Dropdown.SectionHeader>
                                            {templates.map((template) => (
                                                <Dropdown.Item key={template.id} id={`template:${template.id}`} textValue={template.name}>
                                                    <span className="flex items-center gap-2">
                                                        <TypeIconFor type={types.find((t) => t.id === template.typeId)} />
                                                        <span className="truncate">{template.name}</span>
                                                    </span>
                                                </Dropdown.Item>
                                            ))}
                                        </Dropdown.Section>
                                    )}
                                </Dropdown.Menu>
                            </Dropdown.Popover>
                        </Dropdown.Root>
                    )}
                </>
            }
        >
            {children}
        </PageHeader>
    );
};
