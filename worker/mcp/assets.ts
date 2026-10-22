// Home & Assets tools for the MCP gateway (docs/HOME_ASSETS.md#mcp).
//
// Every tool calls the same functions as the portal's own API (worker/assets/*), so an assistant
// sees exactly what the person sees: only assets they own or that are shared with them, values and
// costs only where those are shared, insurance only where that is, documents as metadata only (never
// file contents, never R2). Writes go through the ledger (audit and retry safety) and the same
// permission checks: creating and updating assets, and adding and completing maintenance. There's
// no delete, sharing, upload or bulk tool.
import { z } from "zod";
import { CATEGORY_ID } from "../../src/shared/assets/categories";
import { EMPTY_FILTERS, applyFilters } from "../../src/shared/assets/filters";
import {
    ASSET_STATUSES,
    type AssetSummary,
    COVERAGE_LABELS,
    FILE_KIND_LABELS,
    MAINTENANCE_CATEGORIES,
    MAINTENANCE_KINDS,
    type MaintenanceView,
    PRIORITIES,
    VALUE_BASIS_LABELS,
} from "../../src/shared/assets/types";
import { assetSummary, createAsset, listAssets, updateAsset, viewContext } from "../assets/assets";
import { attention, isLowValue, snapshot } from "../assets/dashboard";
import { assetDetail } from "../assets/detail";
import { filesForAsset } from "../assets/files";
import { completeMaintenance, createMaintenance, listMaintenance, maintenanceView } from "../assets/maintenance";
import { searchAll } from "../assets/search";
import { type ToolContext, bounded, calendarDate, id, limit, portalUrl, requestId, tool } from "./shared";

const PERMISSION = "assets.use" as const;
const assetId = id("ast", "asset");
const locationId = id("alo", "place");
const maintenanceId = id("amr", "maintenance record");
const money = (cents: number | null | undefined) => (cents === null || cents === undefined ? null : Math.round(cents) / 100);

export const ASSETS_NOTE =
    "Home & Assets records what the household entered. Report values, dates and intervals as given; never estimate a value, a service interval or a date that isn't recorded. 'Linked to a verified policy' is not a statement that something is insured.";

const assetOut = (ctx: ToolContext, a: AssetSummary) => ({
    id: a.id,
    name: a.name,
    category: a.categoryLabel,
    manufacturer: a.manufacturer,
    brand: a.brand,
    model: a.model,
    serialNumber: a.serialNumber,
    status: a.status,
    condition: a.condition,
    location: a.locationHidden ? "not shared with you" : (a.location?.name ?? null),
    owner: a.mine ? "you" : (a.owner.name ?? a.owner.email),
    visibility: a.visibility,
    purchaseDate: a.purchaseDate,
    ...(a.financialHidden
        ? { financialValues: "not shared with you" }
        : {
              purchasePriceAud: money(a.purchasePriceCents),
              currentValue: a.currentValue
                  ? { aud: money(a.currentValue.amountCents), basis: VALUE_BASIS_LABELS[a.currentValue.basis], valuedOn: a.currentValue.valuedOn }
                  : null,
              replacementValue: a.replacementValue ? { aud: money(a.replacementValue.amountCents), basis: VALUE_BASIS_LABELS[a.replacementValue.basis] } : null,
          }),
    vehicle: a.vehicle,
    warranty: a.warranty,
    insurance: COVERAGE_LABELS[a.coverage],
    maintenance: a.maintenance,
    tags: a.tags,
    canEdit: a.rights.edit,
    canRecordMaintenance: a.rights.maintain,
    version: a.version,
    url: portalUrl(ctx, `/portal/assets/item/${a.id}`),
});

const maintenanceOut = (ctx: ToolContext, m: MaintenanceView) => ({
    id: m.id,
    for: m.targetName,
    assetId: m.assetId,
    locationId: m.locationId,
    title: m.title,
    kind: m.kind,
    category: m.category,
    priority: m.priority,
    status: m.status,
    state: m.state,
    dueOn: m.dueOn,
    dueKm: m.dueKm,
    scheduledOn: m.scheduledOn,
    completedOn: m.completedOn,
    odometer: m.odometer,
    ...(m.costHidden ? { cost: "not shared with you" } : { costAud: money(m.costCents) }),
    provider: m.provider,
    responsibility: m.responsibility,
    fromSchedule: !!m.scheduleId,
    version: m.version,
    url: portalUrl(ctx, m.assetId ? `/portal/assets/item/${m.assetId}?tab=maintenance` : `/portal/assets/property/${m.locationId}`),
});

const respond = (data: Record<string, unknown>) => ({ data: { ...data, note: ASSETS_NOTE } });

const days = z.number().int().min(1).max(365).default(30);

