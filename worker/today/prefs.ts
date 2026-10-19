// Today's per-person preferences (migration 0024): sections and their order, breaks, focus periods,
// calendars that don't count towards availability, the briefing's display and the like. Working
// hours and session lengths stay in the Daily Planner's own preferences (worker/planner/blocks.ts),
// which Today's settings edit alongside these.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import type { PortalUser } from "../../src/shared/portal/types";
import { DEFAULT_TODAY_PREFERENCES, type TodayPreferences, todayPreferences } from "../../src/shared/today/types";
import { activity } from "../calendar/access";
import { listCalendars } from "../calendar/calendars";
import { nowIso, parseJson } from "../portal/db";
import { HttpError } from "../portal/http";

export async function loadTodayPrefs(db: D1Database, email: string): Promise<{ preferences: TodayPreferences; version: number }> {
    const row = await db.prepare("SELECT value, version FROM today_preferences WHERE email = ?").bind(email).first<{ value: string; version: number }>();
    if (!row) return { preferences: DEFAULT_TODAY_PREFERENCES, version: 0 };
    // An older or damaged document falls back to the defaults rather than breaking Today or the planner.
    const parsed = todayPreferences.safeParse(parseJson<Record<string, unknown>>(row.value, {}));
    return { preferences: parsed.success ? parsed.data : DEFAULT_TODAY_PREFERENCES, version: row.version };
}

const saveInput = z.object({ preferences: todayPreferences, version: z.number().int().min(0) }).strict();

export async function saveTodayPrefs(db: D1Database, user: PortalUser, input: unknown) {
    const body = saveInput.parse(input);
    // Only calendars the person can see can be left out of availability.
    const visible = new Set((await listCalendars(db, user)).map((c) => c.id));
    const unknown = body.preferences.excludedCalendarIds.filter((id) => !visible.has(id));
    if (unknown.length) throw new HttpError(422, "validation", "One of the calendars isn't yours to choose");
    const now = nowIso();
    const value = JSON.stringify(body.preferences);
    const write =
        body.version === 0
            ? db
                  .prepare("INSERT INTO today_preferences (email, value, version, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT DO NOTHING")
                  .bind(user.email, value, now)
            : db
                  .prepare("UPDATE today_preferences SET value = ?, version = version + 1, updated_at = ? WHERE email = ? AND version = ?")
                  .bind(value, now, user.email, body.version);
    const result = await write.run();
    if (!result.meta.changes) throw new HttpError(409, "conflict", "Your Today settings changed in another window. Reload to see them.");
    await activity(db, { actor: user.email, action: "today.preferences", entityType: "today_preferences" }).run();
    return loadTodayPrefs(db, user.email);
}
