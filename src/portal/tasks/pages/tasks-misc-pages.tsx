// Search, Activity and Settings (preferences, reminders, import from Todoist and export).
import { useState } from "react";
import { Activity, Download01, Folder, SearchLg } from "@untitledui/icons";
import { FeedItem } from "@/components/application/activity-feed/activity-feed";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { Toggle } from "@/components/base/toggle/toggle";
import { Empty } from "@/portal/components/empty";
import { Notice } from "@/portal/components/notice";
import { useToast } from "@/portal/components/toast";
import { downloadExport } from "@/portal/knowledge/shared";
import { errorMessage } from "@/portal/lib/api";
import { formatDateTime, formatRelative, initials } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import {
    LANDING_PAGES,
    type LandingPage,
    PRIORITIES,
    PRIORITY_LABELS,
    type Priority,
    type TaskActivityEntry,
    type TaskPreferences,
} from "@/shared/tasks/types";
import { activitySentence, takesTitle } from "../activity-text";
import { projectHref, taskHref, tasksApi } from "../api";
import { ProjectDot, personLabel } from "../shared";
import { TaskList } from "../task-list";
import { useTasks } from "../tasks-context";
import { TasksHeader, TasksLayout } from "../tasks-layout";
import { TodoistImport } from "../todoist-import";
import { useLiveList } from "../use-live-list";
import { useTaskActions } from "../use-task-actions";

// --- Search --------------------------------------------------------------------------------------

export const TasksSearchPage = ({ data }: { data: PageData<"tasks-search"> }) => (
    <TasksLayout shell={data}>
        <SearchBody data={data} />
    </TasksLayout>
);

const SearchBody = ({ data }: { data: PageData<"tasks-search"> }) => {
    const { project } = useTasks();
    const actions = useTaskActions();
    const [query, setQuery] = useState(data.query);
    const { tasks } = useLiveList(data.tasks, async () => (await tasksApi.search(data.query)).tasks, { keepCompleted: true });
    return (
        <>
            <TasksHeader
                title="Search"
                crumb={{ label: "Search" }}
                hideSearch
                description="Titles, descriptions, labels and project names, across every project you're in."
            />
            <form role="search" action="/portal/tasks/search" method="get" className="max-w-xl">
                <Input
                    aria-label="Search tasks"
                    name="q"
                    icon={SearchLg}
                    placeholder="Search tasks"
                    value={query}
                    onChange={setQuery}
                    autoFocus={!data.query}
                />
            </form>
            {data.matchedProjects.length > 0 && (
                <section aria-label="Matching projects" className="flex flex-wrap gap-3">
                    {data.matchedProjects.map((p) => {
                        const full = project(p.id);
                        return (
                            <a
                                key={p.id}
                                href={projectHref(p.id)}
                                className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-secondary ring-1 ring-secondary outline-focus-ring ring-inset hover:bg-primary_hover focus-visible:outline-2"
                            >
                                {full ? <ProjectDot color={full.color} /> : <Folder aria-hidden="true" className="size-4" />}
                                {p.name}
                            </a>
                        );
                    })}
                </section>
            )}
            {data.query ? (
                <TaskList
                    aria-label="Matching tasks"
                    tasks={tasks}
                    actions={actions}
                    showProject
                    empty={
                        <Empty
                            icon={SearchLg}
                            title="No matching tasks"
                            description={`Nothing matches “${data.query}”. Every word has to appear somewhere in the task.`}
                            size="sm"
                        />
                    }
                />
            ) : (
                <Empty icon={SearchLg} title="Search your tasks" description="Press / on any Tasks page to search." size="sm" />
            )}
            {actions.dialogs}
        </>
    );
};

// --- Activity ------------------------------------------------------------------------------------

export const TasksActivityPage = ({ data }: { data: PageData<"tasks-activity"> }) => (
    <TasksLayout shell={data}>
        <ActivityBody data={data} />
    </TasksLayout>
);

