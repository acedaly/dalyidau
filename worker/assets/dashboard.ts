// What needs attention, the Overview, Today's section, the Chief of Staff's facts and Calendar's
// reminder overlay: all from one snapshot of the records the caller can see, through the same
// access rules as everywhere else.
//
// Every sentence comes from a record's own name and date ("Cub Camper Frontier registration is due
// in 21 days."). Nothing is estimated: a schedule with no
// interval or no starting point is "unknown", an asset with no recorded value is counted as
// unvalued (never as zero), and something nobody recorded simply isn't mentioned.
import type { D1Database } from "@cloudflare/workers-types";
import { dateSentence, daysFrom, maintenanceSentence } from "../../src/shared/assets/engine";
import {
    type AssetSummary,
    type AssetsOverview,
    type AttentionItem,
    type CategoryCount,
    GONE_STATUSES,
    type LocationView,
    type MaintenanceView,
    type PolicyView,
    type ScheduleView,
    type TodayAssets,
    type WarrantyView,
} from "../../src/shared/assets/types";
import { addDays } from "../../src/shared/calendar/time";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { can } from "../portal/auth";
import { ACCESS_FROM } from "./access";
import { type ViewContext, listAssets, viewContext } from "./assets";
import { listPolicies } from "./insurance";
import { listLocations } from "./locations";
import { listMaintenance, listSchedules, targetsFor } from "./maintenance";
import { listNotifications } from "./notify";
import { listWarranties } from "./warranties";

export interface Snapshot {
    ctx: ViewContext;
    assets: AssetSummary[];
    vehicles: Map<string, { registrationExpiry: string | null; roadsideExpiry: string | null; inspectionDue: string | null }>;
    locations: LocationView[];
    policies: PolicyView[];
    warranties: WarrantyView[];
    schedules: ScheduleView[];
    open: MaintenanceView[];
}

export async function snapshot(db: D1Database, user: PortalUser): Promise<Snapshot> {
    const ctx = await viewContext(db, user);
    const targets = await targetsFor(db, user);
    const [{ assets }, vehicleRows, locations, policies, warranties, schedules, open] = await Promise.all([
        listAssets(db, user, ctx),
        db
            .prepare(
                `SELECT v.asset_id, v.registration_expiry, v.roadside_expiry, v.inspection_due FROM asset_vehicles v WHERE v.asset_id IN (SELECT a.id ${ACCESS_FROM})`,
            )
            .bind(user.email)
            .all<{ asset_id: string; registration_expiry: string | null; roadside_expiry: string | null; inspection_due: string | null }>(),
        listLocations(db, user),
        listPolicies(db, user),
        listWarranties(db, user),
        listSchedules(db, user, {}, targets),
        listMaintenance(db, user, { scope: "open" }, targets),
    ]);
    return {
        ctx,
        assets,
        vehicles: new Map(
            vehicleRows.results.map((v) => [
                v.asset_id,
                { registrationExpiry: v.registration_expiry, roadsideExpiry: v.roadside_expiry, inspectionDue: v.inspection_due },
            ]),
        ),
        locations,
        policies,
        warranties,
        schedules,
        open,
    };
}

const isCurrent = (a: AssetSummary) => !GONE_STATUSES.includes(a.status);

/** Known value below the person's low-value threshold (unknown values are never left out). */
export const isLowValue = (a: AssetSummary, thresholdCents: number) => {
    if (!thresholdCents) return false;
    const known = a.currentValue?.amountCents ?? a.purchasePriceCents;
    return known !== null && known !== undefined && known < thresholdCents;
};

// --- Attention -----------------------------------------------------------------------------------

/**
 * Everything due within `horizonDays` (and anything overdue), soonest first. Distance-based
 * maintenance with no date is included once it's due soon or overdue by the odometer.
 */
