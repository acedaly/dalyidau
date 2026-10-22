// Amplenote for AI assistants (docs/AMPLENOTE.md#ai-assistants, worker/mcp/amplenote.ts).
//
// Amplenote is the only place these notes and tasks live. Through its REST API an assistant can list
// note titles and tags, create a note, add text to a note and add a task to a note. That is all the API
// offers: it can't read a note's content, find a task, or change or complete one. Nothing here keeps
// a copy of anything (no note list, content or task in D1), syncs in the background or queues work
// for later.
//
// Who may use it: only a portal owner who is also the person who connected Amplenote, and only while
// the "Amplenote for AI assistants" switch is on. Writes also need a connection made with the
// assistant scopes (Portal settings → Website & Blog → Reconnect after switching it on).
import { zonedInstant } from "../../src/shared/calendar/time";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { isEnabled } from "../portal/flags";
import { HttpError } from "../portal/http";
import {
    AmplenoteError,
    type AmplenoteNode,
    AmplenoteWriteError,
    type ApiNote,
    WRITE_SCOPES,
    accessToken,
    grantedScopes,
    loadConnection,
    restConfigured,
} from "./client";

export const ASSISTANT_FLAG = "website.amplenote.assistant" as const;

export const noteUrl = (uuid: string) => `https://www.amplenote.com/notes/${uuid}`;

const NOT_YOURS = "Amplenote tools are only for the portal owner who connected Amplenote.";
const RECONNECT = "Reconnect Amplenote in Portal settings → Website & Blog.";

/**
 * Checks everything that decides whether this person may reach Amplenote, in an order that tells a
 * second owner nothing about the connection, then returns a current access token.
 */
export async function amplenoteAccess(env: Env, user: PortalUser, need: "list" | "write"): Promise<string> {
    if (!(await isEnabled(env.DB, ASSISTANT_FLAG))) {
        throw new HttpError(403, "forbidden", "Amplenote for AI assistants is switched off (Portal settings → Features). Nothing was read or changed.");
    }
    if (user.role !== "owner") throw new HttpError(403, "forbidden", NOT_YOURS);
    const connection = restConfigured(env) ? await loadConnection(env) : null;
    if (connection && connection.connected_by.trim().toLowerCase() !== user.email.trim().toLowerCase()) {
        throw new HttpError(403, "forbidden", NOT_YOURS);
    }
    if (!connection) throw new HttpError(403, "forbidden", `Amplenote isn't connected. Connect it in Portal settings → Website & Blog.`);
    if (need === "write") {
        const granted = grantedScopes(connection.scope);
        if (!WRITE_SCOPES.every((s) => granted.has(s))) {
            throw new HttpError(403, "forbidden", `This Amplenote connection can only list notes, so nothing was added. ${RECONNECT}`);
        }
    }
    const token = await accessToken(env, connection);
    if (!token) throw new HttpError(403, "forbidden", `Amplenote no longer accepts this connection, so nothing was read or changed. ${RECONNECT}`);
    return token;
}

/** Amplenote may or may not have carried out a write: the assistant must not report it either way. */
export class AmplenoteUncertain extends Error {}

/** A task property the person asked for that Amplenote's API can't (or isn't confirmed to) set. */
export class AmplenoteUnsupported extends Error {
    constructor(readonly unsupported: string[]) {
        super(
            `Amplenote's API can't set ${listed(unsupported.map((p) => TASK_PROPERTIES[p as TaskProperty].label))} on a new task (not confirmed to work), so no task was created. ` +
                "Tell the person. Create the task without them only if they agree, or put the date in the task's text if they ask for that.",
        );
    }
}

const listed = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`);

/** Turns a failed Amplenote call into an answer the assistant can act on, without guessing what happened. */
export function amplenoteFailure(error: unknown): Error {
    if (error instanceof AmplenoteWriteError && error.unknownOutcome) {
        return new AmplenoteUncertain(
            "Amplenote didn't confirm this, so it may or may not have been added. Ask the person to check Amplenote before trying again, so nothing is added twice.",
        );
    }
    if (error instanceof AmplenoteError) {
        if (error.status === 401) return new HttpError(403, "forbidden", `Amplenote refused this connection, so nothing was read or changed. ${RECONNECT}`);
        if (error.status === 403)
            return new HttpError(403, "forbidden", `Amplenote refused this: the connection isn't allowed to do it. Nothing was changed. ${RECONNECT}`);
        if (error.status === 404) return new HttpError(404, "not_found", "Amplenote has no note with that id (or it was deleted). Nothing was changed.");
        if (error.status === 400 || error.status === 422)
            return new HttpError(400, "validation", "Amplenote rejected the request as sent. Nothing was changed.");
    }
    return error instanceof Error ? error : new Error("Amplenote request failed");
}

