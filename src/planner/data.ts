// Wedding Planner's data: the portal's own wedding API (/api/portal/wedding/*, /api/portal/dashboard),
// read and written as the signed-in person, so roles, validation and the audit log are the portal's.
// A small in-memory cache keyed by address: each view reads what it needs, and a change reloads the
// addresses it affects. Nothing is stored on the device.
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { ApiError, api } from "@/portal/lib/api";

interface Entry {
    data?: unknown;
    error?: ApiError;
    loading: boolean;
}

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const EMPTY: Entry = { loading: true };

const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

const load = async (path: string) => {
    entries.set(path, { ...(entries.get(path) ?? {}), loading: true });
    emit();
    try {
        const data = await api<unknown>("GET", path);
        entries.set(path, { data, loading: false });
    } catch (error) {
        const apiError = error instanceof ApiError ? error : new ApiError(0, "unknown", "Something went wrong.");
        entries.set(path, { ...(entries.get(path) ?? {}), error: apiError, loading: false });
    }
    emit();
};

/** Reads an address, loading it the first time it's needed. `null` reads nothing (e.g. no permission). */
export function useApi<T>(path: string | null): { data: T | undefined; error: ApiError | undefined; loading: boolean; reload: () => void } {
    const entry = useSyncExternalStore(
        subscribe,
        () => (path ? (entries.get(path) ?? EMPTY) : EMPTY),
        () => EMPTY,
    );
    useEffect(() => {
        if (path && !entries.has(path)) void load(path);
    }, [path]);
    const reload = useCallback(() => {
        if (path) void load(path);
    }, [path]);
    return { data: entry.data as T | undefined, error: entry.error, loading: path ? entry.loading : false, reload };
}

/** Reloads every cached address starting with one of these prefixes. */
export const refresh = (...prefixes: string[]) => {
    for (const path of entries.keys()) if (prefixes.some((prefix) => path.startsWith(prefix))) void load(path);
};

/** A change through the portal API, then a reload of what it affects (the dashboard always). */
export async function change<T>(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body: unknown, affects: string[]): Promise<T> {
    const result = await api<T>(method, path, body);
    refresh(DASHBOARD, ...affects);
    return result;
}

export const DASHBOARD = "/api/portal/dashboard";
export const GUESTS = "/api/portal/wedding/guests";
export const EVENTS = "/api/portal/wedding/events";
export const TASKS = "/api/portal/wedding/tasks";
export const BUDGET = "/api/portal/wedding/budget-items";
export const SUPPLIERS = "/api/portal/wedding/suppliers";
export const TIMELINE = "/api/portal/wedding/timeline";
export const SEATING = "/api/portal/wedding/seating";