export function attention(s: Snapshot, horizonDays: number): AttentionItem[] {
    const { today } = s.ctx;
    const end = addDays(today, horizonDays);
    const items: AttentionItem[] = [];
    const current = new Map(s.assets.filter(isCurrent).map((a) => [a.id, a]));
    const push = (item: AttentionItem) => items.push(item);
    const inWindow = (date: string | null) => !!date && date <= end;
    const stateOf = (date: string): AttentionItem["state"] =>
        date < today ? "overdue" : date <= addDays(today, s.ctx.prefs.dueSoonDays) ? "due_soon" : "upcoming";

    // Maintenance: open records, then schedules that have no open record yet.
    const scheduled = new Set(s.open.map((m) => m.scheduleId).filter(Boolean));
    for (const m of s.open) {
        if (m.assetId && !current.has(m.assetId)) continue;
        const repair = m.kind === "corrective" || m.kind === "repair";
        const km = m.assetId ? current.get(m.assetId)?.vehicle : null;
        const remaining = m.dueKm !== null && km?.odometer !== null && km?.odometer !== undefined ? m.dueKm - km.odometer : null;
        const byDistance = m.state === "overdue" || m.state === "due_soon";
        if (!inWindow(m.dueOn) && !byDistance && !(repair && (m.priority === "high" || m.priority === "urgent"))) continue;
        const days = m.dueOn ? daysFrom(today, m.dueOn) : null;
        push({
            key: `maintenance:${m.id}`,
            kind: repair ? "repair" : "maintenance",
            state: m.state === "overdue" ? "overdue" : m.state === "due_soon" ? "due_soon" : m.dueOn ? stateOf(m.dueOn) : "due_soon",
            date: m.dueOn,
            daysAway: days,
            sentence:
                repair && days === null
                    ? `${m.targetName}: ${m.title} is an open ${m.priority === "urgent" ? "urgent " : ""}repair.`
                    : maintenanceSentence(m.title, m.targetName, days, remaining, km?.odometerUnit),
            title: m.title,
            targetName: m.targetName,
            url: m.assetId ? `/portal/assets/item/${m.assetId}?tab=maintenance` : `/portal/assets/property/${m.locationId}`,
            assetId: m.assetId,
            refId: m.id,
        });
    }
    for (const sc of s.schedules) {
        if (!sc.active || scheduled.has(sc.id)) continue;
        if (sc.assetId && !current.has(sc.assetId)) continue;
        const byDistance = sc.state === "overdue" || sc.state === "due_soon";
        if (!inWindow(sc.nextDueOn) && !byDistance) continue;
        const days = sc.nextDueOn ? daysFrom(today, sc.nextDueOn) : null;
        const unit = sc.assetId ? current.get(sc.assetId)?.vehicle?.odometerUnit : undefined;
        push({
            key: `schedule:${sc.id}`,
            kind: "maintenance",
            state: sc.state === "overdue" ? "overdue" : sc.state === "due_soon" ? "due_soon" : sc.nextDueOn ? stateOf(sc.nextDueOn) : "due_soon",
            date: sc.nextDueOn,
            daysAway: days,
            sentence: maintenanceSentence(sc.title, sc.targetName, days, sc.remainingKm, unit),
            title: sc.title,
            targetName: sc.targetName,
            url: sc.assetId ? `/portal/assets/item/${sc.assetId}?tab=maintenance` : `/portal/assets/property/${sc.locationId}`,
            assetId: sc.assetId,
            refId: sc.id,
        });
    }

    // Vehicle dates.
    for (const [assetId, v] of s.vehicles) {
        const a = current.get(assetId);
        if (!a) continue;
        for (const [kind, date] of [
            ["registration", v.registrationExpiry],
            ["roadside", v.roadsideExpiry],
            ["inspection", v.inspectionDue],
        ] as const) {
            if (!date || !inWindow(date) || date < addDays(today, -60)) continue;
            const days = daysFrom(today, date);
            push({
                key: `${kind}:${assetId}:${date}`,
                kind,
                state: stateOf(date),
                date,
                daysAway: days,
                sentence: dateSentence(kind, a.name, days),
                title: kind,
                targetName: a.name,
                url: `/portal/assets/item/${assetId}`,
                assetId,
                refId: assetId,
            });
        }
    }

    // Places: inspections and leases.
    for (const l of s.locations) {
        if (l.archived) continue;
        for (const [kind, date] of [
            ["inspection", l.nextInspectionOn],
            ["lease", l.leaseEnd],
        ] as const) {
            if (!date || !inWindow(date) || date < addDays(today, -60)) continue;
            const days = daysFrom(today, date);
            push({
                key: `${kind}:${l.id}:${date}`,
                kind,
                state: stateOf(date),
                date,
                daysAway: days,
                sentence: dateSentence(kind, l.name, days),
                title: kind,
                targetName: l.name,
                url: `/portal/assets/property/${l.id}`,
                assetId: null,
                refId: l.id,
            });
        }
    }

    // Insurance renewals of active policies the caller can see.
    for (const p of s.policies) {
        if (p.status !== "active" || !p.renewsOn || !inWindow(p.renewsOn) || p.renewsOn < addDays(today, -60)) continue;
        const days = daysFrom(today, p.renewsOn);
        const name = p.name ?? `${p.provider} policy`;
        push({
            key: `insurance:${p.id}:${p.renewsOn}`,
            kind: "insurance",
            state: stateOf(p.renewsOn),
            date: p.renewsOn,
            daysAway: days,
            sentence: dateSentence("insurance", name, days),
            title: name,
            targetName: name,
            url: `/portal/assets/insurance?policy=${p.id}`,
            assetId: null,
            refId: p.id,
        });
    }

    // Warranties ending (not ones already ended).
    for (const w of s.warranties) {
        if (!w.expiresOn || w.expiresOn < today || !inWindow(w.expiresOn) || !current.has(w.assetId)) continue;
        const days = daysFrom(today, w.expiresOn);
        push({
            key: `warranty:${w.id}:${w.expiresOn}`,
            kind: "warranty",
            state: stateOf(w.expiresOn),
            date: w.expiresOn,
            daysAway: days,
            sentence: dateSentence("warranty", w.assetName, days),
            title: w.assetName,
            targetName: w.assetName,
            url: `/portal/assets/item/${w.assetId}?tab=cover`,
            assetId: w.assetId,
            refId: w.id,
        });
    }

    const order = { overdue: 0, due_soon: 1, upcoming: 2 };
    return items.sort((a, b) => order[a.state] - order[b.state] || (a.date ?? "0000").localeCompare(b.date ?? "0000"));
}

