// "Related knowledge" on an object page: suggestions worked out on the Worker from tags, links,
// collections and wording, each with its reasons. Loaded after the page, so it never slows opening
// an object. Suggestions are only that: nothing is linked unless someone links it.
import { useEffect, useState } from "react";
import { Skeleton } from "@/portal/components/empty";
import type { KnowledgeType, RelatedSuggestion } from "@/shared/knowledge/types";
import { TypeIconFor, knowledgeApi, objectHref, titleOf } from "./shared";

export const RelatedKnowledge = ({ objectId, types }: { objectId: string; types: KnowledgeType[] }) => {
    const [related, setRelated] = useState<RelatedSuggestion[] | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let live = true;
        knowledgeApi
            .related(objectId)
            .then((r) => live && setRelated(r.related))
            .catch(() => live && setFailed(true));
        return () => {
            live = false;
        };
    }, [objectId]);

    return (
        <section className="flex flex-col gap-3 border-t border-secondary pt-5" aria-labelledby="related-knowledge">
            <h2 id="related-knowledge" className="text-sm font-semibold text-primary">
                Related knowledge
            </h2>
            {failed ? (
                <p className="text-sm text-tertiary">Suggestions couldn't be loaded.</p>
            ) : related === null ? (
                <Skeleton className="h-16" />
            ) : related.length === 0 ? (
                <p className="text-sm text-tertiary">Nothing stands out yet. Tags, links and collections help suggestions appear.</p>
            ) : (
                <ul className="flex flex-col gap-3" aria-live="polite">
                    {related.map((s) => (
                        <li key={s.object.id} className="flex gap-2 text-sm">
                            <TypeIconFor type={types.find((t) => t.id === s.object.typeId)} className="mt-0.5" />
                            <span className="min-w-0 flex-1">
                                <a href={objectHref(s.object.id)} className="block truncate font-medium text-secondary hover:text-brand-secondary hover:underline">
                                    {titleOf(s.object.title)}
                                </a>
                                <span className="block text-xs text-tertiary">
                                    {s.strength === "possible" && <span className="font-medium text-quaternary">Possibly related · </span>}
                                    {s.reasons.join(" · ")}
                                </span>
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
};
