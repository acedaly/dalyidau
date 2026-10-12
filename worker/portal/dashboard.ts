import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import { type DashboardWidget, WIDGET_TYPES } from "../../src/shared/portal/types";
import { nowIso, parseJson } from "./db";

// Rows of 12 columns on wide screens: small = 4, medium = 8, large = 12.
export const DEFAULT_WIDGETS: DashboardWidget[] = [
    { id: "w-countdown", type: "countdown", size: "sm" },
    { id: "w-rsvp", type: "rsvp-summary", size: "md" },
    { id: "w-invitations", type: "invitation-readiness", size: "sm" },
    { id: "w-events", type: "event-attendance", size: "lg" },
    { id: "w-tasks", type: "upcoming-tasks", size: "md" },
    { id: "w-budget", type: "budget-summary", size: "sm" },
    { id: "w-trend", type: "response-trend", size: "md" },
    { id: "w-guests", type: "guest-breakdown", size: "sm" },
    { id: "w-responses", type: "rsvp-responses", size: "md" },
    { id: "w-dietary", type: "dietary", size: "sm" },
    { id: "w-seating-ready", type: "seating-readiness", size: "sm" },
    { id: "w-comms", type: "communications-status", size: "sm" },
    { id: "w-activity", type: "recent-activity", size: "lg" },
];

const layoutSchema = z
    .array(z.object({ id: z.string().regex(/^[a-z0-9-]{1,40}$/i), type: z.enum(WIDGET_TYPES), size: z.enum(["sm", "md", "lg"]) }))
    .max(30)
    .refine((widgets) => new Set(widgets.map((w) => w.id)).size === widgets.length, "Widget ids must be unique");

export async function getLayout(db: D1Database, email: string): Promise<DashboardWidget[]> {
    const row = await db.prepare("SELECT widgets FROM dashboard_layouts WHERE email = ?").bind(email).first<{ widgets: string }>();
    if (!row) return DEFAULT_WIDGETS;
    const parsed = layoutSchema.safeParse(parseJson(row.widgets, null));
    return parsed.success ? parsed.data : DEFAULT_WIDGETS;
}

/** Layouts are personal preferences, so they are not written to the audit log. */
export async function saveLayout(db: D1Database, email: string, input: unknown): Promise<DashboardWidget[]> {
    const widgets = layoutSchema.parse(input);
    await db
        .prepare(
            `INSERT INTO dashboard_layouts (email, widgets, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(email) DO UPDATE SET widgets = ?2, updated_at = ?3`,
        )
        .bind(email, JSON.stringify(widgets), nowIso())
        .run();
    return widgets;
}

export async function resetLayout(db: D1Database, email: string) {
    await db.prepare("DELETE FROM dashboard_layouts WHERE email = ?").bind(email).run();
    return DEFAULT_WIDGETS;
}