// --- Overview ------------------------------------------------------------------------------------

export async function overview(env: Env, db: D1Database, user: PortalUser): Promise<AssetsOverview> {
    const s = await snapshot(db, user);
    const { today, timeZone, prefs } = s.ctx;
    const current = s.assets.filter(isCurrent);
    const counted = current.filter((a) => !isLowValue(a, prefs.lowValueCents));
    const financial = counted.filter((a) => !a.financialHidden);
    const sum = (values: (number | null | undefined)[]) => {
        const known = values.filter((v): v is number => typeof v === "number");
        return known.length ? known.reduce((n, v) => n + v, 0) : null;
    };
    const byCategory = new Map<string, CategoryCount>();
    for (const a of counted) {
        const c = byCategory.get(a.category) ?? { category: a.category, label: a.categoryLabel, count: 0, valueCents: null, withoutValue: 0 };
        c.count++;
        if (!a.financialHidden) {
            if (a.currentValue) c.valueCents = (c.valueCents ?? 0) + a.currentValue.amountCents;
            else c.withoutValue++;
        }
        byCategory.set(a.category, c);
    }
    const all = attention(s, 90);
    const within = (days: number) => all.filter((i) => i.state === "overdue" || (i.date !== null && i.date <= addDays(today, days)) || i.date === null).length;
    const repairs = await listMaintenance(db, user, { scope: "history", limit: 50 });
    return {
        today,
        timeZone,
        totals: {
            assets: current.length,
            vehicles: current.filter((a) => a.vehicle).length,
            locations: s.locations.length,
            policies: s.policies.filter((p) => p.status === "active").length,
            valueCents: sum(financial.map((a) => a.currentValue?.amountCents)),
            valued: financial.filter((a) => a.currentValue).length,
            unvalued: financial.filter((a) => !a.currentValue).length,
            replacementCents: sum(financial.map((a) => a.replacementValue?.amountCents)),
            purchaseCents: sum(financial.map((a) => a.purchasePriceCents)),
            financialHidden: counted.filter((a) => a.financialHidden).length,
        },
        byCategory: [...byCategory.values()].sort((a, b) => b.count - a.count),
        attention: all.slice(0, 30),
        horizon: { days30: within(30), days60: within(60), days90: within(90) },
        overdue: all.filter((i) => i.state === "overdue"),
        recentRepairs: repairs
            .filter((m) => m.status === "completed" && (m.kind === "repair" || m.kind === "corrective" || m.category === "repair"))
            .slice(0, 5),
        recentPurchases: current
            .filter((a) => a.purchaseDate && a.purchaseDate >= addDays(today, -180))
            .sort((a, b) => (b.purchaseDate ?? "").localeCompare(a.purchaseDate ?? ""))
            .slice(0, 5),
        needsDocuments: counted.filter((a) => a.needsDocuments && (a.needsDocuments.proof || a.needsDocuments.photo)).slice(0, 8),
        notifications: await listNotifications(env, db, user, s),
    };
}

