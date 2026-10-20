// Acting on public information through the portal's own applications: a task (optionally in a
// project, with a due date as a reminder), a Knowledge note, and the Today and Calendar views. Each
// goes through that application's own function and permission checks; nothing here writes to
// another application's tables.
import { z } from "zod";
import { addDays, localDate } from "../../src/shared/calendar/time";
import { sourceById } from "../../src/shared/centre/sources";
import type { CentreBriefing, CentreRecord, TodayCentre, TodayCentreItem } from "../../src/shared/centre/types";
import { RECORD_KIND_LABELS } from "../../src/shared/centre/types";
import { paragraphsFromText } from "../../src/shared/knowledge/content";
import type { PortalUser } from "../../src/shared/portal/types";
import { occurrencesInWindow } from "../calendar/events";
import type { Env } from "../env";
import { eventDetail } from "../calendar/events";
import { ensurePersonalSpace, listSpaces } from "../knowledge/access";
import { addRelation, createObject } from "../knowledge/objects";
import { can } from "../portal/auth";
import { auditStatement, newId, nowIso } from "../portal/db";
import { HttpError } from "../portal/http";
import { createTask } from "../tasks/tasks";
import { feedLabel, isSignificant } from "../../src/shared/centre/history";
import type { SituationReport } from "../../src/shared/centre/reports";
import { listAlerts } from "./alerts";
import { recordTimeline } from "./history";
import { listMatches } from "./rules";
import { getRecord, listChanges, listRecords, loadPreferences, sourceRows } from "./store";
import { listWatches, recordsForWatch, requireWatch } from "./watch";

const when = (iso: string | null) =>
    iso ? new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)) : "not given";

/** The record as plain text: what it says, where from, and when, with the attribution. */
export function recordText(record: CentreRecord, site: string): string {
    const source = sourceById(record.sourceId);
    return [
        `${RECORD_KIND_LABELS[record.kind]} from ${record.provider}${source ? ` (${source.dataset})` : ""}.`,
        record.warningLevel ? `Level as published: ${record.warningLevel}.` : null,
        record.status ? `Status as published: ${record.status}.` : null,
        record.areaName ? `Location as published: ${record.areaName}.` : null,
        record.description,
        `Published: ${when(record.publishedAt)}. Last official update: ${when(record.updatedAt)}.${record.observedAt ? ` Observed: ${when(record.observedAt)}.` : ""} Collected: ${when(record.lastSeenAt)}.`,
        record.sourceUrl ? `Official source: ${record.sourceUrl}` : null,
        `In the Intelligence Centre: ${site}/portal/intelligence-centre/records/${record.id}`,
        source?.attribution ?? null,
        "Saved from public information. Always check the official source and follow official warnings.",
    ]
        .filter(Boolean)
        .join("\n\n");
}

const taskInput = z
    .object({
        projectId: z
            .string()
            .regex(/^tpj_[a-z0-9]{14}$/)
            .optional(),
        dueDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .nullable()
            .optional(),
        title: z.string().trim().min(1).max(200).optional(),
        clientId: z
            .string()
            .regex(/^[A-Za-z0-9_-]{8,64}$/)
            .optional(),
    })
    .strict();

export async function taskFromRecord(env: Env, user: PortalUser, recordId: string, body: unknown) {
    if (!can(user, "tasks.use")) throw new HttpError(403, "forbidden", "You can't use Daly Tasks");
    const found = await getRecord(env.DB, recordId);
    if (!found) throw new HttpError(404, "not_found", "Not found");
    const input = taskInput.parse(body ?? {});
    const site = new URL(env.SITE_URL).origin;
    // Tasks checks the project's membership itself; a project the person can't write to is a 404 there.
    const { task, replayed } = await createTask(env.DB, user, {
        title: input.title ?? `Follow up: ${found.record.title}`.slice(0, 200),
        description: recordText(found.record, site).slice(0, 4000),
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.dueDate ? { dueDate: input.dueDate } : {}),
        labels: [],
        clientId: input.clientId ?? `centre-${recordId}`,
    });
    return { taskId: task.id, url: `/portal/tasks/t/${task.id}`, replayed };
}

