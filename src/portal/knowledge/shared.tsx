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
import { HIGHLIGHT_END, HIGHLIGHT_START, type KnowledgeObjectDetail, type KnowledgeType, type TypeIcon } from "@/shared/knowledge/types";
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
};

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
