// What every Tasks page shares: the header (breadcrumbs, search, Add task), keyboard shortcuts,
// in-app reminders, Quick Add and the task panel. Pages put their own content inside.
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { BellRinging01, Keyboard01, Plus, SearchLg } from "@untitledui/icons";
import { useHotkeys } from "react-hotkeys-hook";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Input } from "@/components/base/input/input";
import { PortalDialog } from "@/portal/components/dialog";
import { Notice } from "@/portal/components/notice";
import { PageHeader } from "@/portal/components/page-header";
import { clockLabel } from "@/shared/tasks/dates";
import type { DueReminder, TasksShell } from "@/shared/tasks/types";
import { tasksApi } from "./api";
import { QuickAddDialog } from "./quick-add";
import { TaskPanel } from "./task-panel";
import { type QuickAddDefaults, TasksProvider, useTasks } from "./tasks-context";

const SHORTCUTS: [string, string][] = [
    ["q", "Add a task"],
    ["/", "Search"],
    ["g then i", "Go to Inbox"],
    ["g then t", "Go to Today"],
    ["g then u", "Go to Upcoming"],
    ["g then p", "Go to projects"],
    ["j / k or ↓ / ↑", "Move between tasks"],
    ["Enter", "Open the task"],
    ["e", "Complete or reopen the task"],
    ["Alt + ↑ / ↓", "Move the task up or down"],
    ["Esc", "Close the panel or dialog"],
    ["?", "Show these shortcuts"],
];

const GO: Record<string, string> = {
    i: "/portal/tasks/inbox",
    t: "/portal/tasks/today",
    u: "/portal/tasks/upcoming",
    p: "/portal/tasks/projects",
    o: "/portal/tasks/overdue",
};

/** Shortcuts never fire while typing in a field (react-hotkeys-hook ignores form fields by default). */
const Shortcuts = ({ quickAdd, onHelp }: { quickAdd: () => void; onHelp: () => void }) => {
    const pendingG = useRef(0);
    useHotkeys("q", (event) => (event.preventDefault(), quickAdd()));
    useHotkeys("slash", (event) => {
        event.preventDefault();
        document.querySelector<HTMLInputElement>("#tasks-search input, input#tasks-search")?.focus();
    });
    useHotkeys("shift+slash", (event) => (event.preventDefault(), onHelp()));
    useHotkeys("g", () => (pendingG.current = Date.now()));
    useHotkeys(Object.keys(GO), (event, handler) => {
        if (Date.now() - pendingG.current > 1200) return;
        const key = handler.keys?.[0];
        if (key && GO[key]) (event.preventDefault(), window.location.assign(GO[key]));
    });
    return null;
};

/**
 * Reminders that are due, shown at the top of every Tasks page. Ones due within the hour appear
 * when their time comes, as long as the page stays open. Nothing is sent anywhere.
 */
const DueReminders = ({ initial }: { initial: DueReminder[] }) => {
    const { openTask, shell } = useTasks();
    const [now, setNow] = useState(() => Date.now());
    const [dismissed, setDismissed] = useState<Set<string>>(new Set());
    useEffect(() => {
        const next = initial
            .map((r) => new Date(r.remindAt).getTime())
            .filter((t) => t > now)
            .sort()[0];
        if (!next) return;
        const timer = window.setTimeout(() => setNow(Date.now()), Math.min(next - now + 500, 60 * 60_000));
        return () => window.clearTimeout(timer);
    }, [initial, now]);
    const due = initial.filter((r) => new Date(r.remindAt).getTime() <= now && !dismissed.has(r.id));
    if (!due.length) return null;
    const time = (iso: string) =>
        clockLabel(
            new Intl.DateTimeFormat("en-GB", { timeZone: shell.preferences.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
                new Date(iso),
            ),
        );
    return (
        <div className="flex flex-col gap-3" role="status" aria-live="polite">
            {due.map((r) => (
                <Notice
                    key={r.id}
                    color="brand"
                    title={`Reminder · ${time(r.remindAt)}`}
                    actions={
                        <>
                            <Button size="sm" iconLeading={BellRinging01} onClick={() => openTask(r.taskId)}>
                                Open task
                            </Button>
                            <Button
                                size="sm"
                                color="secondary"
                                onClick={() => {
                                    setDismissed((s) => new Set([...s, r.id]));
                                    void tasksApi.dismissReminder(r.id).catch(() => undefined);
                                }}
                            >
                                Dismiss
                            </Button>
                        </>
                    }
                >
                    {r.title}
                </Notice>
            ))}
        </div>
    );
};

interface TasksHeaderProps {
    title: string;
    description?: ReactNode;
    crumb?: { label: string; href?: string };
    actions?: ReactNode;
    children?: ReactNode;
    quickAdd?: QuickAddDefaults;
    hideSearch?: boolean;
}

export const TasksHeader = ({ title, description, crumb, actions, children, quickAdd, hideSearch }: TasksHeaderProps) => {
    const { openQuickAdd, writable } = useTasks();
    const [query, setQuery] = useState("");
    const [help, setHelp] = useState(false);
    return (
        <PageHeader
            title={title}
            description={description}
            breadcrumbs={[{ label: "Tasks", href: "/portal/tasks/today" }, ...(crumb ? [crumb] : [])]}
            actions={
                <>
                    {!hideSearch && (
                        <form role="search" action="/portal/tasks/search" method="get" className="w-full sm:w-56">
                            <Input
                                id="tasks-search"
                                aria-label="Search tasks"
                                name="q"
                                size="sm"
                                icon={SearchLg}
                                placeholder="Search"
                                shortcut="/"
                                value={query}
                                onChange={setQuery}
                            />
                        </form>
                    )}
                    {actions}
                    <ButtonUtility
                        size="sm"
                        color="secondary"
                        icon={Keyboard01}
                        tooltip="Keyboard shortcuts (?)"
                        onClick={() => setHelp(true)}
                        className="max-sm:hidden"
                    />
                    {writable.length > 0 && (
                        <Button size="sm" iconLeading={Plus} onClick={() => openQuickAdd(quickAdd)} aria-keyshortcuts="Q">
                            Add task
                        </Button>
                    )}
                    <Shortcuts quickAdd={() => openQuickAdd(quickAdd)} onHelp={() => setHelp(true)} />
                    <PortalDialog
                        isOpen={help}
                        onOpenChange={setHelp}
                        title="Keyboard shortcuts"
                        icon={Keyboard01}
                        description="They don't fire while you're typing in a field."
                    >
                        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 pb-6 text-sm">
                            {SHORTCUTS.map(([keys, what]) => (
                                <div key={keys} className="contents">
                                    <dt>
                                        <kbd className="rounded-sm px-1.5 py-0.5 text-xs font-medium text-secondary ring-1 ring-secondary ring-inset">
                                            {keys}
                                        </kbd>
                                    </dt>
                                    <dd className="text-tertiary">{what}</dd>
                                </div>
                            ))}
                        </dl>
                    </PortalDialog>
                </>
            }
        >
            {children}
        </PageHeader>
    );
};

/** Wraps a Tasks page: context, reminders, Quick Add and the task panel. */
export const TasksLayout = ({ shell, initialTask, children }: { shell: TasksShell; initialTask?: string | null; children: ReactNode }) => {
    const fromUrl = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("task");
    return (
        <TasksProvider shell={shell} initialTask={initialTask ?? (fromUrl && /^tsk_[a-z0-9]{14}$/.test(fromUrl) ? fromUrl : null)}>
            <DueReminders initial={shell.reminders} />
            {children}
            <QuickAddDialog />
            <TaskPanel />
        </TasksProvider>
    );
};
