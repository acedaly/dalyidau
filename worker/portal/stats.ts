// One set of aggregate queries behind every dashboard widget and the RSVP page. Sections the user
// may not see (budget, audit) or whose module is switched off come back as null.
import type { D1Database } from "@cloudflare/workers-types";
import type { Flags } from "../../src/shared/portal/flags";
import type { DashboardStats, PortalUser, Side } from "../../src/shared/portal/types";
import { parseJson } from "./db";
import { contactReadiness } from "./households";
import { householdResponses } from "./queries";
import { getSettings } from "./settings";
import { travelOverview } from "./travel";

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

    const [guestTotals, rsvpTotals, sides, events, dietary, responses, trend, invitations, seating, communications] = await db.batch([
        db.prepare(
            `SELECT COUNT(*) AS total,
                    SUM(age_group = 'adult') AS adults, SUM(age_group = 'child') AS children, SUM(age_group = 'infant') AS infants,
                    SUM(email IS NULL OR email = '') AS without_email,
                    (SELECT COUNT(*) FROM households WHERE deleted_at IS NULL) AS households
             FROM guests WHERE deleted_at IS NULL`,
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
                WHERE g.deleted_at IS NULL
                GROUP BY g.id
             )`,
        ),
        db.prepare("SELECT side, COUNT(*) AS count FROM guests WHERE deleted_at IS NULL GROUP BY side"),
        db.prepare(
            `SELECT e.id, e.name, e.starts_at,
                    COUNT(ge.guest_id) AS invited,
                    SUM(ge.status = 'attending') AS attending,
                    SUM(ge.status = 'declined') AS declined,
                    SUM(ge.status = 'pending') AS pending
             FROM events e LEFT JOIN guest_events ge ON ge.event_id = e.id
                AND ge.guest_id IN (SELECT id FROM guests WHERE deleted_at IS NULL)
             GROUP BY e.id ORDER BY e.sort_order, e.starts_at`,
        ),
        // Dietary needs of guests who are coming to at least one event.
        db.prepare(
            `SELECT TRIM(dietary) AS label, COUNT(*) AS count FROM guests g
             WHERE g.deleted_at IS NULL AND dietary IS NOT NULL AND TRIM(dietary) != ''
               AND EXISTS (SELECT 1 FROM guest_events ge WHERE ge.guest_id = g.id AND ge.status = 'attending')
             GROUP BY LOWER(TRIM(dietary)) ORDER BY count DESC LIMIT 12`,
        ),
        db.prepare(
            `SELECT s.submitted_at, s.payload, h.name AS household_name FROM rsvp_submissions s
             JOIN households h ON h.id = s.household_id AND h.deleted_at IS NULL ORDER BY s.submitted_at DESC LIMIT 8`,
        ),
        // The day each guest first answered anything.
        db.prepare(
            `SELECT day, COUNT(*) AS count FROM (
                SELECT guest_id, MIN(substr(responded_at, 1, 10)) AS day FROM guest_events
                WHERE status != 'pending' AND responded_at IS NOT NULL
                  AND guest_id IN (SELECT id FROM guests WHERE deleted_at IS NULL)
                GROUP BY guest_id
             ) GROUP BY day ORDER BY day`,
        ),
        db.prepare(
            `SELECT SUM(invite_revoked_at IS NULL) AS active, SUM(invite_revoked_at IS NOT NULL) AS revoked
             FROM households WHERE deleted_at IS NULL`,
        ),
        db.prepare(
            `SELECT COUNT(DISTINCT g.id) AS attending,
                    COUNT(DISTINCT sa.guest_id) AS seated,
                    COUNT(DISTINCT CASE WHEN sa.guest_id IS NULL THEN g.id END) AS unseated,
                    COUNT(DISTINCT CASE WHEN g.meal_category IS NULL THEN g.id END) AS meals_undecided
             FROM guests g
             LEFT JOIN seat_assignments sa ON sa.guest_id = g.id
             WHERE g.deleted_at IS NULL
               AND EXISTS (SELECT 1 FROM guest_events ge WHERE ge.guest_id = g.id AND ge.status = 'attending')`,
        ),
        db.prepare(
            `SELECT SUM(status = 'draft') AS drafts, SUM(status = 'queued') AS queued,
                    SUM(status IN ('sent', 'partial')) AS sent, SUM(status = 'failed') AS failed FROM messages`,
        ),
    ]);

    const [responses2, contacts, travel, invitationProgress, campaigns] = await Promise.all([
        householdResponses(db),
        contactReadiness(db),
        travelOverview(db),
        db
            .prepare(
                `SELECT
                    (SELECT COUNT(*) FROM households WHERE deleted_at IS NULL AND invitation_generated_at IS NOT NULL) AS generated,
                    (SELECT COUNT(DISTINCT mr.household_id) FROM message_recipients mr JOIN messages m ON m.id = mr.message_id
                     JOIN households h ON h.id = mr.household_id AND h.deleted_at IS NULL
                     WHERE m.category = 'invitation' AND mr.status = 'sent') AS sent`,
            )
            .first<{ generated: number | null; sent: number | null }>(),
        flags["module.communications"]
            ? db
                  .prepare(
                      `SELECT m.category, COUNT(DISTINCT mr.household_id) AS n FROM message_recipients mr JOIN messages m ON m.id = mr.message_id
                       WHERE mr.status = 'sent' AND mr.household_id IS NOT NULL GROUP BY m.category`,
                  )
                  .all<{ category: string; n: number }>()
            : null,
    ]);
    const live = [...responses2.values()];
    const contactRows = [...contacts.values()];
    const flagged = (flag: (typeof contactRows)[number]["flags"][number]) => contactRows.filter((c) => c.flags.includes(flag)).length;
    const sentBy = new Map((campaigns?.results ?? []).map((r) => [r.category, Number(r.n)]));

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
        invitations: {
            active: Number((invitations.results[0] as Record<string, number | null> | undefined)?.active ?? 0),
            revoked: Number((invitations.results[0] as Record<string, number | null> | undefined)?.revoked ?? 0),
            invitedHouseholds: live.filter((r) => r.status !== "not_invited").length,
            generated: Number(invitationProgress?.generated ?? 0),
            sent: Number(invitationProgress?.sent ?? 0),
        },
        followUp: {
            notStarted: live.filter((r) => r.status === "not_started").length,
            partial: live.filter((r) => r.status === "partial").length,
            travel: travel ? travel.households.filter((h) => h.followUp.length > 0).length : 0,
        },
        contacts: {
            households: contactRows.length,
            unreachable: flagged("unreachable"),
            noContact: flagged("no_contact"),
            emailOnly: flagged("email_only"),
            smsOnly: flagged("sms_only"),
            invalidMobile: flagged("invalid_mobile"),
            optedOut: flagged("opted_out"),
        },
        campaigns: flags["module.communications"]
            ? {
                  save_the_date: sentBy.get("save_the_date") ?? 0,
                  invitation: sentBy.get("invitation") ?? 0,
                  reminder: sentBy.get("reminder") ?? 0,
                  final_details: sentBy.get("final_details") ?? 0,
                  thank_you: sentBy.get("thank_you") ?? 0,
              }
            : null,
        transport: travel
            ? {
                  outbound: travel.outbound,
                  return: travel.return,
                  bothWays: travel.bothWays,
                  unsureHouseholds: travel.unsure.households,
                  unanswered: travel.unanswered,
              }
            : null,
        seating: flags["module.planning"]
            ? {
                  attending: Number((seating.results[0] as Record<string, number | null> | undefined)?.attending ?? 0),
                  seated: Number((seating.results[0] as Record<string, number | null> | undefined)?.seated ?? 0),
                  unseated: Number((seating.results[0] as Record<string, number | null> | undefined)?.unseated ?? 0),
                  mealsUndecided: Number((seating.results[0] as Record<string, number | null> | undefined)?.meals_undecided ?? 0),
              }
            : null,
        communications: flags["module.communications"]
            ? {
                  drafts: Number((communications.results[0] as Record<string, number | null> | undefined)?.drafts ?? 0),
                  queued: Number((communications.results[0] as Record<string, number | null> | undefined)?.queued ?? 0),
                  sent: Number((communications.results[0] as Record<string, number | null> | undefined)?.sent ?? 0),
                  failed: Number((communications.results[0] as Record<string, number | null> | undefined)?.failed ?? 0),
              }
            : null,
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
