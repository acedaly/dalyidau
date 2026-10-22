// MCP tools for Amplenote (docs/MCP.md#amplenote, worker/amplenote/assistant.ts): list note titles,
// create a note, add text to a note, add a task to a note. Amplenote is the source of truth and the
// only store: each call goes straight to Amplenote's REST API and nothing is kept here except the
// write ledger's ids. Owner-only (the portal owner who connected Amplenote), behind the
// "Amplenote for AI assistants" switch.
//
// The API can't read note content or find, change or complete tasks, so there are no tools for those.
import { z } from "zod";
import { amplenoteAccess, amplenoteFailure, instantOrNull, noteUrl, selectNotes, sinceSeconds, taskNode, textNodes } from "../amplenote/assistant";
import { createNote, insertNodes, listNotes } from "../amplenote/client";
import { preferences } from "../calendar/access";
import type { WriteOutcome } from "./ledger";
import { type ToolContext, type ToolResult, calendarDate, limit, requestId, tool } from "./shared";

export const noteUuid = z
    .string()
    .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, "Not a valid Amplenote note id")
    .transform((v) => v.toLowerCase());
const tagName = z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9_\-/]{0,59}$/, "Use a lowercase Amplenote tag like work/rfs");
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time like 09:30");

const outcome = (uuid: string): WriteOutcome => ({ entityType: "amplenote_note", entityId: uuid });
const noteRef = (uuid: string) => ({ noteUuid: uuid, url: noteUrl(uuid) });
/** A retried request id: the first write's note, without writing again (access is checked again first). */
const replay = async (ctx: ToolContext, written: WriteOutcome): Promise<ToolResult> => {
    await amplenoteAccess(ctx.env, ctx.user, "list");
    return { data: { replayed: true, ...noteRef(written.entityId) } };
};

const call = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
        return await work();
    } catch (error) {
        throw amplenoteFailure(error);
    }
};

const listNotesTool = tool({
    name: "amplenote_list_notes",
    write: false,
    permission: "portal.settings.manage",
    input: z
        .object({
            query: z.string().trim().max(200).optional(),
            tag: tagName.optional(),
            changedSince: calendarDate.optional(),
            limit: limit(25, 100),
        })
        .strict(),
    run: async (ctx, input) => {
        const token = await amplenoteAccess(ctx.env, ctx.user, "list");
        const since = input.changedSince ? sinceSeconds(input.changedSince, (await preferences(ctx.db, ctx.user.email)).timeZone) : null;
        const notes = await call(() => listNotes(ctx.env, token, since));
        const picked = selectNotes(notes, input);
        return {
            data: {
                notes: picked.items.map((n) => ({
                    noteUuid: n.uuid,
                    name: n.name,
                    tags: n.tags ?? [],
                    created: instantOrNull(n.created),
                    updated: instantOrNull(n.updated),
                    url: noteUrl(n.uuid),
                })),
                count: picked.count,
                truncated: picked.truncated,
                contentAvailable: false,
            },
        };
    },
});

const createNoteTool = tool({
    name: "amplenote_create_note",
    write: true,
    permission: "portal.settings.manage",
    input: z
        .object({
            name: z.string().trim().min(1).max(300),
            tags: z.array(tagName).max(10).optional(),
            requestId,
        })
        .strict(),
    run: async (ctx, input) => {
        const token = await amplenoteAccess(ctx.env, ctx.user, "write");
        const { uuid } = await call(() => createNote(ctx.env, token, { name: input.name, tags: [...new Set(input.tags ?? [])] }));
        return { data: { created: true, name: input.name, ...noteRef(uuid) }, outcome: outcome(uuid) };
    },
    replay,
});

const appendTool = tool({
    name: "amplenote_append",
    write: true,
    permission: "portal.settings.manage",
    input: z
        .object({
            noteUuid,
            text: z
                .string()
                .max(10_000)
                .refine((t) => t.trim().length > 0, "Give some text to add")
                .refine((t) => t.split(/\r?\n/).length <= 200, "At most 200 lines at once"),
            requestId,
        })
        .strict(),
    run: async (ctx, input) => {
        const token = await amplenoteAccess(ctx.env, ctx.user, "write");
        const nodes = textNodes(input.text);
        await call(() => insertNodes(ctx.env, token, input.noteUuid, nodes));
        return { data: { added: true, paragraphs: nodes.length, ...noteRef(input.noteUuid) }, outcome: outcome(input.noteUuid) };
    },
    replay,
});

const createTaskTool = tool({
    name: "amplenote_create_task",
    write: true,
    permission: "portal.settings.manage",
    input: z
        .object({
            noteUuid,
            text: z
                .string()
                .trim()
                .min(1)
                .max(500)
                .refine((t) => !/[\r\n]/.test(t), "A task is one line"),
            dueDate: calendarDate.nullable().optional(),
            dueTime: clock.nullable().optional(),
            important: z.boolean().optional(),
            urgent: z.boolean().optional(),
            reminderAt: z.iso.datetime({ offset: true }).nullable().optional(),
            requestId,
        })
        .strict()
        .refine((t) => !t.dueTime || !!t.dueDate, { message: "dueTime needs a dueDate", path: ["dueTime"] }),
    run: async (ctx, input) => {
        const token = await amplenoteAccess(ctx.env, ctx.user, "write");
        // A request that can't be carried out in full is refused here, before Amplenote is touched.
        const zone = input.dueDate ? (await preferences(ctx.db, ctx.user.email)).timeZone : "UTC";
        const node = taskNode(input, zone);
        await call(() => insertNodes(ctx.env, token, input.noteUuid, [node]));
        return { data: { created: true, text: input.text, ...noteRef(input.noteUuid) }, outcome: outcome(input.noteUuid) };
    },
    replay,
});

export const AMPLENOTE_TOOLS = [listNotesTool, createNoteTool, appendTool, createTaskTool];
