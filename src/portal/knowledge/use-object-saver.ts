// Saving an object as it's edited. Changes are merged into one pending patch and sent after a short
// pause (or straight away for discrete changes like a property), one request at a time, each
// carrying the version it was based on. If someone else saved in between, the Worker refuses with
// 409 and nothing is sent until the person chooses what to do: their pending changes are kept.
//
// A daily note doesn't exist until someone writes in it: with no object yet, the first save calls
// `ensure` (which creates it, or returns the one another tab just made) and then saves on top.
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, errorMessage } from "@/portal/lib/api";
import type { KnowledgeObjectDetail } from "@/shared/knowledge/types";
import { knowledgeApi } from "./shared";

export type SaveState = "saved" | "pending" | "saving" | "error" | "conflict";

export interface Patch {
    title?: string;
    content?: unknown;
    properties?: Record<string, unknown>;
    tags?: string[];
    typeId?: string;
    inInbox?: boolean;
}

const AUTOSAVE_MS = 800;

const merge = (a: Patch, b: Patch): Patch => ({
    ...a,
    ...b,
    ...(a.properties || b.properties ? { properties: { ...a.properties, ...b.properties } } : {}),
});

export function useObjectSaver(initial: KnowledgeObjectDetail | null, ensure?: () => Promise<KnowledgeObjectDetail>) {
    const [detail, setDetail] = useState(initial);
    const [state, setState] = useState<SaveState>("saved");
    const [error, setError] = useState<string | null>(null);
    const [conflict, setConflict] = useState<{ updatedBy: string; updatedAt: string } | null>(null);
    const version = useRef(initial?.object.version ?? 0);
    const objectId = useRef(initial?.object.id ?? null);
    const pending = useRef<Patch>({});
    const inFlight = useRef(false);
    const timer = useRef<number | undefined>(undefined);
    const blocked = useRef(false);
    // Identifies this open page, so its autosaves share a revision and another tab's never do.
    const session = useRef(
        typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `s${Date.now()}${Math.random().toString(36).slice(2)}`,
    );

    const hasPending = () => Object.keys(pending.current).length > 0;

    const flush = useCallback(async (): Promise<boolean> => {
        window.clearTimeout(timer.current);
        if (inFlight.current || blocked.current) return false;
        if (!hasPending()) return true;
        const patch = pending.current;
        pending.current = {};
        inFlight.current = true;
        setState("saving");
        try {
            if (!objectId.current) {
                if (!ensure) throw new Error("Nothing to save to");
                const created = await ensure();
                objectId.current = created.object.id;
                version.current = created.object.version;
                setDetail(created);
                // Someone (another tab, a capture) wrote in it first: saving ours would replace theirs.
                if (created.object.version > 1) throw new ApiError(409, "conflict", "Someone else saved this first");
            }
            const saved = await knowledgeApi.update(objectId.current, { version: version.current, session: session.current, ...patch });
            version.current = saved.object.version;
            setDetail(saved);
            setError(null);
            inFlight.current = false;
            if (hasPending()) return flush();
            setState("saved");
            return true;
        } catch (e) {
            inFlight.current = false;
            // Put the changes back in front of anything typed meanwhile.
            pending.current = merge(patch, pending.current);
            if (e instanceof ApiError && e.status === 409) {
                blocked.current = true;
                setState("conflict");
                setConflict({ updatedBy: "", updatedAt: "" });
                const current = await knowledgeApi.get(objectId.current!).catch(() => null);
                if (current) setConflict({ updatedBy: current.object.updatedBy, updatedAt: current.object.updatedAt });
                return false;
            }
            setState("error");
            setError(errorMessage(e));
            return false;
        }
    }, [ensure]);

    const queue = useCallback(
        (patch: Patch, immediate = false) => {
            pending.current = merge(pending.current, patch);
            if (blocked.current) return;
            setState("pending");
            window.clearTimeout(timer.current);
            if (immediate) void flush();
            else timer.current = window.setTimeout(() => void flush(), AUTOSAVE_MS);
        },
        [flush],
    );

    /** After a conflict: save these changes on top of the newer version (which stays in the history). */
    const keepMine = useCallback(async () => {
        const current = await knowledgeApi.get(objectId.current!);
        version.current = current.object.version;
        blocked.current = false;
        setConflict(null);
        return flush();
    }, [flush]);

    // Leaving with unsaved changes asks first, and tries to save on the way out.
    useEffect(() => {
        const beforeUnload = (event: BeforeUnloadEvent) => {
            if (hasPending() || inFlight.current) {
                void flush();
                event.preventDefault();
            }
        };
        window.addEventListener("beforeunload", beforeUnload);
        return () => window.removeEventListener("beforeunload", beforeUnload);
    }, [flush]);

    return { detail, setDetail, state, error, conflict, queue, flush, keepMine, version };
}