// --- Today and the Chief of Staff ----------------------------------------------------------------

/** Today's Home & Assets section, from the person's own settings. Null when they switched it off or can't use it. */
export async function todayAssets(db: D1Database, user: PortalUser): Promise<TodayAssets | null> {
    if (!can(user, "assets.use")) return null;
    const s = await snapshot(db, user);
    const t = s.ctx.prefs.today;
    if (!t.enabled) return null;
    const items = attention(s, t.horizonDays);
    return { items: items.slice(0, t.maxItems), total: items.length, horizonDays: t.horizonDays };
}

/** Facts for the Chief of Staff (deterministic, every one with a link). Null without access or when the person left it out. */
export async function briefingFacts(db: D1Database, user: PortalUser, horizonDays = 30) {
    if (!can(user, "assets.use")) return null;
    const s = await snapshot(db, user);
    if (!s.ctx.prefs.briefing.include) return null;
    const items = attention(s, horizonDays);
    return {
        today: s.ctx.today,
        horizonDays,
        overdue: items.filter((i) => i.state === "overdue"),
        dueSoon: items.filter((i) => i.state !== "overdue"),
        notChecked: ["manufacturer recommendations", "insurers' or registries' own records", "anything not recorded in Home & Assets"],
    };
}

// --- Calendar overlay ----------------------------------------------------------------------------

export interface AssetOverlay {
    id: string;
    date: string;
    title: string;
    kind: AttentionItem["kind"] | "booked";
    url: string;
}

const OVERLAY_LABELS: Record<Exclude<AttentionItem["kind"], "maintenance" | "repair">, string> = {
    registration: "Registration due",
    roadside: "Roadside assistance renews",
    inspection: "Inspection due",
    lease: "Lease ends",
    insurance: "Insurance renews",
    warranty: "Warranty ends",
};

/** Asset dates in a window, for Calendar's reminder overlay (they're reminders, not events). */
export async function assetOverlays(db: D1Database, user: PortalUser, from: string, to: string): Promise<AssetOverlay[]> {
    if (!can(user, "assets.use")) return [];
    const s = await snapshot(db, user);
    const out: AssetOverlay[] = [];
    const span = Math.max(0, daysFrom(s.ctx.today, to));
    for (const item of attention(s, span + 1)) {
        if (!item.date || item.date < from || item.date > to) continue;
        const title =
            item.kind === "maintenance" || item.kind === "repair" ? `${item.title} (${item.targetName})` : `${OVERLAY_LABELS[item.kind]}: ${item.targetName}`;
        out.push({ id: item.key, date: item.date, title, kind: item.kind, url: item.url });
    }
    // Booked work without its own Calendar appointment.
    for (const m of s.open)
        if (m.scheduledOn && !m.calendarEventId && m.scheduledOn >= from && m.scheduledOn <= to)
            out.push({
                id: `booked:${m.id}`,
                date: m.scheduledOn,
                title: `Booked: ${m.title}`,
                kind: "booked",
                url: m.assetId ? `/portal/assets/item/${m.assetId}?tab=maintenance` : `/portal/assets/property/${m.locationId}`,
            });
    return out.slice(0, 300);
}
