// Discover: knowledge that isn't connected to anything. Some notes are fine on their own, so each
// is marked "organised" (tagged or in a collection) or "loose" (neither), and suggestions for what
// it might link to are a click away. Daily notes are left out: they stand alone by design.
import { useState } from "react";
import { Compass03, Link03 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Tabs } from "@/components/application/tabs/tabs";
import { Empty } from "@/portal/components/empty";
import { Timestamp } from "@/portal/components/timestamp";
import { pluralise } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import type { KnowledgeObjectSummary } from "@/shared/knowledge/types";
import { KnowledgeHeader } from "../knowledge-header";
import { RelatedKnowledge } from "../related-knowledge";
import { TypeIconFor, objectHref, spaceHref, titleOf } from "../shared";

const LISTS = [
    { id: "unlinked", label: "Not linked at all", hint: "No links to or from anything." },
    { id: "no_backlinks", label: "Nothing links here", hint: "Nothing points to these yet." },
    { id: "no_outgoing", label: "Links nowhere", hint: "These don't link to anything." },
] as const;

export const KnowledgeDiscoverPage = ({ data }: { data: PageData<"knowledge-discover"> }) => {
    const { space, spaces, types, lists } = data;
    const organised = new Set(data.organised);
    const [suggestFor, setSuggestFor] = useState<string | null>(null);

    const Row = ({ object }: { object: KnowledgeObjectSummary }) => (
        <li className="flex flex-col gap-2 px-4 py-3 sm:px-5">
            <div className="flex items-start gap-3">
                <TypeIconFor type={types.find((t) => t.id === object.typeId)} className="mt-0.5" />
                <div className="min-w-0 flex-1">
                    <a href={objectHref(object.id)} className="block truncate text-sm font-medium text-primary hover:underline">
                        {titleOf(object.title)}
                    </a>
                    <p className="flex flex-wrap items-center gap-2 text-xs text-tertiary">
                        {organised.has(object.id) ? (
                            <Badge size="sm" color="gray">
                                Organised
                            </Badge>
                        ) : (
                            <Badge size="sm" color="warning">
                                Loose
                            </Badge>
                        )}
                        <span>
                            Updated <Timestamp iso={object.updatedAt} relative />
                        </span>
                    </p>
                </div>
                <Button
                    size="sm"
                    color="link-color"
                    iconLeading={Link03}
                    aria-expanded={suggestFor === object.id}
                    onClick={() => setSuggestFor(suggestFor === object.id ? null : object.id)}
                >
                    {suggestFor === object.id ? "Hide" : "Suggest links"}
                </Button>
            </div>
            {suggestFor === object.id && (
                <div className="pl-7">
                    <RelatedKnowledge objectId={object.id} types={types} />
                </div>
            )}
        </li>
    );

    return (
        <>
            <KnowledgeHeader
                title="Discover"
                description="Notes that aren't connected to anything yet. “Organised” ones are tagged or in a collection; “loose” ones are neither, and are the easiest to lose."
                space={space}
                spaces={spaces}
                types={types}
                templates={data.templates}
                crumb="Discover"
            />
            <Tabs defaultSelectedKey="unlinked">
                <Tabs.List type="button-minimal" size="sm" aria-label="Kinds of disconnected knowledge" className="w-max max-w-full overflow-x-auto">
                    {LISTS.map((l) => (
                        <Tabs.Item key={l.id} id={l.id} badge={lists[l.id].total || undefined}>
                            {l.label}
                        </Tabs.Item>
                    ))}
                </Tabs.List>
                {LISTS.map((l) => (
                    <Tabs.Panel key={l.id} id={l.id} className="pt-6">
                        {lists[l.id].objects.length ? (
                            <div className="flex flex-col gap-3">
                                <p className="text-sm text-tertiary">
                                    {l.hint} {lists[l.id].total > lists[l.id].objects.length && `Showing the ${lists[l.id].objects.length} most recently updated of ${pluralise(lists[l.id].total, "object")}.`}
                                </p>
                                <ul className="flex flex-col divide-y divide-secondary rounded-xl bg-primary shadow-xs ring-1 ring-secondary ring-inset">
                                    {lists[l.id].objects.map((o) => (
                                        <Row key={o.id} object={o} />
                                    ))}
                                </ul>
                                <div>
                                    <Button size="sm" color="link-gray" href={spaceHref("/portal/knowledge/all", space, { links: l.id })}>
                                        Open as a list (filter, sort, save as a view)
                                    </Button>
                                </div>
                            </div>
                        ) : (
                            <Empty icon={Compass03} title="Everything's connected" description="Nothing here: every object has links of this kind." size="sm" />
                        )}
                    </Tabs.Panel>
                ))}
            </Tabs>
        </>
    );
};
