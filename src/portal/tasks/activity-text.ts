// Plain-language sentences for history entries. Entries hold only ids and safe values, so these
// never need (or show) a task's text; the current title is added by the page when it's visible.
import { relativeDate } from "@/shared/tasks/dates";
import { PRIORITY_LABELS, type Priority, type TaskActivityEntry } from "@/shared/tasks/types";

const ACTIONS: Record<string, string> = {
    "project.create": "created the project",
    "project.update": "changed the project's details",
    "project.status": "changed the project's status",
    "project.share": "shared the project",
    "project.unshare": "made the project personal",
    "member.add": "added a member",
    "member.role": "changed a member's role",
    "member.remove": "removed a member",
    "member.leave": "left the project",
    "section.create": "added a section",
    "section.delete": "deleted a section",
    "task.create": "added",
    "subtask.create": "added a subtask",
    "task.update": "changed",
    "task.complete": "completed",
    "task.skip": "skipped an occurrence of",
    "task.reopen": "reopened",
    "task.move": "moved",
    "task.move_in": "moved into this project",
    "task.move_out": "moved a task to another project",
    "task.duplicate": "duplicated",
    "task.delete": "deleted a task",
    "comment.add": "commented on",
    "comment.delete": "deleted a comment on",
    "knowledge.link": "linked Knowledge to",
    "knowledge.unlink": "removed a Knowledge link from",
};

const FIELD_NAMES: Record<string, string> = {
    title: "the title",
    description: "the description",
    recurrence: "the repeat",
    labels: "the labels",
    section: "the section",
};

/** "changed the priority to P1 and the due date to Friday". */
export function describeChanges(entry: TaskActivityEntry, today: string): string {
    const changes = entry.changes ?? {};
    const parts: string[] = [];
    for (const [key, value] of Object.entries(changes)) {
        if (key === "priority" && typeof value === "number") parts.push(`the priority to ${PRIORITY_LABELS[value as Priority].short}`);
        else if (key === "dueDate") parts.push(value ? `the due date to ${relativeDate(String(value), today)}` : "the due date (removed)");
        else if (key === "deadline") parts.push(value ? `the deadline to ${relativeDate(String(value), today)}` : "the deadline (removed)");
        else if (key === "assignee") parts.push(value ? `the assignee to ${String(value).split("@")[0]}` : "the assignee (unassigned)");
        else if (key === "isMilestone") parts.push(value ? "it to a milestone" : "it from a milestone");
        else if (FIELD_NAMES[key]) parts.push(FIELD_NAMES[key]);
    }
    return parts.length ? parts.join(", ") : "";
}

export function activitySentence(entry: TaskActivityEntry, today: string): string {
    const verb = ACTIONS[entry.action] ?? entry.action;
    if (entry.action === "task.update") {
        const what = describeChanges(entry, today);
        return what ? `changed ${what}` : "edited";
    }
    if (entry.action === "task.complete" && entry.changes?.next) return `completed an occurrence (next ${relativeDate(String(entry.changes.next), today)})`;
    return verb;
}

/** Whether the sentence is followed by the task's title ("completed “Pay rent”"). */
export const takesTitle = (action: string) =>
    !["project.", "member.", "section.", "task.move_in", "task.move_out", "task.delete"].some((prefix) => action.startsWith(prefix)) &&
    !action.startsWith("subtask.");