const attentionOf = async (ctx: ToolContext, horizon: number, kinds?: string[]) => {
    const s = await snapshot(ctx.db, ctx.user);
    const items = attention(s, horizon).filter((i) => !kinds || kinds.includes(i.kind));
    return {
        today: s.ctx.today,
        items: items.map((i) => ({
            kind: i.kind,
            state: i.state,
            date: i.date,
            daysAway: i.daysAway,
            fact: i.sentence,
            url: portalUrl(ctx, i.url),
        })),
    };
};

const assetFields = {
    manufacturer: z.string().trim().max(120).nullable().optional(),
    brand: z.string().trim().max(120).nullable().optional(),
    model: z.string().trim().max(120).nullable().optional(),
    serialNumber: z.string().trim().max(120).nullable().optional(),
    description: z.string().trim().max(4000).nullable().optional(),
    purchaseDate: calendarDate.nullable().optional(),
    purchasePriceCents: z.number().int().min(0).max(100_000_000_000).nullable().optional(),
    purchaseLocation: z.string().trim().max(200).nullable().optional(),
    locationId: locationId.nullable().optional(),
    status: z.enum(ASSET_STATUSES).optional(),
    notes: z.string().trim().max(8000).nullable().optional(),
    tags: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(20).optional(),
};

export const ASSETS_TOOLS = [
    tool({
        name: "assets_search",
        write: false,
        permission: PERMISSION,
        input: z.object({ query: z.string().trim().min(2).max(100), limit: limit(20, 50) }).strict(),
        run: async (ctx, input) => {
            const r = await searchAll(ctx.db, ctx.user, input.query);
            const assets = bounded(r.assets, input.limit);
            return respond({
                assets: assets.items.map((a) => assetOut(ctx, a)),
                count: assets.count,
                truncated: assets.truncated,
                maintenance: r.maintenance.slice(0, input.limit).map((m) => maintenanceOut(ctx, m)),
                documents: r.files
                    .slice(0, input.limit)
                    .map((f) => ({ id: f.id, kind: FILE_KIND_LABELS[f.kind], name: f.filename, caption: f.caption, asset: f.assetName })),
                places: r.locations.slice(0, 10).map((l) => ({ id: l.id, name: l.name, kind: l.kind })),
            });
        },
    }),
    tool({
        name: "assets_list",
        write: false,
        permission: PERMISSION,
        input: z
            .object({
                category: z.string().regex(CATEGORY_ID).optional(),
                group: z.enum(["vehicles", "home", "equipment", "personal", "other"]).optional(),
                locationId: locationId.optional(),
                status: z.enum(["current", "gone", ...ASSET_STATUSES]).optional(),
                warranty: z.enum(["active", "expiring", "expired", "unknown", "none"]).optional(),
                maintenance: z.enum(["overdue", "due_soon", "none"]).optional(),
                limit: limit(50, 200),
            })
            .strict(),
        run: async (ctx, input) => {
            const { assets } = await listAssets(ctx.db, ctx.user);
            const filtered = applyFilters(assets, {
                ...EMPTY_FILTERS,
                category: input.category ?? null,
                group: input.group ?? null,
                locationId: input.locationId ?? null,
                status: input.status ?? "current",
                warranty: input.warranty ?? null,
                maintenance: input.maintenance ?? null,
            });
            const cut = bounded(filtered, input.limit);
            return respond({ assets: cut.items.map((a) => assetOut(ctx, a)), count: cut.count, truncated: cut.truncated });
        },
    }),
    tool({
        name: "assets_get",
        write: false,
        permission: PERMISSION,
        input: z.object({ assetId }).strict(),
        run: async (ctx, input) => {
            const d = await assetDetail(ctx.db, ctx.user, input.assetId);
            return respond({
                asset: {
                    ...assetOut(ctx, d.asset),
                    description: d.asset.description,
                    notes: d.asset.notes,
                    custom: d.asset.custom,
                    labelVersion: d.asset.labelVersion,
                },
                vehicle: d.vehicle,
                warranties: d.warranties.map((w) => ({
                    id: w.id,
                    kind: w.kind,
                    provider: w.provider,
                    expiresOn: w.expiresOn,
                    endDateIs: w.expiresBasis,
                    state: w.state,
                })),
                policies:
                    d.policies?.map((p) => ({
                        id: p.id,
                        provider: p.provider,
                        type: p.policyType,
                        renewsOn: p.renewsOn,
                        status: p.status,
                        verified: !!p.verified,
                    })) ?? "insurance not shared with you",
                schedules: d.schedules.map((s) => ({
                    id: s.id,
                    title: s.title,
                    every: s.intervalCount ? `${s.intervalCount} ${s.intervalUnit}` : null,
                    everyKm: s.intervalKm,
                    lastDoneOn: s.lastDoneOn,
                    nextDueOn: s.nextDueOn,
                    nextDueKm: s.nextDueKm,
                    state: s.state,
                    unknownReason: s.unknownReason,
                })),
                openMaintenance: d.maintenance.filter((m) => !["completed", "cancelled"].includes(m.status)).map((m) => maintenanceOut(ctx, m)),
                documents: d.files.map((f) => ({
                    id: f.id,
                    kind: FILE_KIND_LABELS[f.kind],
                    name: f.filename,
                    caption: f.caption,
                    addedOn: f.createdAt.slice(0, 10),
                })),
                documentsNotShared: d.documentsHidden,
            });
        },
    }),
    tool({
        name: "assets_maintenance_history",
        write: false,
        permission: PERMISSION,
        input: z.object({ assetId: assetId.optional(), locationId: locationId.optional(), limit: limit(30, 200) }).strict(),
        run: async (ctx, input) => {
            const records = await listMaintenance(ctx.db, ctx.user, { assetId: input.assetId, locationId: input.locationId, scope: "history", limit: 500 });
            if (input.assetId) await assetSummary(ctx.db, ctx.user, input.assetId);
            const cut = bounded(records, input.limit);
            return respond({ records: cut.items.map((m) => maintenanceOut(ctx, m)), count: cut.count, truncated: cut.truncated });
        },
    }),
    tool({
        name: "assets_upcoming_maintenance",
        write: false,
        permission: PERMISSION,
        input: z.object({ days }).strict(),
        run: async (ctx, input) => respond({ ...(await attentionOf(ctx, input.days, ["maintenance", "repair"])), horizonDays: input.days }),
    }),
    tool({
        name: "assets_insurance_renewals",
        write: false,
        permission: PERMISSION,
        input: z.object({ days: z.number().int().min(1).max(365).default(60) }).strict(),
        run: async (ctx, input) => respond({ ...(await attentionOf(ctx, input.days, ["insurance"])), horizonDays: input.days }),
    }),
    tool({
        name: "assets_warranty_expiries",
        write: false,
        permission: PERMISSION,
        input: z.object({ days: z.number().int().min(1).max(365).default(90) }).strict(),
        run: async (ctx, input) => ({
            data: {
                ...(await attentionOf(ctx, input.days, ["warranty"])),
                horizonDays: input.days,
                note: `${ASSETS_NOTE} A manufacturer's warranty ending doesn't end Australian Consumer Law guarantees.`,
            },
        }),
    }),
    tool({
        name: "assets_list_documents",
        write: false,
        permission: PERMISSION,
        input: z.object({ assetId }).strict(),
        run: async (ctx, input) => {
            const { files, hidden } = await filesForAsset(ctx.db, ctx.user, input.assetId);
            return respond({
                documents: files.map((f) => ({
                    id: f.id,
                    kind: FILE_KIND_LABELS[f.kind],
                    name: f.filename,
                    caption: f.caption,
                    type: f.contentType,
                    bytes: f.bytes,
                    addedOn: f.createdAt.slice(0, 10),
                })),
                notSharedWithYou: hidden,
                howToOpen: "Files open only in the portal, signed in. Their contents aren't available through this connector.",
                url: portalUrl(ctx, `/portal/assets/item/${input.assetId}?tab=documents`),
            });
        },
    }),
    tool({
        name: "assets_summary",
        write: false,
        permission: PERMISSION,
        input: z.object({ includeLowValue: z.boolean().default(false) }).strict(),
        run: async (ctx, input) => {
            const view = await viewContext(ctx.db, ctx.user);
            const { assets } = await listAssets(ctx.db, ctx.user, view);
            const current = assets.filter(
                (a) => !["sold", "disposed", "gifted"].includes(a.status) && (input.includeLowValue || !isLowValue(a, view.prefs.lowValueCents)),
            );
            const shared = current.filter((a) => !a.financialHidden);
            const valued = shared.filter((a) => a.currentValue);
            const byCategory = new Map<string, number>();
            for (const a of current) byCategory.set(a.categoryLabel, (byCategory.get(a.categoryLabel) ?? 0) + 1);
            return respond({
                assets: current.length,
                vehicles: current.filter((a) => a.vehicle).length,
                byCategory: Object.fromEntries(byCategory),
                recordedCurrentValueAud: valued.length ? money(valued.reduce((n, a) => n + a.currentValue!.amountCents, 0)) : null,
                withAValue: valued.length,
                withoutAValue: shared.length - valued.length,
                valuesNotSharedWithYou: current.length - shared.length,
                needingDocuments: current.filter((a) => a.needsDocuments?.proof).length,
                overdueMaintenance: current.reduce((n, a) => n + a.maintenance.overdue, 0),
                url: portalUrl(ctx, "/portal/assets"),
            });
        },
    }),
    tool({
        name: "assets_get_attention",
        write: false,
        permission: PERMISSION,
        input: z.object({ days }).strict(),
        run: async (ctx, input) => respond({ ...(await attentionOf(ctx, input.days)), horizonDays: input.days }),
    }),

    // --- Writes ----------------------------------------------------------------------------------
    tool({
        name: "assets_create",
        write: true,
        permission: PERMISSION,
        input: z.object({ name: z.string().trim().min(1).max(200), category: z.string().regex(CATEGORY_ID), ...assetFields, requestId }).strict(),
        run: async (ctx, input) => {
            const { requestId: _r, ...fields } = input;
            const { asset, replayed } = await createAsset(ctx.db, ctx.user, fields, "mcp");
            return { data: { asset: assetOut(ctx, asset), replayed }, outcome: { entityType: "asset", entityId: asset.id } };
        },
        replay: async (ctx, outcome) => ({ data: { asset: assetOut(ctx, await assetSummary(ctx.db, ctx.user, outcome.entityId)), replayed: true } }),
    }),
    tool({
        name: "assets_update",
        write: true,
        permission: PERMISSION,
        input: z
            .object({
                assetId,
                version: z.number().int().min(1),
                name: z.string().trim().min(1).max(200).optional(),
                category: z.string().regex(CATEGORY_ID).optional(),
                ...assetFields,
                requestId,
            })
            .strict(),
        run: async (ctx, input) => {
            const { assetId: target, requestId: _r, ...fields } = input;
            const asset = await updateAsset(ctx.db, ctx.user, target, fields, "mcp");
            return { data: { asset: assetOut(ctx, asset) }, outcome: { entityType: "asset", entityId: asset.id } };
        },
        replay: async (ctx, outcome) => ({ data: { asset: assetOut(ctx, await assetSummary(ctx.db, ctx.user, outcome.entityId)), replayed: true } }),
    }),
    tool({
        name: "assets_create_maintenance",
        write: true,
        permission: PERMISSION,
        input: z
            .object({
                assetId: assetId.optional(),
                locationId: locationId.optional(),
                title: z.string().trim().min(1).max(200),
                kind: z.enum(MAINTENANCE_KINDS).optional(),
                category: z.enum(MAINTENANCE_CATEGORIES).optional(),
                priority: z.enum(PRIORITIES).optional(),
                dueOn: calendarDate.nullable().optional(),
                dueKm: z.number().int().min(0).nullable().optional(),
                completedOn: calendarDate.nullable().optional(),
                odometer: z.number().int().min(0).nullable().optional(),
                costCents: z.number().int().min(0).max(100_000_000_000).nullable().optional(),
                provider: z.string().trim().max(200).nullable().optional(),
                notes: z.string().trim().max(8000).nullable().optional(),
                requestId,
            })
            .strict(),
        run: async (ctx, input) => {
            const { requestId: _r, ...fields } = input;
            const { record } = await createMaintenance(ctx.db, ctx.user, { ...fields, ...(fields.completedOn ? { status: "completed" } : {}) }, "mcp");
            return { data: { record: maintenanceOut(ctx, record) }, outcome: { entityType: "asset_maintenance", entityId: record.id } };
        },
        replay: async (ctx, outcome) => ({ data: { record: maintenanceOut(ctx, await maintenanceView(ctx.db, ctx.user, outcome.entityId)), replayed: true } }),
    }),
    tool({
        name: "assets_complete_maintenance",
        write: true,
        permission: PERMISSION,
        input: z
            .object({
                maintenanceId,
                completedOn: calendarDate,
                odometer: z.number().int().min(0).nullable().optional(),
                costCents: z.number().int().min(0).max(100_000_000_000).nullable().optional(),
                provider: z.string().trim().max(200).nullable().optional(),
                notes: z.string().trim().max(8000).nullable().optional(),
                requestId,
            })
            .strict(),
        run: async (ctx, input) => {
            const { maintenanceId: target, requestId: _r, ...fields } = input;
            const result = await completeMaintenance(ctx.db, ctx.user, target, fields, "mcp");
            return {
                data: {
                    record: maintenanceOut(ctx, result.record),
                    nextRecord: result.next ? maintenanceOut(ctx, result.next) : null,
                    alreadyDone: result.alreadyDone,
                },
                outcome: { entityType: "asset_maintenance", entityId: target },
            };
        },
        replay: async (ctx, outcome) => ({ data: { record: maintenanceOut(ctx, await maintenanceView(ctx.db, ctx.user, outcome.entityId)), replayed: true } }),
    }),
];
