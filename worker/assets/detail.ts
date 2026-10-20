// One asset in full, as the caller may see it: everything from the summary, plus vehicle details,
// odometer history, values (with the financial right), warranties, insurance (with the insurance
// right), claims, schedules and maintenance, photos and documents (documents with the right),
// Knowledge links, linked tasks, sharing (owner only) and its history.
import type { D1Database } from "@cloudflare/workers-types";
import { formulaValue } from "../../src/shared/assets/engine";
import { type AssetActivityView, type AssetDetail, depreciationSchema } from "../../src/shared/assets/types";
import type { PortalUser } from "../../src/shared/portal/types";
import { parseJson } from "../portal/db";
import { requireAsset } from "./access";
import { odometerFor, sharingFor, summarise, valuationsFor, vehicleFor, viewContext } from "./assets";
import { filesForAsset } from "./files";
import { policiesForAsset } from "./insurance";
import { knowledgeLinks, tasksForAsset } from "./links";
import { listMaintenance, listSchedules, targetsFor } from "./maintenance";
import { listClaims, listWarranties } from "./warranties";

export async function assetDetail(db: D1Database, user: PortalUser, id: string): Promise<AssetDetail> {
    const { row, rights } = await requireAsset(db, user, id);
    const ctx = await viewContext(db, user);
    const targets = await targetsFor(db, user);
    const [[summary], vehicle, odometer, valuations, warranties, policies, claims, schedules, maintenance, files, knowledge, tasks, sharing, activity, totals] =
        await Promise.all([
            summarise(db, ctx, [row]),
            vehicleFor(db, id),
            odometerFor(db, id),
            rights.financial ? valuationsFor(db, id) : Promise.resolve(null),
            listWarranties(db, user, id),
            rights.insurance ? policiesForAsset(db, user, id) : Promise.resolve(null),
            listClaims(db, user, { assetId: id }),
            listSchedules(db, user, { assetId: id }, targets),
            listMaintenance(db, user, { assetId: id, scope: "all", limit: 300 }, targets),
            filesForAsset(db, user, id),
            knowledgeLinks(db, user, id),
            tasksForAsset(db, user, id),
            rights.manage ? sharingFor(db, id, row.visibility) : Promise.resolve(null),
            db
                .prepare("SELECT at, actor, action, entity_type, via FROM asset_activity WHERE asset_id = ? ORDER BY id DESC LIMIT 40")
                .bind(id)
                .all<{ at: string; actor: string; action: string; entity_type: string; via: AssetActivityView["via"] }>(),
            rights.financial
                ? db
                      .prepare(
                          "SELECT COALESCE(SUM(cost_cents), 0) AS total, COUNT(*) AS n, SUM(CASE WHEN cost_cents IS NULL THEN 1 ELSE 0 END) AS missing, SUM(CASE WHEN cost_cents IS NOT NULL THEN 1 ELSE 0 END) AS known FROM asset_maintenance WHERE asset_id = ? AND status = 'completed'",
                      )
                      .bind(id)
                      .first<{ total: number; n: number; missing: number | null; known: number | null }>()
                : Promise.resolve(null),
        ]);
    const category = ctx.categories.get(row.category);
    const depreciation = rights.financial ? depreciationSchema.catch({ method: "none" }).parse(parseJson(row.depreciation, { method: "none" })) : null;
    return {
        asset: {
            ...summary,
            description: row.description,
            notes: row.notes,
            purchaseLocation: row.purchase_location,
            custom: parseJson(row.custom, {}),
            customFields: category?.fields ?? [],
            depreciation,
            formulaValue: rights.financial ? formulaValue(depreciation, row.purchase_price_cents, row.purchase_date, ctx.today) : null,
            disposal: {
                on: row.disposed_on,
                method: row.disposal_method as AssetDetail["asset"]["disposal"]["method"],
                amountCents: rights.financial ? row.disposal_amount_cents : null,
                notes: row.disposal_notes,
            },
            labelVersion: row.label_version,
            createdAt: row.created_at,
            createdBy: row.created_by,
        },
        vehicle,
        odometer,
        valuations,
        warranties,
        policies,
        claims,
        schedules,
        maintenance,
        files: files.files,
        documentsHidden: files.hidden,
        knowledge,
        tasks,
        sharing,
        activity: activity.results.map((a) => ({ at: a.at, actor: a.actor, action: a.action, entityType: a.entity_type, via: a.via })),
        totals: totals ? { maintenanceCostCents: totals.known ? totals.total : null, maintenanceRecords: totals.n, costsMissing: totals.missing ?? 0 } : null,
    };
}
