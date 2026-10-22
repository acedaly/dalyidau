// Acting on public information through the portal's own applications: calendar events linked to
// watch areas, and the Today and Calendar views. Each goes through that application's own function
// and permission checks; nothing here writes to another application's tables.
import { z } from "zod";
import { addDays, localDate } from "../../src/shared/calendar/time";
import { feedLabel, isSignificant } from "../../src/shared/centre/history";
import type { SituationReport } from "../../src/shared/centre/reports";
import { sourceById } from "../../src/shared/centre/sources";
import type { TodayCentre, TodayCentreItem } from "../../src/shared/centre/types";
import type { PortalUser } from "../../src/shared/portal/types";
import { occurrencesInWindow } from "../calendar/events";
import { eventDetail } from "../calendar/events";
import type { Env } from "../env";
import { can } from "../portal/auth";
import { auditStatement, newId, nowIso } from "../portal/db";
import { HttpError } from "../portal/http";
import { listAlerts } from "./alerts";
import { listMatches } from "./rules";
import { listChanges, listRecords, loadPreferences, sourceRows } from "./store";
import { listWatches, recordsForWatch, requireWatch } from "./watch";

const when = (iso: string | null) =>
    iso ? new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)) : "not given";

// --- Journeys: calendar events linked to watch areas ---------------------------------------------------

export interface EventLink {
    id: string;
    eventId: string;
    watchId: string;
    watchName: string;
    title: string | null;
    start: string | null;
}

/** Links one of the person's events to one of their watch areas (a route corridor or a destination). */
export async function linkEvent(env: Env, user: PortalUser, body: unknown) {
    if (!can(user, "calendar.use")) throw new HttpError(403, "forbidden", "You can't use Daly Calendar");
    const input = z
        .object({ eventId: z.string().regex(/^cev_[a-z0-9]{14}$/), watchId: z.string().regex(/^icw_[a-z0-9]{14}$/) })
        .strict()
        .parse(body);
    // Calendar's own permission check: an event the person can't see is a 404 there.
    await eventDetail(env.DB, user, input.eventId);
    await requireWatch(env.DB, user.email, input.watchId);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM ic_event_links WHERE email = ?").bind(user.email).first<{ n: number }>();
    if ((count?.n ?? 0) >= 50) throw new HttpError(422, "validation", "You can link up to 50 events");
    const id = newId("ick");
    await env.DB.batch([
        env.DB.prepare("INSERT OR IGNORE INTO ic_event_links (id, email, event_id, watch_id, created_at) VALUES (?, ?, ?, ?, ?)").bind(
            id,
            user.email,
            input.eventId,
            input.watchId,
            nowIso(),
        ),
        // Ids only: an event's title and a watch area's location are private.
        auditStatement(env.DB, {
            actor: user.email,
            action: "centre.event_link.create",
            entityType: "centre_event_link",
            entityId: id,
            summary: "Linked a calendar event to a watch area",
        }),
    ]);
    return listEventLinks(env, user);
}

export async function unlinkEvent(env: Env, user: PortalUser, id: string) {
    if (!/^ick_[a-z0-9]{14}$/.test(id)) throw new HttpError(404, "not_found", "Not found");
    const result = await env.DB.prepare("DELETE FROM ic_event_links WHERE id = ? AND email = ?").bind(id, user.email).run();
    if (!result.meta.changes) throw new HttpError(404, "not_found", "Not found");
    await auditStatement(env.DB, {
        actor: user.email,
        action: "centre.event_link.delete",
        entityType: "centre_event_link",
        entityId: id,
        summary: "Unlinked a calendar event",
    }).run();
}

export async function listEventLinks(env: Env, user: PortalUser): Promise<EventLink[]> {
    const rows = (
        await env.DB.prepare(
            "SELECT l.id, l.event_id, l.watch_id, w.name AS watch_name FROM ic_event_links l JOIN ic_watch_areas w ON w.id = l.watch_id AND w.email = l.email WHERE l.email = ? ORDER BY l.created_at",
        )
            .bind(user.email)
            .all<{ id: string; event_id: string; watch_id: string; watch_name: string }>()
    ).results;
    const out: EventLink[] = [];
    for (const r of rows) {
        // Read through Calendar each time: an event the person can no longer see shows no details.
        const event = can(user, "calendar.use") ? await eventDetail(env.DB, user, r.event_id).catch(() => null) : null;
        out.push({
            id: r.id,
            eventId: r.event_id,
            watchId: r.watch_id,
            watchName: r.watch_name,
            title: event?.title ?? null,
            start: event ? `${event.startDate}${event.startTime ? `T${event.startTime}` : ""}` : null,
        });
    }
    return out;
}

