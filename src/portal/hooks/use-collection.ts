import { useCallback, useState } from "react";
import { api } from "@/portal/lib/api";

/**
 * Local state for one of the generic collections (/api/portal/wedding/<collection>), kept in sync
 * with the server after every create, update and delete.
 */
export function useCollection<T extends { id: string }>(collection: string, initial: T[]) {
    const [items, setItems] = useState<T[]>(initial);
    const base = `/api/portal/wedding/${collection}`;

    const create = useCallback(
        async (input: unknown) => {
            const { item } = await api<{ item: T }>("POST", base, input);
            setItems((list) => [...list, item]);
            return item;
        },
        [base],
    );

    const update = useCallback(
        async (id: string, input: unknown, options: { expectedUpdatedAt?: string } = {}) => {
            // Sending the version the form was opened with lets the server refuse a stale save.
            const body = options.expectedUpdatedAt && input && typeof input === "object" ? { ...input, expectedUpdatedAt: options.expectedUpdatedAt } : input;
            const { item } = await api<{ item: T }>("PATCH", `${base}/${id}`, body);
            setItems((list) => list.map((existing) => (existing.id === id ? item : existing)));
            return item;
        },
        [base],
    );

    const remove = useCallback(
        async (id: string) => {
            await api("DELETE", `${base}/${id}`);
            setItems((list) => list.filter((existing) => existing.id !== id));
        },
        [base],
    );

    /** Create or update depending on whether an id is given. Updates are checked against the version in the list. */
    const save = useCallback(
        (id: string | null, input: unknown) => {
            if (!id) return create(input);
            const current = items.find((item) => item.id === id) as { updatedAt?: string } | undefined;
            return update(id, input, { expectedUpdatedAt: current?.updatedAt });
        },
        [create, update, items],
    );

    return { items, setItems, create, update, remove, save };
}
