// A booked service in Home & Assets can become a real Calendar appointment, created through
// Calendar's own createEvent in a calendar the person can edit, once per record. Important dates are
// otherwise shown in Calendar as reminders (an overlay worked out from these records, never copied as
// events: dashboard.ts).
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import type { PortalUser } from "../../src/shared/portal/types";
import { ensureDefaultCalendar } from "../calendar/access";
import { createEvent, eventDetail } from "../calendar/events";
import { can } from "../portal/auth";
import { nowIso } from "../portal/db";
import { HttpError } from "../portal/http";
import { activity } from "./access";
import { requireRecord } from "./maintenance";

const appointmentInput = z
    .object({
        calendarId: z
            .string()
            .regex(/^cal_[a-z0-9]{14}$/)
            .optional(),
        durationMinutes: z.number().int().min(15).max(1440).optional(),
        visibility: z.enum(["default", "private"]).optional(),
    })
    .strict();

const addMinutes = (time: string, minutes: number) => {
    const total = Math.min(23 * 60 + 59, Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)) + minutes);
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

/**
 * A real Calendar appointment for a booked record (its booked date, and time if given), created
 * through Calendar with its checks. Once per record: asking again returns the same event.
 */
export async function createAppointment(
    db: D1Database,
    user: PortalUser,
    maintenanceId: string,
    input: unknown,
): Promise<{ eventId: string; existing: boolean }> {
    if (!can(user, "calendar.use")) throw new HttpError(403, "forbidden", "You don't have access to Daly Calendar");
    const body = appointmentInput.parse(input ?? {});
    const { row, target } = await requireRecord(db, user, maintenanceId, true);
    if (row.calendar_event_id) {
        const still = await eventDetail(db, user, row.calendar_event_id).catch(() => null);
        if (still) return { eventId: row.calendar_event_id, existing: true };
    }
    if (!row.scheduled_on) throw new HttpError(422, "validation", "Enter the booked date first");
    const calendarId = body.calendarId ?? (await ensureDefaultCalendar(db, user));
    const timed = !!row.scheduled_time;
    const { event } = await createEvent(db, user, {
        calendarId,
        title: row.title.toLowerCase().includes(target.name.toLowerCase()) ? row.title : `${row.title}: ${target.name}`,
        description: "Booked in Home & Assets.",
        location: row.provider,
        allDay: !timed,
        startDate: row.scheduled_on,
        endDate: row.scheduled_on,
        ...(timed ? { startTime: row.scheduled_time, endTime: addMinutes(row.scheduled_time!, body.durationMinutes ?? 60) } : {}),
        category: "appointment",
        visibility: body.visibility ?? "default",
        clientId: `asset-appt-${maintenanceId}`,
    });
    await db.batch([
        db
            .prepare(
                "UPDATE asset_maintenance SET calendar_event_id = ?, status = CASE WHEN status = 'open' THEN 'scheduled' ELSE status END, updated_at = ? WHERE id = ?",
            )
            .bind(event.id, nowIso(), maintenanceId),
        activity(db, { actor: user.email, action: "maintenance.appointment", entityType: "maintenance", entityId: maintenanceId, assetId: row.asset_id }),
    ]);
    return { eventId: event.id, existing: false };
}
