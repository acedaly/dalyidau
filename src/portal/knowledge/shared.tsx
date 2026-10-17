// Small pieces shared by the Knowledge pages: type icons, API calls, highlighted search snippets.
import type { FC, HTMLAttributes } from "react";
import {
    AlertTriangle,
    BookOpen01,
    Building07,
    Calendar,
    CheckCircle,
    Clock,
    Compass03,
    File04,
    Flag01,
    Folder,
    Lightbulb02,
    Link01,
    Star01,
    User01,
} from "@untitledui/icons";
import { api } from "@/portal/lib/api";
import { paragraphsFromText } from "@/shared/knowledge/content";
import {
    HIGHLIGHT_END,
    HIGHLIGHT_START,
    type KnowledgeCollection,
    type KnowledgeObjectDetail,
    type KnowledgeSavedView,
    type KnowledgeTemplate,
    type KnowledgeType,
    type ListFilters,
    type RelatedSuggestion,
    type TypeIcon,
} from "@/shared/knowledge/types";
import { cx } from "@/utils/cx";

export const TYPE_ICON_COMPONENTS: Record<TypeIcon, FC<HTMLAttributes<HTMLOrSVGElement>>> = {
    file: File04,
    user: User01,
    folder: Folder,
    calendar: Calendar,
    check: CheckCircle,
    book: BookOpen01,
    compass: Compass03,
    alert: AlertTriangle,
    clock: Clock,
    star: Star01,
    lightbulb: Lightbulb02,
    link: Link01,
    building: Building07,
    flag: Flag01,
};

export const TypeIconFor = ({ type, className }: { type: KnowledgeType | undefined; className?: string }) => {
    const Icon = TYPE_ICON_COMPONENTS[type?.icon ?? "file"];
    return <Icon aria-hidden="true" className={cx("size-4 shrink-0 text-fg-quaternary", className)} />;
};

export const titleOf = (title: string) => title || "Untitled";

/** Where an object lives in the app. */
export const objectHref = (id: string) => `/portal/knowledge/o/${id}`;

/** A Knowledge path for the given space; the personal space is the default and needs no parameter. */
export const spaceHref = (path: string, space: { id: string; kind: string }, params: Record<string, string | null> = {}) => {
    const search = new URLSearchParams();
    if (space.kind !== "personal") search.set("space", space.id);
    for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
    const query = search.toString();
    return query ? `${path}?${query}` : path;
};

const K = "/api/portal/knowledge";

export const knowledgeApi = {
    create: (spaceId: string, body: Record<string, unknown>) => api<KnowledgeObjectDetail>("POST", `${K}/spaces/${spaceId}/objects`, body),
    update: (id: string, body: Record<string, unknown>) => api<KnowledgeObjectDetail>("PATCH", `${K}/objects/${id}`, body),
    get: (id: string) => api<KnowledgeObjectDetail>("GET", `${K}/objects/${id}`),
    status: (id: string, action: "archive" | "unarchive" | "trash" | "restore") =>
        api<KnowledgeObjectDetail>("POST", `${K}/objects/${id}/status/${action}`, {}),
    bulk: (spaceId: string, ids: string[], action: "archive" | "unarchive" | "trash" | "restore" | "file") =>
        api<{ changed: number }>("POST", `${K}/spaces/${spaceId}/objects/bulk`, { ids, action }),
    lookup: (spaceId: string, q: string) =>
        api<{ results: { id: string; title: string; typeId: string }[] }>("GET", `${K}/spaces/${spaceId}/lookup?q=${encodeURIComponent(q)}`),
    favourite: (id: string, favourite: boolean) => api<{ ok: true }>("POST", `${K}/objects/${id}/favourite`, { favourite }),
    pin: (id: string, pinned: boolean) => api<{ ok: true }>("POST", `${K}/objects/${id}/pin`, { pinned }),
    related: (id: string) => api<{ related: RelatedSuggestion[] }>("GET", `${K}/objects/${id}/related`),
    applyTemplate: (id: string, templateId: string, version: number) =>
        api<KnowledgeObjectDetail>("POST", `${K}/objects/${id}/apply-template`, { templateId, version }),
    ensureDaily: (spaceId: string, date: string) => api<KnowledgeObjectDetail>("POST", `${K}/spaces/${spaceId}/daily/${date}`, {}),
    appendDaily: (spaceId: string, text: string, date?: string) => api<KnowledgeObjectDetail>("POST", `${K}/spaces/${spaceId}/daily/append`, { text, date }),
    collections: (spaceId: string) => api<{ collections: KnowledgeCollection[] }>("GET", `${K}/spaces/${spaceId}/collections`),
    createCollection: (spaceId: string, body: { name: string; description?: string }) =>
        api<{ collection: KnowledgeCollection }>("POST", `${K}/spaces/${spaceId}/collections`, body),
    updateCollection: (id: string, body: Record<string, unknown>) => api<{ collection: KnowledgeCollection }>("PATCH", `${K}/collections/${id}`, body),
    deleteCollection: (id: string) => api<{ ok: true }>("DELETE", `${K}/collections/${id}`),
    addToCollection: (id: string, objectIds: string[]) => api<{ added: number }>("POST", `${K}/collections/${id}/items`, { objectIds }),
    removeFromCollection: (id: string, objectId: string) => api<{ ok: true }>("DELETE", `${K}/collections/${id}/items/${objectId}`),
    moveInCollection: (id: string, objectId: string, afterId: string | null) => api<{ ok: true }>("POST", `${K}/collections/${id}/move`, { objectId, afterId }),
    pinInCollection: (id: string, objectId: string, pinned: boolean) => api<{ ok: true }>("POST", `${K}/collections/${id}/items/${objectId}/pin`, { pinned }),
    createView: (spaceId: string, body: { name: string; shared: boolean; definition: Partial<ListFilters> }) =>
        api<{ view: KnowledgeSavedView }>("POST", `${K}/spaces/${spaceId}/views`, body),
    updateView: (id: string, body: { version: number; name?: string; definition?: Partial<ListFilters> }) =>
        api<{ view: KnowledgeSavedView }>("PATCH", `${K}/views/${id}`, body),
    deleteView: (id: string) => api<{ ok: true }>("DELETE", `${K}/views/${id}`),
    createTemplate: (spaceId: string, body: Record<string, unknown>) => api<{ template: KnowledgeTemplate }>("POST", `${K}/spaces/${spaceId}/templates`, body),
    updateTemplate: (id: string, body: Record<string, unknown>) => api<{ template: KnowledgeTemplate }>("PATCH", `${K}/templates/${id}`, body),
    deleteTemplate: (id: string) => api<{ ok: true }>("DELETE", `${K}/templates/${id}`),
};

