// The gateway's advertised tools (mcp/src/portal-tools.ts) and the portal's served tools
// (worker/mcp) are one contract. They used to live in two repositories, each pinning a copy of the
// list; now they are compared directly, field by field.
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { PORTAL_TOOLS, PORTAL_TOOL_NAMES, PORTAL_WRITE_TOOLS } from "../mcp/src/portal-tools";
import { PORTAL_MCP_TOOLS } from "../worker/mcp/entrypoint";

const fields = (schema: z.ZodType) => Object.keys((schema as unknown as { shape?: Record<string, unknown> }).shape ?? {}).sort();

describe("MCP tool contract", () => {
    const portal = new Map(PORTAL_MCP_TOOLS.map((t) => [t.name, t]));

    it("advertises exactly the tools the portal serves", () => {
        expect([...PORTAL_TOOL_NAMES].sort()).toEqual([...portal.keys()].sort());
        expect(PORTAL_TOOL_NAMES).toHaveLength(101);
    });

    it("rate-limits as writes exactly the tools the portal audits as writes", () => {
        expect([...PORTAL_WRITE_TOOLS].sort()).toEqual(
            PORTAL_MCP_TOOLS.filter((t) => t.write)
                .map((t) => t.name)
                .sort(),
        );
    });

    it("advertises the same argument names the portal accepts, for every tool", () => {
        for (const name of PORTAL_TOOL_NAMES) expect(fields(PORTAL_TOOLS[name].input), name).toEqual(fields(portal.get(name)!.input));
    });

    it("marks reads read-only and nothing destructive", () => {
        for (const name of PORTAL_TOOL_NAMES) {
            const { annotations } = PORTAL_TOOLS[name];
            expect(annotations.readOnlyHint, name).toBe(!PORTAL_WRITE_TOOLS.has(name));
            expect(annotations.destructiveHint, name).toBe(false);
        }
    });

    it("never accepts an identity field", () => {
        for (const name of PORTAL_TOOL_NAMES)
            for (const field of ["email", "user", "owner", "actor", "assertion"]) expect(fields(PORTAL_TOOLS[name].input), name).not.toContain(field);
    });
});