/** Linked events starting in the next 14 days (or happening now), with what concerns their watch area. */
async function upcomingJourneys(env: Env, user: PortalUser, timeZone: string): Promise<TodayCentre["journeys"]> {
    if (!can(user, "calendar.use")) return [];
    const links = (
        await env.DB.prepare("SELECT l.event_id, l.watch_id FROM ic_event_links l WHERE l.email = ? LIMIT 50")
            .bind(user.email)
            .all<{ event_id: string; watch_id: string }>()
    ).results;
    if (!links.length) return [];
    const today = localDate(new Date(), timeZone);
    const { occurrences } = await occurrencesInWindow(env.DB, user, { from: today, to: addDays(today, 14), timeZone, limit: 500 });
    const out: TodayCentre["journeys"] = [];
    for (const link of links) {
        const next = occurrences.find((o) => o.eventId === link.event_id && !o.busyOnly && o.status !== "cancelled");
        if (!next) continue;
        const watch = await requireWatch(env.DB, user.email, link.watch_id).catch(() => null);
        if (!watch) continue;
        const matches = (await recordsForWatch(env.DB, { ...watch, categories: [] }, 200)).filter(({ record }) =>
            record.kind === "warning" || record.kind === "incident"
                ? record.severityRank >= 1
                : record.kind === "disruption" && record.attributes.closure === "yes",
        ).length;
        out.push({
            eventId: link.event_id,
            title: next.title,
            start: next.start,
            watchName: watch.name,
            matches,
            url: `/portal/intelligence-centre/records?watch=${watch.id}`,
        });
    }
    return out.sort((a, b) => a.start.localeCompare(b.start)).slice(0, 4);
}

// --- Today -----------------------------------------------------------------------------------------

/**
 * Today's short Intelligence section: only what meets the person's own relevance rules (their
 * watch areas, from their chosen level; fire danger for their districts; calendar matches when
 * they turned that on). Never every minor incident. Null when they've switched it off.
 */