const ActivityBody = ({ data }: { data: PageData<"tasks-activity"> }) => {
    const { projects, project, today, shell } = useTasks();
    const toast = useToast();
    const [entries, setEntries] = useState<TaskActivityEntry[]>(data.entries);
    const [more, setMore] = useState(data.entries.length >= 50);
    const people = Object.values(shell.assignable).flat();
    return (
        <>
            <TasksHeader
                title="Activity"
                crumb={{ label: "Activity" }}
                description="What's changed in your projects. It records what happened, never what tasks or comments say."
            />
            <Select
                aria-label="Project"
                size="sm"
                className="w-full sm:w-64"
                value={data.projectId ?? "all"}
                onChange={(key) => window.location.assign(key === "all" ? "/portal/tasks/activity" : `/portal/tasks/activity?project=${key}`)}
                items={[{ id: "all", label: "All projects" }, ...projects.map((p) => ({ id: p.id, label: p.name }))]}
            >
                {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
            </Select>
            {entries.length === 0 ? (
                <Empty icon={Activity} title="No activity yet" description="Changes to tasks and projects appear here." size="sm" />
            ) : (
                <ul className="flex max-w-3xl flex-col gap-6">
                    {entries.map((entry, i) => {
                        const owner = project(entry.projectId);
                        return (
                            <li key={entry.id}>
                                <FeedItem
                                    id={entry.id}
                                    connector={i < entries.length - 1}
                                    user={{
                                        name: entry.actorName ?? personLabel(entry.actor, people),
                                        initials: initials(entry.actorName ?? entry.actor.split("@")[0]),
                                    }}
                                    date={`${formatRelative(entry.at)}${owner && !data.projectId ? ` · ${owner.name}` : ""}`}
                                    dateTime={entry.at}
                                    action={{
                                        content: activitySentence(entry, today),
                                        target: takesTitle(entry.action) && entry.taskTitle ? entry.taskTitle : undefined,
                                        href: entry.taskId && entry.taskTitle ? taskHref(entry.taskId) : undefined,
                                    }}
                                />
                                <span className="sr-only">{formatDateTime(entry.at, shell.preferences.timeZone)}</span>
                            </li>
                        );
                    })}
                </ul>
            )}
            {more && (
                <Button
                    size="sm"
                    color="secondary"
                    className="self-start"
                    onClick={async () => {
                        try {
                            const next = await tasksApi.activity(data.projectId, entries[entries.length - 1].id);
                            setEntries([...entries, ...next.entries]);
                            setMore(next.entries.length >= 50);
                        } catch (error) {
                            toast.error("Couldn't load more", errorMessage(error));
                        }
                    }}
                >
                    Load more
                </Button>
            )}
        </>
    );
};

// --- Settings ------------------------------------------------------------------------------------

const ZONES = [
    "Australia/Sydney",
    "Australia/Melbourne",
    "Australia/Brisbane",
    "Australia/Adelaide",
    "Australia/Darwin",
    "Australia/Perth",
    "Australia/Hobart",
    "Australia/Lord_Howe",
    "Pacific/Auckland",
    "Europe/London",
    "UTC",
];

export const TasksSettingsPage = ({ data }: { data: PageData<"tasks-settings"> }) => (
    <TasksLayout shell={data}>
        <SettingsBody data={data} />
    </TasksLayout>
);

const SettingsBody = ({ data }: { data: PageData<"tasks-settings"> }) => {
    const toast = useToast();
    const [timeZone, setTimeZone] = useState(data.preferences.timeZone);
    const [todayPriority, setTodayPriority] = useState<Priority | null>(data.preferences.todayPriority);
    const [prefs, setPrefs] = useState<TaskPreferences>(data.preferences);
    const { isOn } = usePortal();
    const [busy, setBusy] = useState<string | null>(null);
    const zones = ZONES.includes(timeZone) ? ZONES : [timeZone, ...ZONES];

    const savePrefs = async (body: Parameters<typeof tasksApi.preferences>[0]) => {
        try {
            setPrefs((await tasksApi.preferences(body)).preferences);
            toast.success("Saved");
        } catch (error) {
            toast.error("Couldn't save that", errorMessage(error));
        }
    };
    const LANDING_LABELS: Record<LandingPage, string> = { today: "Today", upcoming: "Upcoming", inbox: "Inbox", mine: "All my tasks" };
    const REMINDER_OFFSETS = [
        { id: "none", label: "No reminder" },
        { id: "0", label: "At the due time (9 am if there's no time)" },
        { id: "15", label: "15 minutes before" },
        { id: "30", label: "30 minutes before" },
        { id: "60", label: "1 hour before" },
        { id: "1440", label: "1 day before" },
    ];
    const exportAs = async (format: "json" | "csv", scope: "all" | "personal") => {
        setBusy(`${format}-${scope}`);
        try {
            await downloadExport(`/api/portal/tasks/export?format=${format}&scope=${scope}`);
        } catch (error) {
            toast.error("The export failed", errorMessage(error));
        } finally {
            setBusy(null);
        }
    };

    const Card = ({ title, description, children }: { title: string; description: string; children: React.ReactNode }) => (
        <section className="flex flex-col gap-4 rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset sm:p-6">
            <div className="flex flex-col gap-1">
                <h2 className="text-md font-semibold text-primary">{title}</h2>
                <p className="text-sm text-tertiary">{description}</p>
            </div>
            {children}
        </section>
    );

    return (
        <>
            <TasksHeader title="Settings and export" crumb={{ label: "Settings" }} />
            <div className="flex max-w-3xl flex-col gap-6">
                <Card
                    title="Your time zone"
                    description="Decides what “today” is for you. Dates on tasks never move: a task due on the 24th is due on the 24th wherever you are."
                >
                    <Select
                        aria-label="Time zone"
                        size="sm"
                        className="w-full sm:w-72"
                        value={timeZone}
                        onChange={(key) => {
                            if (!key) return;
                            setTimeZone(String(key));
                            void savePrefs({ timeZone: String(key) });
                        }}
                        items={zones.map((z) => ({ id: z, label: z.replace(/_/g, " ") }))}
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                </Card>
                <Card
                    title="Today"
                    description="Today shows overdue tasks, tasks due today and today's deadlines. You can also include undated tasks at a high priority."
                >
                    <Select
                        aria-label="Undated tasks in Today"
                        size="sm"
                        className="w-full sm:w-72"
                        value={todayPriority ? String(todayPriority) : "none"}
                        onChange={(key) => {
                            const value = key === "none" || !key ? null : (Number(key) as Priority);
                            setTodayPriority(value);
                            void savePrefs({ todayPriority: value });
                        }}
                        items={[
                            { id: "none", label: "Don't include undated tasks" },
                            ...PRIORITIES.slice(0, 3).map((p) => ({
                                id: String(p),
                                label: `Include undated ${PRIORITY_LABELS[p].short}${p > 1 ? ` and higher` : ""}`,
                            })),
                        ]}
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                </Card>
                <Card
                    title="Export your tasks"
                    description="Everything you can see, in an open format you keep: projects, sections, tasks and subtasks, labels, assignments, dates, repeat rules (also as iCalendar RRULE), completion history and comments. JSON keeps the full structure; CSV is one row per task for spreadsheets."
                >
                    <div className="flex flex-wrap gap-3">
                        <Button
                            size="sm"
                            iconLeading={Download01}
                            isLoading={busy === "json-all"}
                            showTextWhileLoading
                            onClick={() => void exportAs("json", "all")}
                        >
                            Everything (JSON)
                        </Button>
                        <Button
                            size="sm"
                            color="secondary"
                            iconLeading={Download01}
                            isLoading={busy === "csv-all"}
                            showTextWhileLoading
                            onClick={() => void exportAs("csv", "all")}
                        >
                            Everything (CSV)
                        </Button>
                        <Button
                            size="sm"
                            color="secondary"
                            iconLeading={Download01}
                            isLoading={busy === "json-personal"}
                            showTextWhileLoading
                            onClick={() => void exportAs("json", "personal")}
                        >
                            Personal only (JSON)
                        </Button>
                    </div>
                    <p className="text-xs text-tertiary">Exports are downloaded straight to this device and never stored anywhere else.</p>
                </Card>
                <Card
                    title="Reminders"
                    description="Reminders appear in Tasks when they're due, on any device where Tasks is open. They can also be emailed to you, even when Tasks isn't open. Only your own reminders are ever sent to you, and an email carries the task's title, date, priority and project, never its description, comments or linked Knowledge."
                >
                    {!isOn("tasks.reminders.email") && (
                        <Notice title="Email reminders aren't switched on for the portal" color="gray">
                            A portal owner can turn on “Task reminder emails” in Portal settings → Features once an email provider is set up. Until then, your
                            choice is saved and reminders appear in the app only.
                        </Notice>
                    )}
                    <Toggle
                        size="sm"
                        className="w-full"
                        label="Reminders"
                        hint="Off: no reminders at all, in the app or by email."
                        isSelected={prefs.remindersEnabled}
                        onChange={(remindersEnabled) => void savePrefs({ remindersEnabled })}
                    />
                    <Toggle
                        size="sm"
                        className="w-full"
                        label="Email my reminders to me"
                        hint="Sent within about 15 minutes of the reminder time. Rarely, a reminder may arrive twice if delivery was interrupted."
                        isSelected={prefs.reminderEmail}
                        isDisabled={!prefs.remindersEnabled}
                        onChange={(reminderEmail) => void savePrefs({ reminderEmail })}
                    />
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                        <Select
                            label="New dated tasks get a reminder"
                            size="sm"
                            value={prefs.defaultReminderMinutes === null ? "none" : String(prefs.defaultReminderMinutes)}
                            onChange={(key) => key && void savePrefs({ defaultReminderMinutes: key === "none" ? null : Number(key) })}
                            items={REMINDER_OFFSETS}
                        >
                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                        </Select>
                        <Input
                            label="Quiet hours from"
                            type="time"
                            size="sm"
                            value={prefs.quietStart ?? ""}
                            onChange={(quietStart) => setPrefs((p) => ({ ...p, quietStart: quietStart || null }))}
                            onBlur={() =>
                                !!prefs.quietStart === !!prefs.quietEnd ? void savePrefs({ quietStart: prefs.quietStart, quietEnd: prefs.quietEnd }) : undefined
                            }
                        />
                        <Input
                            label="Until"
                            type="time"
                            size="sm"
                            value={prefs.quietEnd ?? ""}
                            hint="Emails due then are sent when quiet hours end."
                            onChange={(quietEnd) => setPrefs((p) => ({ ...p, quietEnd: quietEnd || null }))}
                            onBlur={() =>
                                !!prefs.quietStart === !!prefs.quietEnd ? void savePrefs({ quietStart: prefs.quietStart, quietEnd: prefs.quietEnd }) : undefined
                            }
                        />
                    </div>
                    <p className="text-xs text-tertiary">Browser and phone notifications aren't available yet.</p>
                </Card>
                <Card title="First page" description="Which page opens when you go to Tasks.">
                    <Select
                        aria-label="First page"
                        size="sm"
                        className="w-full sm:w-72"
                        value={prefs.landingPage}
                        onChange={(key) => key && void savePrefs({ landingPage: key as LandingPage })}
                        items={LANDING_PAGES.map((p) => ({ id: p, label: LANDING_LABELS[p] }))}
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                </Card>
                <Card
                    title="Import from Todoist"
                    description="Bring your Todoist projects across: export each project as CSV in Todoist (or download a backup zip from Todoist's settings) and choose the files here. You'll see exactly what will happen before anything is imported, and importing the same files again never makes copies."
                >
                    <TodoistImport />
                    {data.imports.length > 0 && (
                        <details className="text-sm">
                            <summary className="cursor-pointer font-medium text-secondary">Earlier imports ({data.imports.length})</summary>
                            <ul className="mt-2 flex flex-col gap-1 text-tertiary">
                                {data.imports.map((i) => (
                                    <li key={i.id}>
                                        {formatDateTime(i.createdAt, data.preferences.timeZone)} ·{" "}
                                        {i.status === "completed" ? "finished" : i.status === "failed" ? "stopped part-way" : "in progress"}
                                        {i.summary ? ` · ${i.summary.tasksCreated} tasks added, ${i.summary.tasksUpdated} updated` : ""}
                                    </li>
                                ))}
                            </ul>
                        </details>
                    )}
                </Card>
            </div>
        </>
    );
};
