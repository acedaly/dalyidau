// Choosing a Knowledge object to link from Tasks (a task, a project or a goal), using Knowledge's own
// search: only the caller's spaces are ever searched, and the Worker checks access again on linking.
import { useEffect, useState } from "react";
import { BookOpen01, SearchLg } from "@untitledui/icons";
import { Input } from "@/components/base/input/input";
import { PortalDialog } from "@/portal/components/dialog";
import { api, errorMessage } from "@/portal/lib/api";
import type { KnowledgeSearchHit } from "@/shared/knowledge/types";
import { titleOf } from "./shared";

/** Find a Knowledge object to link, using Knowledge's own search: only the caller's spaces are ever searched. */
export const KnowledgeLinkDialog = ({ onClose, onPick }: { onClose: () => void; onPick: (objectId: string) => void }) => {
    const [query, setQuery] = useState("");
    const [hits, setHits] = useState<KnowledgeSearchHit[]>([]);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        if (!query.trim()) return setHits([]);
        const timer = window.setTimeout(() => {
            api<{ hits: KnowledgeSearchHit[] }>("GET", `/api/portal/knowledge/search?q=${encodeURIComponent(query.trim())}&limit=20`)
                .then((r) => (setHits(r.hits), setError(null)))
                .catch((e) => setError(errorMessage(e)));
        }, 150);
        return () => window.clearTimeout(timer);
    }, [query]);
    return (
        <PortalDialog
            isOpen
            onOpenChange={(open) => !open && onClose()}
            title="Link Knowledge"
            icon={BookOpen01}
            description="Only you and people who can read it in Knowledge will see what it's called."
        >
            <Input aria-label="Search Knowledge" icon={SearchLg} placeholder="Search your Knowledge" value={query} onChange={setQuery} autoFocus />
            {error && <p className="text-sm text-error-primary">{error}</p>}
            <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto pb-4">
                {hits.map((hit) => (
                    <li key={hit.object.id}>
                        <button
                            type="button"
                            onClick={() => onPick(hit.object.id)}
                            className="flex w-full cursor-pointer flex-col items-start rounded-md px-3 py-2 text-left outline-focus-ring hover:bg-primary_hover focus-visible:outline-2"
                        >
                            <span className="text-sm font-medium text-primary">{titleOf(hit.object.title)}</span>
                        </button>
                    </li>
                ))}
                {query.trim() && !hits.length && !error && <li className="px-3 py-2 text-sm text-tertiary">Nothing found.</li>}
            </ul>
        </PortalDialog>
    );
};