export const collectionHref = (id: string) => `/portal/knowledge/c/${id}`;
export const templateHref = (id: string) => `/portal/knowledge/templates/${id}`;
export const dailyHref = (space: { id: string; kind: string }, date?: string) => spaceHref(date ? `/portal/knowledge/daily/${date}` : "/portal/knowledge/daily", space);

/** Notices from creating an object (e.g. template values that no longer fit) survive the navigation to it. */
const NOTICE_KEY = "knowledge-notices";
export const keepNotices = (objectId: string, notices: string[] | undefined) => {
    if (!notices?.length) return;
    try {
        sessionStorage.setItem(NOTICE_KEY, JSON.stringify({ objectId, notices }));
    } catch {
        // Private browsing can refuse storage; the notices are a nicety.
    }
};
export const takeNotices = (objectId: string): string[] => {
    try {
        const stored = JSON.parse(sessionStorage.getItem(NOTICE_KEY) ?? "null") as { objectId: string; notices: string[] } | null;
        if (stored?.objectId !== objectId) return [];
        sessionStorage.removeItem(NOTICE_KEY);
        return stored.notices;
    } catch {
        return [];
    }
};

/**
 * Downloads an export through fetch, so a failure shows a message instead of an error page. The
 * file comes from the same-origin API with the person's own session; nothing is stored anywhere.
 */
export async function downloadExport(path: string) {
    const response = await fetch(path, { credentials: "same-origin" });
    if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `The export failed (${response.status})`);
    }
    const name = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ?? "knowledge-export";
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Plain text from what someone typed into a quick-capture box: one paragraph per line. */
export const documentFromText = (text: string) => ({ type: "doc", content: paragraphsFromText(text) });

/** Renders a search snippet, turning the server's highlight markers into <mark>. Never parsed as HTML. */
export const Highlighted = ({ text, className }: { text: string; className?: string }) => {
    const parts: { text: string; match: boolean }[] = [];
    let rest = text;
    while (rest) {
        const start = rest.indexOf(HIGHLIGHT_START);
        if (start === -1) {
            parts.push({ text: rest, match: false });
            break;
        }
        if (start > 0) parts.push({ text: rest.slice(0, start), match: false });
        const end = rest.indexOf(HIGHLIGHT_END, start);
        const stop = end === -1 ? rest.length : end;
        parts.push({ text: rest.slice(start + 1, stop), match: true });
        rest = end === -1 ? "" : rest.slice(end + 1);
    }
    return (
        <span className={className}>
            {parts.map((part, index) =>
                part.match ? (
                    <mark key={index} className="rounded-xs bg-brand-secondary px-0.5 text-primary">
                        {part.text}
                    </mark>
                ) : (
                    <span key={index}>{part.text}</span>
                ),
            )}
        </span>
    );
};