export async function todayCentre(env: Env, user: PortalUser): Promise<TodayCentre | null> {
    if (!can(user, "centre.use")) return null;
    const { preferences } = await loadPreferences(env.DB, user.email);
    if (!preferences.today.enabled) return null;
    const watches = (await listWatches(env.DB, user.email)).filter((w) => w.enabled);
    const items = new Map<string, TodayCentreItem>();
    /** Every record that concerns one of the person's watch areas, for their developments. */
    const watched = new Map<string, string>();
    for (const watch of watches.slice(0, 10)) {
        for (const { record, reason } of await recordsForWatch(env.DB, watch, 100)) {
            watched.set(record.id, watch.name);
            if (items.has(record.id)) continue;
            if (record.kind === "rating") {
                if (!preferences.today.showFireDanger) continue;
                const ban = record.attributes.banToday === "yes";
                items.set(record.id, {
                    id: record.id,
                    title: `${record.title}: ${record.attributes.today ?? "No rating"} today${ban ? ", Total Fire Ban" : ""}`,
                    detail: `Fire danger · ${watch.name}`,
                    url: `/portal/intelligence-centre/records/${record.id}`,
                    kind: "fire_danger",
                    rank: ban ? 3 : record.severityRank,
                });
                continue;
            }
            if (record.kind === "observation" || record.kind === "detection") continue;
            if ((record.kind === "incident" || record.kind === "warning") && record.severityRank < preferences.today.minLevel) continue;
            if (record.kind === "disruption" && record.attributes.closure !== "yes" && record.category !== "power") continue;
            items.set(record.id, {
                id: record.id,
                title: record.title,
                detail: `${record.warningLevel ?? record.status ?? record.provider} · ${watch.name} · ${reason}`.slice(0, 200),
                url: `/portal/intelligence-centre/records/${record.id}`,
                kind: record.kind === "warning" ? "warning" : record.kind === "disruption" ? "disruption" : "incident",
                rank: record.severityRank,
            });
        }
    }
    if (preferences.calendarMatching && can(user, "calendar.use")) for (const m of await calendarMatches(env, user, preferences.timeZone)) items.set(m.id, m);
    const alerts = (await listAlerts(env.DB, user.email, { unacknowledged: true, limit: 50 })).length;
    const stale = await env.DB.prepare("SELECT COUNT(*) AS n FROM ic_sources WHERE enabled = 1 AND consecutive_failures >= 3").first<{ n: number }>();
    const t = preferences.today;
    const since = new Date(Date.now() - 86_400_000).toISOString();
    // Significant changes in the person's own watch areas: escalations, new warnings, ratings and bans.
    const developments: TodayCentre["developments"] =
        t.developments && watched.size
            ? (await listChanges(env.DB, { since, limit: 500 }))
                  .filter((c) => c.recordId && watched.has(c.recordId) && isSignificant(c) && c.kind !== "not_in_feed")
                  .slice(0, 4)
                  .map((c) => ({
                      id: c.id,
                      label: `${feedLabel(c)} · ${watched.get(c.recordId!)}`,
                      summary: c.summary,
                      at: c.at,
                      url: `/portal/intelligence-centre/records/${c.recordId}`,
                  }))
            : [];
    const ruleMatches: TodayCentre["ruleMatches"] = t.ruleMatches
        ? (await listMatches(env.DB, user.email, { open: true, since: new Date(Date.now() - 7 * 86_400_000).toISOString(), limit: 4 })).map((m) => ({
              id: m.id,
              rule: m.ruleName,
              reason: m.reason,
              at: m.at,
              url: `/portal/intelligence-centre/rules#${m.id}`,
          }))
        : [];
    let report: TodayCentre["report"] = null;
    if (t.reports) {
        const latest = await env.DB.prepare(
            "SELECT id, title, generated_at, object_key FROM ic_reports WHERE email = ? AND schedule_id IS NOT NULL AND generated_at >= ? ORDER BY generated_at DESC LIMIT 1",
        )
            .bind(user.email, new Date(Date.now() - 2 * 86_400_000).toISOString())
            .first<{ id: string; title: string; generated_at: string; object_key: string }>();
        const body = latest ? ((await (await env.MEDIA.get(latest.object_key))?.json().catch(() => null)) as SituationReport | null) : null;
        if (latest)
            report = {
                id: latest.id,
                title: latest.title,
                generatedAt: latest.generated_at,
                lines: (body?.sections.find((s) => s.key === "overview")?.facts ?? []).slice(0, 3).map((f) => f.text),
                url: `/portal/intelligence-centre/reports/${latest.id}`,
            };
    }
    const sourceFailures: TodayCentre["sourceFailures"] = [];
    if (t.sourceFailures)
        for (const [id, row] of await sourceRows(env.DB)) {
            const source = sourceById(id);
            if (!source || !row.enabled || !["rfs-incidents", "rfs-incident-alerts", "rfs-fire-danger", "bom-warnings"].includes(id)) continue;
            const staleNow = row.last_success_at && Date.now() - Date.parse(row.last_success_at) > source.staleAfterMinutes * 60_000;
            if (row.consecutive_failures >= 3 || staleNow)
                sourceFailures.push({
                    sourceId: id,
                    label: `${source.provider}: ${source.dataset}`,
                    detail: row.last_success_at ? `Last retrieved ${when(row.last_success_at)}.` : "Not retrieved yet.",
                });
        }
    return {
        items: [...items.values()].sort((a, b) => b.rank - a.rank).slice(0, 6),
        alerts,
        watches: watches.length,
        staleNote: stale?.n ? `${stale.n} ${stale.n === 1 ? "source isn't" : "sources aren't"} being retrieved, so this may be incomplete.` : null,
        developments,
        ruleMatches,
        report,
        sourceFailures,
        journeys: await upcomingJourneys(env, user, preferences.timeZone),
    };
}

/**
 * Upcoming events (seven days) whose location names a place an active official warning or
 * incident names. Only the event's own location text is compared, word for word; private and
 * sensitive events aren't read at all.
 */
export async function calendarMatches(env: Env, user: PortalUser, timeZone: string): Promise<TodayCentreItem[]> {
    const today = localDate(new Date(), timeZone);
    const { occurrences } = await occurrencesInWindow(env.DB, user, { from: today, to: addDays(today, 7), timeZone, limit: 200 });
    // Details withheld (someone else's private event, free/busy) and private or sensitive events are never read.
    const located = occurrences.filter((o) => o.location && !o.busyOnly && o.visibility === "default" && o.status !== "cancelled");
    if (!located.length) return [];
    const { records } = await listRecords(env.DB, { kinds: ["warning", "incident"], minLevel: 1 }, 500);
    const words = (text: string) =>
        new Set(
            text
                .toLowerCase()
                .split(/[^a-z]+/)
                .filter((w) => w.length >= 4),
        );
    const out: TodayCentreItem[] = [];
    for (const o of located) {
        const places = words(o.location!);
        const hit = records.find((r) => [...words(`${r.areaName ?? ""} ${r.title}`)].some((w) => places.has(w)));
        if (hit)
            out.push({
                id: `cal:${o.eventId}:${o.startDate}:${hit.id}`,
                title: `${o.title} (${o.startDate}): ${hit.title}`,
                detail: `A place named in this event's location is named in a current ${hit.provider} ${hit.kind}. Check the official source.`,
                url: `/portal/intelligence-centre/records/${hit.id}`,
                kind: "calendar",
                rank: hit.severityRank,
            });
    }
    return out.slice(0, 5);
}
