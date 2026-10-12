// One set of aggregate queries behind every dashboard widget and the RSVP page. Sections the user
// may not see (budget, audit) or whose module is switched off come back as null.
import type { D1Database } from "@cloudflare/workers-types";
import type { Flags } from "../../src/shared/portal/flags";
import type { DashboardStats, PortalUser, Side } from "../../src/shared/portal/types";
import { parseJson } from "./db";
import { getSettings } from "./settings";

/** Today's date (YYYY-MM-DD) in the wedding's time zone. */
export const todayIn = (timeZone: string, now = new Date()) => {
    try {
        return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    } catch {
        return now.toISOString().slice(0, 10);
    }
};

const addDays = (isoDate: string, days: number) => {
    const d = new Date(`${isoDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
};

export async function computeStats(db: D1Database, user: PortalUser, flags: Flags): Promise<DashboardStats> {
    const wedding = await getSettings(db, "wedding");
    const today = todayIn(wedding.timeZone);
    const soon = addDays(today, 30);

    const [guestTotals, rsvpTotals, sides, events, dietary, responses, trend] = await db.batch([
        db.prepare(
            `SELECT COUNT(*) AS total,
                    SUM(age_group = 'adult') AS adults, SUM(age_group = 'child') AS children, SUM(age_group = 'infant') AS infants,
                    SUM(email IS NULL OR email = '') AS without_email,
                    (SELECT COUNT(*) FROM households) AS households
             FROM guests`,
        ),
        db.prepare(
            `SELECT
                SUM(CASE WHEN invited = 0 THEN 1 ELSE 0 END) AS not_invited,
                SUM(CASE WHEN invited > 0 AND attending > 0 THEN 1 ELSE 0 END) AS attending,
                SUM(CASE WHEN invited > 0 AND declined = invited THEN 1 ELSE 0 END) AS declined,
                SUM(CASE WHEN invited > 0 AND attending = 0 AND declined < invited THEN 1 ELSE 0 END) AS pending
             FROM (
                SELECT g.id,
                       COUNT(ge.event_id) AS invited,
                       SUM(ge.status = 'attending') AS attending,
                       SUM(ge.status = 'declined') AS declined
                FROM guests g LEFT JOIN guest_events ge ON ge.guest_id = g.id
                GROUP BY g.id
             )`,
        ),
        db.prepare("SELECT side, COUNT(*) AS count FROM guests GROUP BY side"),
        db.prepare(
            `SELECT e.id, e.name, e.starts_at,
                    COUNT(ge.guest_id) AS invited,
                    SUM(ge.status = 'attending') AS attending,
                    SUM(ge.status = 'declined') AS declined,
                    SUM(ge.status = 'pending') AS pending
             FROM events e LEFT JOIN guest_events ge ON ge.event_id = e.id
             GROUP BY e.id ORDER BY e.sort_order, e.starts_at`,
        ),
        // Dietary needs of guests who are coming to at least one event.
        db.prepare(
            `SELECT TRIM(dietary) AS label, COUNT(*) AS count FROM guests g
             WHERE dietary IS NOT NULL AND TRIM(dietary) != ''
               AND EXISTS (SELECT 1 FROM guest_events ge WHERE ge.guest_id = g.id AND ge.status = 'attending')
             GROUP BY LOWER(TRIM(dietary)) ORDER BY count DESC LIMIT 12`,
        ),
        db.prepare(
            `SELECT s.submitted_at, s.payload, h.name AS household_name FROM rsvp_submissions s
             JOIN households h ON h.id = s.household_id ORDER BY s.submitted_at DESC LIMIT 8`,
        ),
        // The day each guest first answered anything.
        db.prepare(
            `SELECT day, COUNT(*) AS count FROM (
                SELECT guest_id, MIN(substr(responded_at, 1, 10)) AS day FROM guest_events
                WHERE status != 'pending' AND responded_at IS NOT NULL GROUP BY guest_id
             ) GROUP BY day ORDER BY day`,
        ),
    ]);

    const g = (guestTotals.results[0] ?? {}) as Record<string, number | null>;
    const r = (rsvpTotals.results[0] ?? {}) as Record<string, number | null>;

    const stats: DashboardStats = {
        guests: {
            total: g.total ?? 0,
            adults: g.adults ?? 0,
            children: g.children ?? 0,
            infants: g.infants ?? 0,
            withoutEmail: g.without_email ?? 0,
            households: g.households ?? 0,
        },
        rsvp: { attending: r.attending ?? 0, declined: r.declined ?? 0, pending: r.pending ?? 0, notInvited: r.not_invited ?? 0 },
        bySide: (sides.results as { side: Side; count: number }[]).map((s) => ({ side: s.side, count: s.count })),
        events: (events.results as Record<string, unknown>[]).map((e) => ({
            id: e.id as string,
            name: e.name as string,
            startsAt: (e.starts_at as string | null) ?? null,
            invited: Number(e.invited ?? 0),
            attending: Number(e.attending ?? 0),
            declined: Number(e.declined ?? 0),
            pending: Number(e.pending ?? 0),
        })),
        dietary: (dietary.results as { label: string; count: number }[]).map((d) => ({ label: d.label, count: d.count })),
        responseTrend: (() => {
            let running = 0;
            return (trend.results as { day: string; count: number }[]).map((row) => ({ date: row.day, responded: (running += row.count) }));
        })(),
        tasks: null,
        budget: null,
        recentActivity: null,
        recentResponses: (responses.results as { submitted_at: string; payload: string; household_name: string }[]).map((row) => {
            const payload = parseJson<{ guests?: { events?: Record<string, string> }[] }>(row.payload, {});
            const statuses = (payload.guests ?? []).flatMap((guest) => Object.values(guest.events ?? {}));
            return {
                householdName: row.household_name,
                submittedAt: row.submitted_at,
                attending: statuses.filter((s) => s === "attending").length,
                declined: statuses.filter((s) => s === "declined").length,
            };
        }),
    };

    if (flags["module.planning"]) {
        const [counts, due] = await db.batch([
            db.prepare("SELECT SUM(status != 'done') AS open, SUM(status != 'done' AND due_date < ?) AS overdue FROM tasks").bind(today),
            db
                .prepare(
                    `SELECT id, title, due_date, priority, status FROM tasks WHERE status != 'done' AND due_date IS NOT NULL AND due_date <= ?
                     ORDER BY due_date, CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END LIMIT 6`,
                )
                .bind(soon),
        ]);
        const c = (counts.results[0] ?? {}) as Record<string, number | null>;
        stats.tasks = {
            open: c.open ?? 0,
            overdue: c.overdue ?? 0,
            dueSoon: (due.results as Record<string, string>[]).map((t) => ({
                id: t.id,
                title: t.title,
                dueDate: t.due_date,
                priority: t.priority as "low" | "medium" | "high",
                status: t.status as "todo" | "in_progress" | "done",
            })),
        };
    }

    if (flags["module.budget"] && user.permissions.includes("wedding.budget.view")) {
        const settings = await getSettings(db, "budget");
        const row = await db
            .prepare(
                `SELECT SUM(estimated_cents) AS estimated, SUM(COALESCE(actual_cents, 0)) AS actual, SUM(paid_cents) AS paid,
                        SUM(CASE WHEN due_date IS NOT NULL AND due_date <= ?1 THEN MAX(COALESCE(actual_cents, estimated_cents) - paid_cents, 0) ELSE 0 END) AS due_soon
                 FROM budget_items`,
            )
            .bind(soon)
            .first<Record<string, number | null>>();
        stats.budget = {
            totalCents: settings.totalCents,
            estimatedCents: row?.estimated ?? 0,
            actualCents: row?.actual ?? 0,
            paidCents: row?.paid ?? 0,
            dueSoonCents: row?.due_soon ?? 0,
            currency: settings.currency,
        };
    }

    if (user.permissions.includes("portal.audit.view")) {
        const rows = await db
            .prepare("SELECT id, at, actor, summary FROM audit_log ORDER BY id DESC LIMIT 8")
            .all<{ id: number; at: string; actor: string; summary: string }>();
        stats.recentActivity = rows.results;
    }

    return stats;
}
