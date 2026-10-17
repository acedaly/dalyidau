// What you can do to a task from any list: complete (with Undo), reopen, skip, reschedule, change
// priority, duplicate and delete. Each action tells the rest of the page through the change feed.
// Completing a task with open subtasks asks first instead of completing them silently, and a
// change that lost a race with someone else's says so and reloads the task rather than overwriting.
import { useState } from "react";
import { ConfirmDialog } from "@/portal/components/dialog";
import { useToast } from "@/portal/components/toast";
import { ApiError, errorMessage } from "@/portal/lib/api";
import { relativeDate } from "@/shared/tasks/dates";
import type { TaskSummary } from "@/shared/tasks/types";
import { type TaskFields, tasksApi } from "./api";
import { useTasks } from "./tasks-context";

export const useTaskActions = () => {
    const { emit, today } = useTasks();
    const toast = useToast();
    const [askSubtasks, setAskSubtasks] = useState<{ task: TaskSummary; message: string } | null>(null);
    const [askDelete, setAskDelete] = useState<TaskSummary | null>(null);

    const conflict = (error: unknown, task: TaskSummary) => {
        if (error instanceof ApiError && error.status === 409 && error.code === "conflict") {
            toast.show({ title: "Someone else changed this task", description: "Showing the latest version. Your change wasn't saved.", color: "warning" });
            emit({ type: "refresh" });
            void tasksApi.get(task.id).then(
                (d) => emit({ type: "saved", task: d.task }),
                () => undefined,
            );
            return true;
        }
        return false;
    };

    const reopen = async (task: TaskSummary) => {
        try {
            const { task: next } = await tasksApi.reopen(task.id);
            emit({ type: "saved", task: next });
        } catch (error) {
            if (!conflict(error, task)) toast.error("Couldn't undo that", errorMessage(error));
        }
    };

    const complete = async (task: TaskSummary, includeSubtasks = false) => {
        try {
            const result = await tasksApi.complete(task.id, task.dueDate, includeSubtasks);
            emit({ type: "saved", task: result.task });
            toast.show({
                title: result.nextDate ? `Done. Next: ${relativeDate(result.nextDate, today)}` : "Task completed",
                description: task.title,
                color: "success",
                action: result.alreadyDone ? undefined : { label: "Undo", run: () => void reopen(result.task) },
            });
            return result;
        } catch (error) {
            if (error instanceof ApiError && error.code === "open_subtasks") setAskSubtasks({ task, message: error.message });
            else if (!conflict(error, task)) toast.error("Couldn't complete it", errorMessage(error));
            return null;
        }
    };

    const skip = async (task: TaskSummary) => {
        try {
            const result = await tasksApi.skip(task.id, task.dueDate);
            emit({ type: "saved", task: result.task });
            toast.show({
                title: `Skipped. Next: ${result.nextDate ? relativeDate(result.nextDate, today) : "none"}`,
                color: "success",
                action: { label: "Undo", run: () => void reopen(result.task) },
            });
        } catch (error) {
            if (!conflict(error, task)) toast.error("Couldn't skip it", errorMessage(error));
        }
    };

    /** Saves fields on a task. Returns the saved task, or null if it didn't save (the reason has been shown). */
    const update = async (task: TaskSummary, fields: TaskFields): Promise<TaskSummary | null> => {
        try {
            const { task: next } = await tasksApi.update(task.id, task.version, fields);
            emit({ type: "saved", task: next });
            return next;
        } catch (error) {
            if (!conflict(error, task)) toast.error("Couldn't save that", errorMessage(error));
            return null;
        }
    };

    const move = async (task: TaskSummary, to: Parameters<typeof tasksApi.move>[1]) => {
        try {
            const { task: next } = await tasksApi.move(task.id, to);
            emit({ type: "saved", task: next });
            emit({ type: "refresh" });
            return next;
        } catch (error) {
            toast.error("Couldn't move it", errorMessage(error));
            return null;
        }
    };

    const duplicate = async (task: TaskSummary) => {
        try {
            const { task: copy } = await tasksApi.duplicate(task.id);
            emit({ type: "created", task: copy });
            emit({ type: "refresh" });
            toast.success("Duplicated");
        } catch (error) {
            toast.error("Couldn't duplicate it", errorMessage(error));
        }
    };

    const dialogs = (
        <>
            <ConfirmDialog
                isOpen={!!askSubtasks}
                onOpenChange={(open) => !open && setAskSubtasks(null)}
                title="Complete the subtasks too?"
                description={`${askSubtasks?.message ?? ""} Completing the task completes them as well. To keep them open, complete or move them first.`}
                confirmLabel="Complete all"
                onConfirm={async () => {
                    if (askSubtasks) await complete(askSubtasks.task, true);
                }}
            />
            <ConfirmDialog
                isOpen={!!askDelete}
                onOpenChange={(open) => !open && setAskDelete(null)}
                title="Delete this task?"
                description={
                    askDelete?.subtasks.total
                        ? `“${askDelete.title}” and its ${askDelete.subtasks.total} subtask${askDelete.subtasks.total === 1 ? "" : "s"}, comments and reminders will be deleted. This can't be undone. To keep a record, complete it instead.`
                        : `“${askDelete?.title ?? ""}”, its comments and reminders will be deleted. This can't be undone. To keep a record, complete it instead.`
                }
                confirmLabel="Delete task"
                destructive
                onConfirm={async () => {
                    if (!askDelete) return;
                    try {
                        await tasksApi.remove(askDelete.id);
                        emit({ type: "removed", id: askDelete.id });
                        toast.success("Task deleted");
                    } catch (error) {
                        toast.error("Couldn't delete it", errorMessage(error));
                    }
                }}
            />
        </>
    );

    return { complete, reopen, skip, update, move, duplicate, remove: (task: TaskSummary) => setAskDelete(task), dialogs };
};
