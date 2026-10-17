// Helpers for the Daly Tasks tests. Every identity, project and task is fictional.
import { expect } from "vitest";
import type { TaskDetail, TaskProject, TaskSummary } from "../src/shared/tasks/types";
import { OWNER, SECOND_OWNER, apiCall, db } from "./portal-helpers";

export const T = "/api/portal/tasks";
export const A = OWNER; // "User A"
export const B = SECOND_OWNER; // "User B": the other portal owner
export const ADMIN = "admin@example.com";
export const WEDDING_EDITOR = "wedding-editor@example.com";

export const call = <R = unknown>(method: string, path: string, body?: unknown, email = A) => apiCall<R>(method, `${T}${path}`, body, { email });

export const projects = async (email = A) => (await call<{ projects: TaskProject[] }>("GET", "/projects", undefined, email)).json.projects;
export const inbox = async (email = A) => (await projects(email)).find((p) => p.isInbox)!;

export const createTask = async (body: Record<string, unknown>, email = A) => {
    const result = await call<{ task: TaskSummary }>("POST", "/tasks", body, email);
    expect(result.status, result.text).toBe(201);
    return result.json.task;
};

export const createProject = async (body: Record<string, unknown>, email = A) => {
    const result = await call<{ project: TaskProject }>("POST", "/projects", body, email);
    expect(result.status, result.text).toBe(201);
    return result.json.project;
};

export const detail = async (id: string, email = A) => {
    const result = await call<TaskDetail>("GET", `/tasks/${id}`, undefined, email);
    expect(result.status, result.text).toBe(200);
    return result.json;
};

/** A shared project owned by A with B as a member in the given role. */
export const sharedProject = async (role: "owner" | "editor" | "viewer" = "editor", name = "Household") => {
    const project = await createProject({ name, kind: "shared" });
    const added = await call("POST", `/projects/${project.id}/members`, { email: B, role });
    expect(added.status, added.text).toBe(201);
    return project;
};

export const list = async (view: string, email = A, query = "") =>
    (await call<{ tasks: TaskSummary[] }>("GET", `/lists/${view}${query}`, undefined, email)).json.tasks;

/** Sets a person's time zone, so "today" can be pinned in tests. */
export const setTimeZone = (timeZone: string, email = A) => call("PATCH", "/preferences", { timeZone }, email);

export const activityRows = async () =>
    (
        await db().prepare("SELECT project_id, task_id, actor, action, changes FROM task_activity ORDER BY id").all<{
            project_id: string;
            task_id: string | null;
            actor: string;
            action: string;
            changes: string | null;
        }>()
    ).results;
