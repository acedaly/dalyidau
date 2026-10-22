// Daly Intelligence tools for the MCP gateway (docs/INTELLIGENCE.md, docs/MCP.md).
//
// They call the same functions as the portal's Intelligence pages, as the person the Access token
// proves, and only read. Reading a briefing never triggers inference: recommendations are included
// only when the portal already prepared them for the same facts.
import { z } from "zod";
import { getBriefing } from "../intelligence/briefings";
import { type ToolDef, calendarDate, tool } from "./shared";

const briefingOut = (view: Awaited<ReturnType<typeof getBriefing>>) => ({
    kind: view.kind,
    period: view.period,
    checked: view.checked,
    notChecked: view.notChecked,
    facts: view.sections.map((s) => ({ section: s.title, count: s.count, items: s.items })),
    recommendations: { status: view.recommendations.status, label: "AI suggestions, not facts", items: view.recommendations.items },
    changesSincePrevious: view.changesSincePrevious,
});

const dailyBriefing = tool({
    name: "intelligence_get_daily_briefing",
    write: false,
    permission: "intelligence.use",
    input: z.object({}).strict(),
    run: async (ctx) => ({ data: briefingOut(await getBriefing(ctx.env, ctx.user, "daily", { site: ctx.site })) }),
});

const weeklyReview = tool({
    name: "intelligence_get_weekly_review",
    write: false,
    permission: "intelligence.use",
    input: z.object({ weekEnding: calendarDate.optional() }).strict(),
    run: async (ctx, input) => ({ data: briefingOut(await getBriefing(ctx.env, ctx.user, "weekly", { site: ctx.site, period: input.weekEnding })) }),
});

export const INTELLIGENCE_TOOLS: ToolDef[] = [dailyBriefing, weeklyReview];
