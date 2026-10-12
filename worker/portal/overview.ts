import type { D1Database } from "@cloudflare/workers-types";
import type { PortalOverview } from "../../src/shared/portal/types";

export async function portalOverview(db: D1Database): Promise<PortalOverview> {
    const [guests, rsvps, seating, catering, messages, invitations] = await db.batch([
        db.prepare("SELECT COUNT(*) AS total FROM guests WHERE deleted_at IS NULL"),
        db.prepare(
            `SELECT
               COUNT(*) FILTER (WHERE status = 'pending') AS pending,
               COUNT(DISTINCT CASE WHEN status = 'attending' THEN guest_id END) AS attending
             FROM guest_events WHERE guest_id IN (SELECT id FROM guests WHERE deleted_at IS NULL)`,
        ),
        db.prepare(
            `SELECT COUNT(*) AS unseated FROM guests g
             WHERE g.deleted_at IS NULL
               AND EXISTS (SELECT 1 FROM guest_events ge WHERE ge.guest_id = g.id AND ge.status = 'attending')
               AND NOT EXISTS (SELECT 1 FROM seat_assignments sa WHERE sa.guest_id = g.id)`,
        ),
        db.prepare(
            `SELECT COUNT(*) AS undecided FROM guests g
             WHERE g.deleted_at IS NULL AND g.meal_category IS NULL
               AND EXISTS (SELECT 1 FROM guest_events ge WHERE ge.guest_id = g.id AND ge.status = 'attending')`,
        ),
        db.prepare(
            `SELECT SUM(status = 'queued') AS queued,
                    (SELECT COUNT(*) FROM message_recipients WHERE status = 'failed') AS failed
             FROM messages`,
        ),
        db.prepare(
            `SELECT SUM(invite_revoked_at IS NULL) AS active, SUM(invite_revoked_at IS NOT NULL) AS revoked
             FROM households WHERE deleted_at IS NULL`,
        ),
    ]);
    const first = (result: { results: unknown[] }) => (result.results[0] ?? {}) as Record<string, number | null>;
    return {
        guests: first(guests).total ?? 0,
        pendingRsvps: first(rsvps).pending ?? 0,
        attending: first(rsvps).attending ?? 0,
        unseated: first(seating).unseated ?? 0,
        cateringUndecided: first(catering).undecided ?? 0,
        queuedMessages: first(messages).queued ?? 0,
        failedDeliveries: first(messages).failed ?? 0,
        activeInvitationLinks: first(invitations).active ?? 0,
        revokedInvitationLinks: first(invitations).revoked ?? 0,
    };
}
