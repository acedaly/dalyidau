// A page's list of tasks that stays right as things change: completed or deleted tasks leave at
// once, edits show at once, and the list is then re-read from the server (which decides what
// belongs in Today, a filter or a project) so nothing is guessed for long.
import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskSummary } from "@/shared/tasks/types";
import { useTaskChanges } from "./tasks-context";

export function useLiveList(initial: TaskSummary[], refetch: () => Promise<TaskSummary[]>, options: { keepCompleted?: boolean } = {}) {
    const [tasks, setTasks] = useState(initial);
    const [loading, setLoading] = useState(false);
    const latest = useRef(0);
    const timer = useRef<number | null>(null);
    const reload = useCallback(() => {
        if (timer.current) window.clearTimeout(timer.current);
        // A burst of changes (complete, then Undo) is read once.
        timer.current = window.setTimeout(async () => {
            const request = ++latest.current;
            setLoading(true);
            try {
                const next = await refetch();
                if (request === latest.current) setTasks(next);
            } catch {
                // Keep what's shown; the next change will try again.
            } finally {
                if (request === latest.current) setLoading(false);
            }
        }, 250);
    }, [refetch]);
    useEffect(() => () => void (timer.current && window.clearTimeout(timer.current)), []);

    useTaskChanges((change) => {
        if (change.type === "removed") setTasks((list) => list.filter((t) => t.id !== change.id && t.parentId !== change.id));
        else if (change.type === "saved")
            setTasks((list) =>
                !options.keepCompleted && change.task.status === "completed"
                    ? list.filter((t) => t.id !== change.task.id)
                    : list.map((t) => (t.id === change.task.id && !t.projected ? change.task : t)),
            );
        reload();
    });
    return { tasks, setTasks, reload, loading };
}