const knowledgeInput = z
    .object({
        spaceId: z
            .string()
            .regex(/^ksp_[a-z0-9]{14}$/)
            .optional(),
        /** Also link the new note, as evidence, to an existing note in the same space. */
        relateTo: z
            .string()
            .regex(/^kob_[a-z0-9]{14}$/)
            .optional(),
    })
    .strict();

/** Links a saved note to an existing one through Knowledge's own relation function (already linked is fine). */
async function relate(env: Env, user: PortalUser, objectId: string, relateTo?: string) {
    if (!relateTo) return false;
    await addRelation(env.DB, user, objectId, { targetId: relateTo, relationType: "evidence" }).catch((error: unknown) => {
        if (!(error instanceof HttpError && error.status === 409)) throw error;
    });
    return true;
}

export async function writableSpace(env: Env, user: PortalUser, spaceId?: string) {
    if (!can(user, "knowledge.use")) throw new HttpError(403, "forbidden", "You can't use Daly Knowledge");
    // As Knowledge does on first open: someone who hasn't used Knowledge yet still has a personal space.
    await ensurePersonalSpace(env.DB, user);
    const spaces = await listSpaces(env.DB, user.email);
    const space = spaceId ? spaces.find((s) => s.id === spaceId) : (spaces.find((s) => s.kind === "personal") ?? spaces[0]);
    if (!space || space.role === "viewer") throw new HttpError(404, "not_found", "Choose a space you can add to");
    return space;
}

export async function knowledgeFromRecord(env: Env, user: PortalUser, recordId: string, body: unknown) {
    const found = await getRecord(env.DB, recordId);
    if (!found) throw new HttpError(404, "not_found", "Not found");
    const input = knowledgeInput.parse(body ?? {});
    const space = await writableSpace(env, user, input.spaceId);
    const site = new URL(env.SITE_URL).origin;
    // The record's id is the source: saving again returns the note already made.
    const detail = await createObject(
        env.DB,
        user,
        space.id,
        {
            title: found.record.title.slice(0, 300),
            content: { type: "doc", content: paragraphsFromText(recordText(found.record, site)) },
            tags: ["intelligence-centre", found.record.category.replace(/_/g, "-")],
        },
        { source: { system: "intelligence-centre", id: recordId } },
    );
    const linked = await relate(env, user, detail.object.id, input.relateTo);
    return { objectId: detail.object.id, url: `/portal/knowledge/o/${detail.object.id}`, linked };
}

/** A record's timeline as a Knowledge note: each event with its nature, its own time and when it was collected. */
export async function knowledgeFromTimeline(env: Env, user: PortalUser, recordId: string, body: unknown) {
    const input = knowledgeInput.parse(body ?? {});
    const timeline = await recordTimeline(env, recordId);
    if (!timeline) throw new HttpError(404, "not_found", "Not found");
    const space = await writableSpace(env, user, input.spaceId);
    const site = new URL(env.SITE_URL).origin;
    const nature = { official: "Official", observed: "Observed", derived: "Derived, not official", collection: "Collection" } as const;
    const lines = [
        `Timeline of ${timeline.title}, from what the Intelligence Centre collected. Saved ${when(nowIso())}.`,
        ...timeline.events.map((e) => `${when(e.at)} · ${nature[e.nature]} · ${e.label}: ${e.detail}${e.collectedAt && e.collectedAt !== e.at ? ` (collected ${when(e.collectedAt)})` : ""}`),
        ...timeline.notes,
        `In the Intelligence Centre: ${site}/portal/intelligence-centre/records/${recordId}`,
        "This is not an official warning. Follow official warnings and directions.",
    ];
    const detail = await createObject(
        env.DB,
        user,
        space.id,
        {
            title: `Timeline: ${timeline.title}`.slice(0, 300),
            content: { type: "doc", content: paragraphsFromText(lines.join("\n\n").slice(0, 60_000)) },
            tags: ["intelligence-centre", "timeline"],
        },
        // Once per record per hour: saving again soon after returns the same note.
        { source: { system: "intelligence-centre-timeline", id: `${recordId}:${nowIso().slice(0, 13)}` } },
    );
    const linked = await relate(env, user, detail.object.id, input.relateTo);
    return { objectId: detail.object.id, url: `/portal/knowledge/o/${detail.object.id}`, linked };
}

