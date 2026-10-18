// Changes to several selected tasks at once: complete, reschedule, shift dates by some days, remove
// dates, set priority, move, label or delete. The server applies each change to all of them or none.
import { useState } from "react";
import { CheckCircle, Trash01, XClose } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { ConfirmDialog, PortalDialog } from "@/portal/components/dialog";
import { useToast } from "@/portal/components/toast";
import { ApiError, errorMessage } from "@/portal/lib/api";
import type { Priority } from "@/shared/tasks/types";
import { type BulkAction, tasksApi } from "./api";
import { DateMenu, PriorityPicker, ProjectPicker } from "./pickers";
import { useTasks } from "./tasks-context";

export const BulkBar = ({ selected, onClear }: { selected: Set<string>; onClear: () => void }) => {
    const { emit, shell } = useTasks();
    const toast = useToast();
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [askSubtasks, setAskSubtasks] = useState(false);
    const [labelOpen, setLabelOpen] = useState(false);
    const [label, setLabel] = useState("");
    const [shiftOpen, setShiftOpen] = useState(false);
    const [days, setDays] = useState("1");
    const ids = [...selected];
    if (!ids.length) return null;

    const run = async (action: BulkAction, done: string) => {
        try {
            await tasksApi.bulk(ids, action);
            toast.success(done);
            onClear();
            emit({ type: "refresh" });
        } catch (error) {
            if (error instanceof ApiError && error.code === "open_subtasks") setAskSubtasks(true);
            else toast.error("Nothing was changed", errorMessage(error));
        }
    };

    const count = `${ids.length} task${ids.length === 1 ? "" : "s"}`;
    return (
        <div
            role="toolbar"
            data-bulk-bar
            aria-label={`Change ${count}`}
            className="sticky bottom-3 z-20 flex flex-wrap items-center gap-2 rounded-xl bg-primary p-3 shadow-lg ring-1 ring-secondary_alt"
        >
            <span className="mr-1 text-sm font-semibold text-primary">{count} selected</span>
            <Button size="sm" iconLeading={CheckCircle} onClick={() => void run({ action: "complete" }, `Completed ${count}`)}>
                Complete
            </Button>
            <DateMenu
                label="Due date for the selected tasks"
                value={null}
                placeholder="Reschedule"
                onChange={(dueDate) => void run({ action: "due", dueDate }, `Rescheduled ${count}`)}
            />
            <Button size="sm" color="secondary" onClick={() => setShiftOpen(true)}>
                Shift dates
            </Button>
            <Button size="sm" color="secondary" onClick={() => void run({ action: "due", dueDate: null }, `Removed the dates from ${count}`)}>
                Remove dates
            </Button>
            <PriorityPicker
                label="Priority for the selected tasks"
                value={4}
                onChange={(priority: Priority) => void run({ action: "priority", priority }, `Set ${count} to P${priority}`)}
            />
            <ProjectPicker
                label="Move the selected tasks to"
                value={shell.inboxId}
                className="sm:w-44"
                onChange={(projectId) => void run({ action: "move", projectId }, `Moved ${count}`)}
            />
            <Button size="sm" color="secondary" onClick={() => setLabelOpen(true)}>
                Add label
            </Button>
            <Button size="sm" color="secondary-destructive" iconLeading={Trash01} onClick={() => setConfirmDelete(true)}>
                Delete
            </Button>
            <Button size="sm" color="tertiary" iconLeading={XClose} onClick={onClear} className="ml-auto">
                Clear
            </Button>
            <ConfirmDialog
                isOpen={confirmDelete}
                onOpenChange={setConfirmDelete}
                title={`Delete ${count}?`}
                description="Their subtasks, comments and reminders are deleted too. This can't be undone."
                confirmLabel="Delete"
                destructive
                onConfirm={() => run({ action: "delete" }, `Deleted ${count}`)}
            />
            <ConfirmDialog
                isOpen={askSubtasks}
                onOpenChange={setAskSubtasks}
                title="Complete their subtasks too?"
                description="Some of these tasks have open subtasks. Completing the tasks completes those as well."
                confirmLabel="Complete all"
                onConfirm={() => run({ action: "complete", includeSubtasks: true }, `Completed ${count}`)}
            />
            <PortalDialog
                isOpen={shiftOpen}
                onOpenChange={setShiftOpen}
                title={`Shift ${count}`}
                description="Each due date moves by the same number of days. Deadlines stay put, undated tasks are left alone, and a repeating task moves only its current occurrence."
                onSubmit={() => {
                    const n = Math.trunc(Number(days));
                    if (n) void run({ action: "shift", days: n }, `Moved ${count} by ${n} day${Math.abs(n) === 1 ? "" : "s"}`).then(() => setShiftOpen(false));
                }}
                footer={
                    <Button type="submit" size="md" isDisabled={!Math.trunc(Number(days))}>
                        Shift dates
                    </Button>
                }
            >
                <div className="flex flex-wrap gap-2">
                    {[-7, -1, 1, 2, 7, 14].map((n) => (
                        <Button key={n} size="sm" color={String(n) === days ? "primary" : "secondary"} onClick={() => setDays(String(n))}>
                            {n > 0 ? `+${n}` : n} day{Math.abs(n) === 1 ? "" : "s"}
                        </Button>
                    ))}
                </div>
                <Input label="Days (negative for earlier)" type="number" inputMode="numeric" value={days} onChange={setDays} />
            </PortalDialog>
            <PortalDialog
                isOpen={labelOpen}
                onOpenChange={setLabelOpen}
                title={`Label ${count}`}
                onSubmit={() => label.trim() && void run({ action: "label", label }, `Labelled ${count}`).then(() => (setLabelOpen(false), setLabel("")))}
                footer={
                    <Button type="submit" size="md" isDisabled={!label.trim()}>
                        Add label
                    </Button>
                }
            >
                <Input label="Label" placeholder="e.g. errands" value={label} onChange={setLabel} autoFocus />
            </PortalDialog>
        </div>
    );
};