// --- Reading the note list ------------------------------------------------------------------------

export interface NoteListQuery {
    query?: string;
    tag?: string;
    /** A calendar date in the person's time zone: only notes changed on or after it. */
    changedSince?: string;
    limit: number;
}

export const instantOrNull = (seconds: number | null) => (seconds === null ? null : new Date(seconds * 1000).toISOString());

/** Filters and orders Amplenote's metadata listing. Deleted notes are left out; nothing is stored. */
export function selectNotes(notes: ApiNote[], query: NoteListQuery) {
    const words = (query.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const tag = query.tag?.trim().toLowerCase();
    const matches = notes
        .filter((n) => !n.deleted)
        .filter((n) => !tag || (n.tags ?? []).some((t) => t.toLowerCase() === tag || t.toLowerCase().startsWith(`${tag}/`)))
        .filter((n) => {
            if (!words.length) return true;
            const haystack = `${n.name ?? ""} ${(n.tags ?? []).join(" ")}`.toLowerCase();
            return words.every((w) => haystack.includes(w));
        })
        .sort((a, b) => (b.updated ?? b.created ?? 0) - (a.updated ?? a.created ?? 0));
    return { items: matches.slice(0, query.limit), count: matches.length, truncated: matches.length > query.limit };
}

/** Unix seconds for the start of a calendar date in the person's time zone. */
export const sinceSeconds = (date: string, timeZone: string) => Math.floor(Date.parse(zonedInstant(date, "00:00", timeZone)) / 1000);

// --- Content ----------------------------------------------------------------------------------------

const paragraph = (text: string): AmplenoteNode => ({ type: "paragraph", content: [{ type: "text", text }] });

/** Plain text as paragraphs, one per non-empty line. Nothing is interpreted as markup. */
export function textNodes(text: string): AmplenoteNode[] {
    return text
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((line) => line.replace(/\s+$/, ""))
        .filter((line) => line.trim().length > 0)
        .map(paragraph);
}

// --- Tasks ------------------------------------------------------------------------------------------
// Amplenote tasks are check_list_item nodes inserted into a note. Its published API documentation
// doesn't say which attributes such a node accepts. Every property below starts unconfirmed (attr:
// null) and is refused, never dropped, until a live check (scripts/amplenote-write-check.mjs) shows
// that Amplenote stores it, at which point its attribute is filled in here.

export interface TaskPropertySupport {
    label: string;
    /** The check_list_item attribute that carries it, once confirmed against the real service. */
    attr: string | null;
}

export const TASK_PROPERTIES = {
    dueDate: { label: "a due date", attr: null },
    important: { label: "the Important flag", attr: null },
    urgent: { label: "the Urgent flag", attr: null },
    reminderAt: { label: "a reminder", attr: null },
} as const satisfies Record<string, TaskPropertySupport>;
export type TaskProperty = keyof typeof TASK_PROPERTIES;

export interface TaskRequest {
    text: string;
    dueDate?: string | null;
    dueTime?: string | null;
    important?: boolean;
    urgent?: boolean;
    reminderAt?: string | null;
}

/** The properties the request actually asks for (false and null ask for nothing). */
export function requestedProperties(task: TaskRequest): TaskProperty[] {
    const asked: TaskProperty[] = [];
    if (task.dueDate) asked.push("dueDate");
    if (task.important === true) asked.push("important");
    if (task.urgent === true) asked.push("urgent");
    if (task.reminderAt) asked.push("reminderAt");
    return asked;
}

/**
 * The check_list_item node for a task, with every requested property set, or AmplenoteUnsupported
 * naming each one that can't be. Never a task with some properties quietly left off.
 */
export function taskNode(task: TaskRequest, timeZone: string, support: Record<TaskProperty, TaskPropertySupport> = TASK_PROPERTIES): AmplenoteNode {
    const asked = requestedProperties(task);
    const missing = asked.filter((p) => !support[p].attr);
    if (missing.length) throw new AmplenoteUnsupported(missing);
    const attrs: Record<string, unknown> = {};
    for (const p of asked) {
        const attr = support[p].attr!;
        // A date with no time goes as 09:00 in the person's time zone. Revisit this encoding (seconds,
        // and the time used for a date-only task) when the attribute is confirmed.
        if (p === "dueDate") attrs[attr] = Math.floor(Date.parse(zonedInstant(task.dueDate!, task.dueTime ?? "09:00", timeZone)) / 1000);
        else if (p === "reminderAt") attrs[attr] = Math.floor(Date.parse(task.reminderAt!) / 1000);
        else attrs[attr] = true;
    }
    return { type: "check_list_item", ...(asked.length ? { attrs } : {}), content: [paragraph(task.text.trim())] };
}
