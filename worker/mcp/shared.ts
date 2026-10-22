// What every MCP tool has in common: its definition, the caller's context, input pieces and the
// compact shapes records are returned in. Results are bounded: lists carry a count and say when
// they were cut short, so an AI client never mistakes a partial list for the whole of something.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import type { Permission } from "../../src/shared/portal/permissions";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import type { WriteOutcome } from "./ledger";

export interface ToolContext {
    env: Env;
    db: D1Database;
    user: PortalUser;
    /** The portal's origin, for links back to each record. */
    site: string;
}

export interface ToolResult {
    data: Record<string, unknown>;
    /** For writes: the record written, for the ledger. */
    outcome?: WriteOutcome;
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
    name: string;
    /** Writes go through the ledger (audit and retry safety) and the gateway's tighter write rate limit. */
    write: boolean;
    /** The portal permission needed to use the tool at all ("any_productivity": Calendar or Home & Assets). Access is then checked per record. */
    permission: Permission | "any_productivity";
    input: S;
    run: (ctx: ToolContext, input: z.output<S>) => Promise<ToolResult>;
    /** For a retried write (same request id): the record as it is now, without writing again. */
    replay?: (ctx: ToolContext, outcome: WriteOutcome) => Promise<ToolResult>;
}

export const tool = <S extends z.ZodType>(def: ToolDef<S>): ToolDef => def as unknown as ToolDef;

// --- Input pieces --------------------------------------------------------------------------------

export const id = (prefix: string, what: string) => z.string().regex(new RegExp(`^${prefix}_[a-z0-9]{14}$`), `Not a valid ${what} id`);
export const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-18");
/** A client-chosen id for one intended write. Sending it again returns the first result instead of writing twice. */
export const requestId = z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/, "Use 8–64 letters, digits, - or _")
    .optional();
export const limit = (fallback: number, maximum: number) => z.number().int().min(1).max(maximum).default(fallback);

// --- Output shapes -------------------------------------------------------------------------------

export const portalUrl = (ctx: ToolContext, path: string) => `${ctx.site}${path}`;

/** Cuts a list to `max`, saying how many there were. */
export const bounded = <T>(items: T[], max: number) => ({ items: items.slice(0, max), count: items.length, truncated: items.length > max });
