// Quick Add on every portal page outside Tasks (Knowledge, the wedding planner, the portal home):
// "q", the sidebar's Add task button and the floating button on phones all open it. Projects,
// labels and people are fetched from /api/portal/tasks/shell the first time it opens, so pages that
// never use it pay nothing. On a Knowledge page it offers to link the new task to that page; the
// Worker checks the person can read it in Knowledge before linking.
import { useCallback, useEffect, useState } from "react";
import { Lightning01 } from "@untitledui/icons";
import { useHotkeys } from "react-hotkeys-hook";
import { PortalDialog } from "@/portal/components/dialog";
import { Skeleton } from "@/portal/components/empty";
import { Notice } from "@/portal/components/notice";
import { errorMessage } from "@/portal/lib/api";
import type { TasksShell } from "@/shared/tasks/types";
import { taskHref, tasksApi } from "./api";
import { QuickAddForm } from "./quick-add";
import { QUICK_ADD_EVENT, TASK_CREATED_EVENT } from "./quick-add-events";
import { TasksProvider, useTaskChanges } from "./tasks-context";

/** Tells the page a task was created (see TASK_CREATED_EVENT). */
const AnnounceCreated = () => {
    useTaskChanges((change) => {
        if (change.type === "created") window.dispatchEvent(new CustomEvent(TASK_CREATED_EVENT, { detail: { id: change.task.id } }));
    });
    return null;
};

let cached: Promise<TasksShell> | null = null;

export const GlobalQuickAdd = ({ knowledge }: { knowledge?: { id: string; title: string } | null }) => {
    const [open, setOpen] = useState(false);
    const [shell, setShell] = useState<TasksShell | null>(null);
    const [failed, setFailed] = useState<string | null>(null);

    const show = useCallback(() => {
        setOpen(true);
        setFailed(null);
        cached ??= tasksApi.shell().then((r) => r.shell);
        cached.then(setShell, (error) => {
            cached = null;
            setFailed(errorMessage(error));
        });
    }, []);

    useHotkeys("q", (event) => (event.preventDefault(), show()));
    useEffect(() => {
        window.addEventListener(QUICK_ADD_EVENT, show);
        return () => window.removeEventListener(QUICK_ADD_EVENT, show);
    }, [show]);

    return (
        <PortalDialog
            isOpen={open}
            onOpenChange={setOpen}
            title="Add a task"
            icon={Lightning01}
            size="lg"
            description="Type naturally: “Pay rent friday p2 @admin”, “Bins every wednesday at 7pm”. It goes to your Inbox unless you choose a project."
        >
            {failed ? (
                <Notice title="Couldn't open Quick Add" color="warning">
                    {failed}
                </Notice>
            ) : shell ? (
                <TasksProvider shell={shell} syncUrl={false}>
                    <AnnounceCreated />
                    <QuickAddForm
                        defaults={knowledge ? { knowledge } : {}}
                        onSaved={() => setOpen(false)}
                        onCancel={() => setOpen(false)}
                        onOpenTask={(id) => window.location.assign(taskHref(id))}
                    />
                </TasksProvider>
            ) : (
                <div role="status" aria-label="Loading Quick Add" className="flex flex-col gap-3">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-8 w-2/3" />
                </div>
            )}
            <div className="h-4" />
        </PortalDialog>
    );
};
