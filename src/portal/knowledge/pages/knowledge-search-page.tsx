// Search: titles, text and tags, ranked with titles first. ↑/↓ move between results, Enter opens.
// Only ever searches spaces the signed-in person belongs to (enforced by the Worker).
import { useRef, useState } from "react";
import { SearchLg } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { Empty } from "@/portal/components/empty";
import { Timestamp } from "@/portal/components/timestamp";
import { pluralise } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { KnowledgeHeader } from "../knowledge-header";
import { Highlighted, TypeIconFor, objectHref } from "../shared";

export const KnowledgeSearchPage = ({ data }: { data: PageData<"knowledge-search"> }) => {
    const { space, spaces, types, hits } = data;
    const [query, setQuery] = useState(data.query);
    const [typeId, setTypeId] = useState(data.typeId ?? "all");
    const [allSpaces, setAllSpaces] = useState(data.allSpaces);
    const results = useRef<HTMLOListElement>(null);
    const spaceName = (id: string) => spaces.find((s) => s.id === id)?.name;

    const moveFocus = (event: React.KeyboardEvent) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        const links = [...(results.current?.querySelectorAll<HTMLAnchorElement>("a[data-result]") ?? [])];
        if (!links.length) return;
        event.preventDefault();
        const index = links.indexOf(document.activeElement as HTMLAnchorElement);
        const next = event.key === "ArrowDown" ? Math.min(index + 1, links.length - 1) : Math.max(index - 1, 0);
        links[index === -1 ? 0 : next].focus();
    };

    return (
        <div className="flex flex-col gap-8" onKeyDown={moveFocus}>
            <KnowledgeHeader title="Search" space={space} spaces={spaces} types={types} crumb="Search" hideSearch />

            <form role="search" method="get" action="/portal/knowledge/search" className="flex flex-col gap-3 lg:flex-row lg:items-end">
                {space.kind !== "personal" && <input type="hidden" name="space" value={space.id} />}
                {typeId !== "all" && <input type="hidden" name="type" value={typeId} />}
                {allSpaces && <input type="hidden" name="scope" value="all" />}
                <Input
                    aria-label="Search"
                    name="q"
                    icon={SearchLg}
                    placeholder="Search titles, text and tags. Use quotes for an exact phrase."
                    value={query}
                    onChange={setQuery}
                    autoFocus={!data.query}
                    className="flex-1"
                />
                <Select
                    aria-label="Type"
                    className="lg:w-48"
                    value={typeId}
                    onChange={(key) => setTypeId(String(key))}
                    items={[{ id: "all", label: "All types" }, ...types.map((t) => ({ id: t.id, label: t.name }))]}
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
                <Button type="submit" size="lg">
                    Search
                </Button>
            </form>
            {spaces.length > 1 && <Checkbox label="Search all my spaces" isSelected={allSpaces} onChange={setAllSpaces} />}

            {data.query ? (
                hits.length ? (
                    <section aria-label="Results" className="flex flex-col gap-3">
                        <p className="text-sm text-tertiary">
                            {pluralise(hits.length, "result")} for “{data.query}”
                            {hits.length >= 50 ? ". Showing the best 50: add words to narrow it down." : ""}
                        </p>
                        <ol ref={results} className="flex flex-col divide-y divide-secondary rounded-xl bg-primary shadow-xs ring-1 ring-secondary ring-inset">
                            {hits.map((hit) => {
                                const type = types.find((t) => t.id === hit.object.typeId);
                                return (
                                    <li key={hit.object.id}>
                                        <a
                                            data-result
                                            href={objectHref(hit.object.id)}
                                            className="flex items-start gap-3 px-4 py-4 outline-focus-ring transition duration-100 ease-linear hover:bg-primary_hover focus-visible:outline-2 focus-visible:-outline-offset-2 sm:px-5"
                                        >
                                            <TypeIconFor type={type} className="mt-1" />
                                            <span className="min-w-0 flex-1">
                                                <Highlighted
                                                    text={hit.titleSnippet || "Untitled"}
                                                    className="block truncate text-md font-semibold text-primary"
                                                />
                                                {hit.bodySnippet && (
                                                    <Highlighted text={hit.bodySnippet} className="mt-1 line-clamp-2 block text-sm text-tertiary" />
                                                )}
                                                <span className="mt-2 flex flex-wrap items-center gap-2 text-xs text-tertiary">
                                                    <span>{type?.name}</span>
                                                    {data.allSpaces && <span>· {spaceName(hit.object.spaceId)}</span>}
                                                    <span>
                                                        · <Timestamp iso={hit.object.updatedAt} relative />
                                                    </span>
                                                    {hit.object.status === "archived" && (
                                                        <Badge size="sm" color="gray">
                                                            Archived
                                                        </Badge>
                                                    )}
                                                    {hit.object.tags.map((tag) => (
                                                        <Badge key={tag} size="sm" color="gray">
                                                            {tag}
                                                        </Badge>
                                                    ))}
                                                </span>
                                            </span>
                                        </a>
                                    </li>
                                );
                            })}
                        </ol>
                    </section>
                ) : (
                    <Empty
                        icon={SearchLg}
                        title="No matches"
                        description="Try fewer or different words. Words match from their start, so “plan” finds “planning”."
                    />
                )
            ) : (
                <Empty
                    icon={SearchLg}
                    title="Search your knowledge"
                    description="Titles, text and tags, in this space or all of yours. Trashed objects are never included."
                />
            )}
        </div>
    );
};
