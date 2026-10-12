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
        async (id: string, input: unknown) => {
            const { item } = await api<{ item: T }>("PATCH", `${base}/${id}`, input);
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

    /** Create or update depending on whether an id is given. */
    const save = useCallback((id: string | null, input: unknown) => (id ? update(id, input) : create(input)), [create, update]);

    return { items, setItems, create, update, remove, save };
}
