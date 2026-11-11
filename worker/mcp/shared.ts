// What an MCP tool served by the portal has in common: its definition and the caller's context.
// The portal serves no tools at the moment (docs/DECOMMISSION_PORTAL_APPS.md); a new one is a read
// with a permission, defined here and listed in PORTAL_MCP_TOOLS (entrypoint.ts) and, with the same
// argument names, in the gateway (mcp/src/portal-tools.ts).
import type { D1Database } from "@cloudflare/workers-types";
import type { z } from "zod";
import type { Permission } from "../../src/shared/portal/permissions";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";

export interface ToolContext {
    env: Env;
    db: D1Database;
    user: PortalUser;
    /** The portal's origin, for links back to each record. */
    site: string;
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
    name: string;
    /** The portal permission needed to use the tool at all. Access is then checked per record. */
    permission: Permission;
    input: S;
    run: (ctx: ToolContext, input: z.output<S>) => Promise<{ data: Record<string, unknown> }>;
}
