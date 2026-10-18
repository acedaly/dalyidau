// "Related by meaning" under Knowledge search results: Daly Intelligence's hybrid search, showing only
// what keyword search didn't already find. Loaded after the page; when semantic search is off or
// unavailable nothing is shown, and keyword results are never affected.
import { useEffect, useState } from "react";
import { Stars02 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { api } from "@/portal/lib/api";
import { usePortal } from "@/portal/portal-context";
import type { HybridSearchResult } from "@/shared/intelligence/types";
import type { KnowledgeType } from "@/shared/knowledge/types";
import { TypeIconFor, objectHref, titleOf } from "./shared";

export const MeaningResults = ({ query, spaceId, exclude, types }: { query: string; spaceId: string | null; exclude: Set<string>; types: KnowledgeType[] }) => {
    const { can } = usePortal();
    const [hits, setHits] = useState<HybridSearchResult["hits"]>([]);

    useEffect(() => {
        if (!can("intelligence.use") || query.trim().length < 3) return;
        let live = true;
        const params = new URLSearchParams({ q: query, limit: "20", ...(spaceId ? { space: spaceId } : {}) });
        api<HybridSearchResult>("GET", `/api/portal/intelligence/search?${params}`)
            .then((r) => live && r.mode === "hybrid" && setHits(r.hits.filter((h) => h.matchedBy.includes("meaning") && !exclude.has(h.object.id)).slice(0, 8)))
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, [can, query, spaceId, exclude]);

    if (!hits.length) return null;
    return (
        <section aria-labelledby="meaning-results" className="flex flex-col gap-3">
            <h2 id="meaning-results" className="flex items-center gap-2 text-sm font-semibold text-secondary">
                <Stars02 aria-hidden="true" className="size-4 text-fg-brand-secondary" />
                Related by meaning
                <Badge size="sm" type="pill-color" color="brand">
                    Semantic
                </Badge>
            </h2>
            <ol className="flex flex-col divide-y divide-secondary rounded-xl bg-primary shadow-xs ring-1 ring-secondary ring-inset">
                {hits.map((hit) => (
                    <li key={hit.object.id}>
                        <a
                            href={objectHref(hit.object.id)}
                            className="flex items-start gap-3 px-4 py-3 transition duration-100 ease-linear hover:bg-primary_hover sm:px-5"
                        >
                            <TypeIconFor type={types.find((t) => t.id === hit.object.typeId)} className="mt-0.5" />
                            <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-semibold text-primary">{titleOf(hit.object.title)}</span>
                                <span className="line-clamp-2 text-sm text-tertiary">{hit.excerpt}</span>
                            </span>
                        </a>
                    </li>
                ))}
            </ol>
        </section>
    );
};