export async function knowledgeFromBriefing(env: Env, user: PortalUser, briefing: CentreBriefing, body: unknown) {
    const input = knowledgeInput.parse(body ?? {});
    const space = await writableSpace(env, user, input.spaceId);
    const site = new URL(env.SITE_URL).origin;
    const lines = [
        `${briefing.title}, ${when(briefing.generatedAt)}. Facts from public sources collected by the Intelligence Centre.`,
        ...briefing.sections.flatMap((s) => [s.title, ...s.facts.map((f) => `${f.text}${f.url ? ` (${site}${f.url})` : ""}`)]),
        briefing.gaps.length ? `Not included (source not active): ${briefing.gaps.map((g) => g.dataset).join("; ")}.` : null,
        briefing.interpretation.items.length ? "Interpretation (AI, not facts):" : null,
        ...briefing.interpretation.items.map((i) => `${i.text} [${i.refs.join(", ")}]`),
        "This is not an official warning. Follow official warnings and directions.",
    ].filter((l): l is string => !!l);
    const detail = await createObject(
        env.DB,
        user,
        space.id,
        {
            title: `${briefing.title} (${briefing.generatedAt.slice(0, 10)})`,
            content: { type: "doc", content: paragraphsFromText(lines.join("\n\n")) },
            tags: ["intelligence-centre", "briefing"],
        },
        { source: { system: "intelligence-centre-briefing", id: `${briefing.scope}:${briefing.watchId ?? "nsw"}:${briefing.generatedAt.slice(0, 13)}` } },
    );
    const linked = await relate(env, user, detail.object.id, input.relateTo);
    return { objectId: detail.object.id, url: `/portal/knowledge/o/${detail.object.id}`, linked };
}

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
        auditStatement(env.DB, { actor: user.email, action: "centre.event_link.create", entityType: "centre_event_link", entityId: id, summary: "Linked a calendar event to a watch area" }),
    ]);
    return listEventLinks(env, user);
}

export async function unlinkEvent(env: Env, user: PortalUser, id: string) {
    if (!/^ick_[a-z0-9]{14}$/.test(id)) throw new HttpError(404, "not_found", "Not found");
    const result = await env.DB.prepare("DELETE FROM ic_event_links WHERE id = ? AND email = ?").bind(id, user.email).run();
    if (!result.meta.changes) throw new HttpError(404, "not_found", "Not found");
    await auditStatement(env.DB, { actor: user.email, action: "centre.event_link.delete", entityType: "centre_event_link", entityId: id, summary: "Unlinked a calendar event" }).run();
}

export async function listEventLinks(env: Env, user: PortalUser): Promise<EventLink[]> {
    const rows = (
        await env.DB.prepare("SELECT l.id, l.event_id, l.watch_id, w.name AS watch_name FROM ic_event_links l JOIN ic_watch_areas w ON w.id = l.watch_id AND w.email = l.email WHERE l.email = ? ORDER BY l.created_at")
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
        await env.DB.prepare("SELECT l.event_id, l.watch_id FROM ic_event_links l WHERE l.email = ? LIMIT 50").bind(user.email).all<{ event_id: string; watch_id: string }>()
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
        const matches = (await recordsForWatch(env.DB, { ...watch, categories: [] }, 200)).filter(
            ({ record }) => (record.kind === "warning" || record.kind === "incident") ? record.severityRank >= 1 : record.kind === "disruption" && record.attributes.closure === "yes",
        ).length;
        out.push({ eventId: link.event_id, title: next.title, start: next.start, watchName: watch.name, matches, url: `/portal/intelligence-centre/records?watch=${watch.id}` });
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
                  .map((c) => ({ id: c.id, label: `${feedLabel(c)} · ${watched.get(c.recordId!)}`, summary: c.summary, at: c.at, url: `/portal/intelligence-centre/records/${c.recordId}` }))
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
