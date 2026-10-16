// A household's communications history, newest first, assembled from what's already recorded:
// campaign recipients (message_recipients), invitations generated in Invitation Studio
// (invitation_artifacts), online RSVPs (rsvp_submissions) and text messages (sms_messages).
// Nothing is copied into a new table. Test sends are deliberately not part of it: a test is never
// a household being contacted.
import type { D1Database } from "@cloudflare/workers-types";
import { MESSAGE_CATEGORY_LABELS, type MessageCategory, type TimelineEntry } from "../../src/shared/portal/types";
import { NotFoundError } from "./entities";

export async function householdTimeline(db: D1Database, householdId: string, options: { includeReplies: boolean }): Promise<TimelineEntry[]> {
    const household = await db.prepare("SELECT id FROM households WHERE id = ?").bind(householdId).first();
    if (!household) throw new NotFoundError("Household not found");
    const [messages, artifacts, submissions, texts] = await db.batch([
        db
            .prepare(
                // One entry per message: sent if anyone in the household was sent it, else why it was held back.
                `SELECT m.id, m.subject, m.category, m.channel, m.status AS message_status, m.created_at, m.sent_at AS message_sent_at,
                        MAX(CASE WHEN mr.status = 'sent' THEN mr.sent_at END) AS sent_at,
                        MAX(CASE WHEN mr.status = 'sent' THEN mr.name END) AS sent_to,
                        MAX(CASE WHEN mr.status = 'sent' THEN mr.delivery_status END) AS delivery_status,
                        MAX(CASE WHEN mr.status = 'failed' THEN mr.error END) AS failure,
                        MAX(CASE WHEN mr.status = 'skipped' AND mr.error NOT LIKE 'Included in the household%' THEN mr.error END) AS held_back,
                        SUM(mr.status = 'pending') AS pending
                 FROM message_recipients mr JOIN messages m ON m.id = mr.message_id
                 WHERE mr.household_id = ?1
                 GROUP BY m.id ORDER BY COALESCE(MAX(mr.sent_at), m.created_at) DESC LIMIT 100`,
            )
            .bind(householdId),
        db
            .prepare("SELECT channel, invite_version, status, updated_at FROM invitation_artifacts WHERE household_id = ? ORDER BY updated_at DESC LIMIT 20")
            .bind(householdId),
        db.prepare("SELECT id, submitted_at FROM rsvp_submissions WHERE household_id = ? ORDER BY submitted_at DESC LIMIT 20").bind(householdId),
        db
            .prepare(
                `SELECT s.id, s.direction, s.body, s.status, s.created_at FROM sms_messages s
                 WHERE (s.household_id = ?1 OR s.guest_id IN (SELECT id FROM guests WHERE household_id = ?1)) AND s.message_id IS NULL
                 ORDER BY s.created_at DESC LIMIT 50`,
            )
            .bind(householdId),
    ]);
    const entries: TimelineEntry[] = [];
    for (const m of messages.results as Record<string, string | number | null>[]) {
        const category = m.category as MessageCategory;
        const kind = MESSAGE_CATEGORY_LABELS[category] ?? "Message";
        const channel = m.channel === "sms" ? "Text" : "Email";
        let outcome: TimelineEntry["outcome"];
        let detail: string;
        if (m.sent_at) {
            outcome = m.delivery_status && m.delivery_status !== "delivered" ? "failed" : "sent";
            detail = `${channel} to ${m.sent_to}${m.delivery_status ? ` · ${m.delivery_status}` : ""}`;
        } else if (m.failure) {
            outcome = "failed";
            detail = `${channel} failed: ${m.failure}`;
        } else if (Number(m.pending) > 0) {
            outcome = "prepared";
            detail = m.message_status === "queued" ? `${channel} scheduled` : `${channel} prepared, not sent yet`;
        } else {
            outcome = "held";
            detail = `${channel} not sent: ${m.held_back ?? "held back"}`;
        }
        entries.push({
            at: String(m.sent_at ?? m.created_at),
            kind: category === "rsvp_confirmation" ? "rsvp_confirmation" : "message",
            title: `${kind}: ${m.subject}`,
            detail,
            outcome,
            href: `/portal/wedding/communications/${m.id}`,
        });
    }
    for (const a of artifacts.results as { channel: string; invite_version: number; status: string; updated_at: string }[])
        entries.push({
            at: a.updated_at,
            kind: "invitation",
            title: `Invitation generated (${a.channel === "print" ? "print" : a.channel === "sms" ? "text" : "email"})`,
            detail: `Link version ${a.invite_version}${a.status === "generated" ? " · generated, not sent" : ` · ${a.status}`}`,
            outcome: "prepared",
            href: null,
        });
    for (const s of submissions.results as { submitted_at: string }[])
        entries.push({
            at: s.submitted_at,
            kind: "rsvp",
            title: "RSVP received online",
            detail: "Answers saved from the household's invitation link",
            outcome: "received",
            href: null,
        });
    for (const t of texts.results as { direction: string; body: string; status: string; created_at: string }[])
        entries.push({
            at: t.created_at,
            kind: t.direction === "inbound" ? "reply" : "text",
            title: t.direction === "inbound" ? "Text reply received" : "Text sent from conversations",
            // Guests' own words are only shown to people who can read text conversations.
            detail: options.includeReplies ? t.body.slice(0, 280) : "Open Text conversations to read it",
            outcome: t.direction === "inbound" ? "received" : t.status === "failed" ? "failed" : "sent",
            href: options.includeReplies ? "/portal/wedding/communications/texts" : null,
        });
    return entries.sort((a, b) => b.at.localeCompare(a.at));
}
