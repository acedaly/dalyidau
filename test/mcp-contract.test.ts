// The gateway's advertised tools (mcp/src/portal-tools.ts) and the portal's served tools
// (worker/mcp) are one contract, compared directly. Since docs/DECOMMISSION_PORTAL_APPS.md both
// sides serve no tools, and retire the same ones with the same retirement for each.
import { describe, expect, it } from "vitest";
import { PORTAL_TOOLS, PORTAL_TOOL_NAMES, PORTAL_WRITE_TOOLS, RETIRED_TOOL_GROUPS, RETIRED_TOOL_NAMES } from "../mcp/src/portal-tools";
import { PORTAL_MCP_TOOLS } from "../worker/mcp/entrypoint";
import { RETIRED_MCP_GROUPS, RETIRED_MCP_TOOLS } from "../worker/mcp/retired";

describe("MCP tool contract", () => {
    it("advertises exactly the tools the portal serves: none", () => {
        expect([...PORTAL_TOOL_NAMES]).toEqual(PORTAL_MCP_TOOLS.map((t) => t.name));
        expect(PORTAL_TOOL_NAMES).toHaveLength(0);
        expect(Object.keys(PORTAL_TOOLS)).toEqual([]);
        expect(PORTAL_WRITE_TOOLS.size).toBe(0);
    });

    it("retires the same tools on both sides, in the same groups, and serves none of them", () => {
        expect([...RETIRED_TOOL_NAMES].sort()).toEqual([...RETIRED_MCP_TOOLS].sort());
        expect(RETIRED_TOOL_NAMES).toHaveLength(121);
        expect(new Set(RETIRED_TOOL_NAMES).size).toBe(RETIRED_TOOL_NAMES.length);
        expect(RETIRED_TOOL_GROUPS.map((g) => [...g.tools])).toEqual(RETIRED_MCP_GROUPS.map((g) => [...g.tools]));
        // The gateway's answer is the portal's, plus a pointer to refresh the tool list.
        for (const [i, group] of RETIRED_TOOL_GROUPS.entries()) {
            expect(group.message.startsWith(RETIRED_MCP_GROUPS[i].message)).toBe(true);
            expect(group.message).toContain("Refresh the tool list");
        }
        for (const name of RETIRED_TOOL_NAMES) expect((PORTAL_TOOL_NAMES as readonly string[]).includes(name), name).toBe(false);
    });
});
