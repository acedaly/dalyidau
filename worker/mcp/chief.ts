// Chief of Staff context for AI clients: bounded, permission-scoped snapshots of what is recorded in
// Daly Calendar and Home & Assets. They are facts only. Nothing here is inferred, summarised by a
// model or made up: every item carries its id and a link to the record, a source that wasn't checked
// is listed as not checked, and a module the caller can't use is simply absent. The AI client does
// the reasoning.
import { z } from "zod";
import { briefingFacts } from "../assets/dashboard";
import { calendarFacts } from "../calendar/chief";
import { can } from "../portal/auth";
import { type ToolContext, type ToolDef, calendarDate, portalUrl, tool } from "./shared";

/** Items shown per list; every list also says how many there are in total. */
const SHOWN = 10;
/** Sources these tools never look at, named so a briefing can't imply they were checked. */
const NOT_CHECKED = [
    "email",
    "external calendars not subscribed in Daly Calendar",
    "Daly Tasks and Daly Knowledge (retired: never read, and not available through this connector)",
    "DalyHub (retired: never read, and not available through this connector)",
];

const sources = (ctx: ToolContext) => ({
    calendar: can(ctx.user, "calendar.use"),
    homeAssets: can(ctx.user, "assets.use"),
});

const chiefDaily = tool({
    name: "chief_of_staff_daily_context",
    write: false,
    permission: "any_productivity",
    input: z.object({}).strict(),
    run: async (ctx) => {
        const checked = sources(ctx);
        const data: Record<string, unknown> = { generatedAt: new Date().toISOString(), checked, notChecked: NOT_CHECKED };
        // Calendar and leave: what's on in the next week, clashes, important dates, leave and school holidays.
        if (checked.calendar) data.calendar = await calendarFacts(ctx.db, ctx.user, ctx.site, 7);
        // Home & Assets: what's overdue or due in 30 days, from records only (the person can leave it out).
        if (checked.homeAssets) {
            const facts = await briefingFacts(ctx.db, ctx.user, 30);
            if (facts)
                data.homeAssets = {
                    today: facts.today,
                    horizonDays: facts.horizonDays,
                    overdue: facts.overdue.slice(0, SHOWN).map((i) => ({ fact: i.sentence, date: i.date, url: portalUrl(ctx, i.url) })),
                    dueSoon: facts.dueSoon.slice(0, SHOWN).map((i) => ({ fact: i.sentence, date: i.date, url: portalUrl(ctx, i.url) })),
                    counts: { overdue: facts.overdue.length, dueSoon: facts.dueSoon.length },
                    notChecked: facts.notChecked,
                };
        }
        return { data };
    },
});

const chiefWeekly = tool({
    name: "chief_of_staff_weekly_context",
    write: false,
    permission: "any_productivity",
    input: z.object({ weekEnding: calendarDate.optional() }).strict(),
    run: async (ctx) => {
        const checked = sources(ctx);
        const data: Record<string, unknown> = { generatedAt: new Date().toISOString(), checked, notChecked: NOT_CHECKED };
        if (checked.calendar) data.calendar = await calendarFacts(ctx.db, ctx.user, ctx.site, 14);
        // Possible follow-ups are for the AI client to propose from these facts, and to label as proposals.
        return { data };
    },
});

export const CHIEF_TOOLS: ToolDef[] = [chiefDaily, chiefWeekly];
