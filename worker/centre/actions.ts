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
import { ensurePersonalSpace, listSpaces } from "../knowledge/access";
import { createObject } from "../knowledge/objects";
import { can } from "../portal/auth";
import { HttpError } from "../portal/http";
import { createTask } from "../tasks/tasks";
import { listAlerts } from "./alerts";
import { getRecord, listRecords, loadPreferences } from "./store";
import { listWatches, recordsForWatch } from "./watch";

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
    })
    .strict();

async function writableSpace(env: Env, user: PortalUser, spaceId?: string) {
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
    const space = await writableSpace(env, user, knowledgeInput.parse(body ?? {}).spaceId);
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
    return { objectId: detail.object.id, url: `/portal/knowledge/o/${detail.object.id}` };
}

export async function knowledgeFromBriefing(env: Env, user: PortalUser, briefing: CentreBriefing, body: unknown) {
    const space = await writableSpace(env, user, knowledgeInput.parse(body ?? {}).spaceId);
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
    return { objectId: detail.object.id, url: `/portal/knowledge/o/${detail.object.id}` };
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
    for (const watch of watches.slice(0, 10)) {
        for (const { record, reason } of await recordsForWatch(env.DB, watch, 100)) {
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
    return {
        items: [...items.values()].sort((a, b) => b.rank - a.rank).slice(0, 6),
        alerts,
        watches: watches.length,
        staleNote: stale?.n ? `${stale.n} ${stale.n === 1 ? "source isn't" : "sources aren't"} being retrieved, so this may be incomplete.` : null,
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
