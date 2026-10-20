// Reports and CSV exports. Each one is built from the same summaries and lists as the pages, so it
// contains only what the person can see: values and costs are "not shared" for assets whose
// financial values aren't shared with them, an unrecorded figure is blank (and counted), and no
// total is ever padded with an estimate. Every export is recorded in the history (without content).
import type { D1Database } from "@cloudflare/workers-types";
import { annualPremium } from "../../src/shared/assets/engine";
import {
    ASSET_STATUS_LABELS,
    type AssetSummary,
    CONDITION_LABELS,
    COVERAGE_LABELS,
    FREQUENCY_LABELS,
    GONE_STATUSES,
    MAINTENANCE_KIND_LABELS,
    MAINTENANCE_STATUS_LABELS,
    PAYMENTS_PER_YEAR,
    POLICY_TYPE_LABELS,
    type ReportName,
    VALUE_BASIS_LABELS,
    WARRANTY_KIND_LABELS,
} from "../../src/shared/assets/types";
import type { PortalUser } from "../../src/shared/portal/types";
import { type CsvColumn, toCsv } from "../portal/csv";
import { HttpError } from "../portal/http";
import { activity } from "./access";
import { listAssets, viewContext } from "./assets";
import { isLowValue } from "./dashboard";
import { listFiles } from "./files";
import { listPolicies } from "./insurance";
import { listMaintenance } from "./maintenance";
import { listWarranties } from "./warranties";

const HIDDEN = "not shared";
const money = (cents: number | null | undefined) => (cents === null || cents === undefined ? "" : (cents / 100).toFixed(2));
const moneyOr = (a: AssetSummary, cents: number | null | undefined) => (a.financialHidden ? HIDDEN : money(cents));

export interface ReportOptions {
    /** Include items below the person's low-value threshold. */
    includeLowValue?: boolean;
    /** For the claim report: the assets to document. */
    assetIds?: string[];
}

export async function reportCsv(
    db: D1Database,
    user: PortalUser,
    name: ReportName,
    options: ReportOptions = {},
): Promise<{ filename: string; csv: string; rows: number }> {
    const ctx = await viewContext(db, user);
    const { assets: all } = await listAssets(db, user, ctx);
    const assets = all.filter((a) => options.includeLowValue || !isLowValue(a, ctx.prefs.lowValueCents));
    const current = assets.filter((a) => !GONE_STATUSES.includes(a.status));
    const date = ctx.today;
    let csv: string;
    let rows: number;
    switch (name) {
        case "inventory":
        case "household": {
            const list =
                name === "household"
                    ? [...current].sort((a, b) => (a.location?.name ?? "~").localeCompare(b.location?.name ?? "~") || a.name.localeCompare(b.name))
                    : assets;
            const columns: CsvColumn<AssetSummary>[] = [
                ...(name === "household" ? [{ header: "Location", value: (a: AssetSummary) => (a.locationHidden ? HIDDEN : (a.location?.name ?? "")) }] : []),
                { header: "Name", value: (a) => a.name },
                { header: "Category", value: (a) => a.categoryLabel },
                { header: "Manufacturer", value: (a) => a.manufacturer },
                { header: "Brand", value: (a) => a.brand },
                { header: "Model", value: (a) => a.model },
                { header: "Serial number", value: (a) => a.serialNumber },
                { header: "Registration", value: (a) => a.vehicle?.registration },
                { header: "Status", value: (a) => ASSET_STATUS_LABELS[a.status] },
                { header: "Condition", value: (a) => CONDITION_LABELS[a.condition] },
                ...(name === "inventory" ? [{ header: "Location", value: (a: AssetSummary) => (a.locationHidden ? HIDDEN : (a.location?.name ?? "")) }] : []),
                { header: "Owner", value: (a) => a.owner.name ?? a.owner.email },
                { header: "Purchase date", value: (a) => a.purchaseDate },
                { header: "Purchase price (AUD)", value: (a) => moneyOr(a, a.purchasePriceCents) },
                { header: "Current value (AUD)", value: (a) => moneyOr(a, a.currentValue?.amountCents) },
                { header: "Value basis", value: (a) => (a.currentValue ? VALUE_BASIS_LABELS[a.currentValue.basis] : "") },
                { header: "Replacement value (AUD)", value: (a) => moneyOr(a, a.replacementValue?.amountCents) },
                { header: "Warranty", value: (a) => a.warranty.state },
                { header: "Warranty ends", value: (a) => a.warranty.expiresOn },
                { header: "Insurance", value: (a) => COVERAGE_LABELS[a.coverage] },
                { header: "Tags", value: (a) => a.tags.join("; ") },
            ];
            csv = toCsv(list, columns);
            rows = list.length;
            break;
        }
        case "values": {
            csv = toCsv(assets, [
                { header: "Name", value: (a) => a.name },
                { header: "Category", value: (a) => a.categoryLabel },
                { header: "Status", value: (a) => ASSET_STATUS_LABELS[a.status] },
                { header: "Purchase date", value: (a) => a.purchaseDate },
                { header: "Purchase price, actual transaction (AUD)", value: (a) => moneyOr(a, a.purchasePriceCents) },
                { header: "Current value (AUD)", value: (a) => moneyOr(a, a.currentValue?.amountCents) },
                {
                    header: "Current value is",
                    value: (a) => (a.currentValue ? VALUE_BASIS_LABELS[a.currentValue.basis] : a.financialHidden ? HIDDEN : "Not recorded"),
                },
                { header: "Valued on", value: (a) => a.currentValue?.valuedOn },
                { header: "Replacement value (AUD)", value: (a) => moneyOr(a, a.replacementValue?.amountCents) },
                { header: "Replacement value is", value: (a) => (a.replacementValue ? VALUE_BASIS_LABELS[a.replacementValue.basis] : "") },
            ]);
            rows = assets.length;
            break;
        }
        case "categories": {
            const by = new Map<string, { label: string; count: number; value: number; valued: number; without: number; hidden: number }>();
            for (const a of current) {
                const c = by.get(a.category) ?? { label: a.categoryLabel, count: 0, value: 0, valued: 0, without: 0, hidden: 0 };
                c.count++;
                if (a.financialHidden) c.hidden++;
                else if (a.currentValue) {
                    c.value += a.currentValue.amountCents;
                    c.valued++;
                } else c.without++;
                by.set(a.category, c);
            }
            const list = [...by.values()].sort((a, b) => b.count - a.count);
            csv = toCsv(list, [
                { header: "Category", value: (c) => c.label },
                { header: "Assets", value: (c) => c.count },
                { header: "Recorded current value (AUD)", value: (c) => (c.valued ? money(c.value) : "") },
                { header: "Assets with a value", value: (c) => c.valued },
                { header: "Assets without a value", value: (c) => c.without },
                { header: "Values not shared with you", value: (c) => c.hidden },
            ]);
            rows = list.length;
            break;
        }
        case "maintenance":
        case "expenditure":
        case "vehicles": {
            const records = await listMaintenance(db, user, { scope: "all", limit: 2000 });
            if (name === "maintenance") {
                csv = toCsv(records, [
                    { header: "Completed", value: (m) => m.completedOn },
                    { header: "Due", value: (m) => m.dueOn },
                    { header: "Asset or place", value: (m) => m.targetName },
                    { header: "Title", value: (m) => m.title },
                    { header: "Kind", value: (m) => MAINTENANCE_KIND_LABELS[m.kind] },
                    { header: "Status", value: (m) => MAINTENANCE_STATUS_LABELS[m.status] },
                    { header: "Provider", value: (m) => m.provider },
                    { header: "Odometer", value: (m) => m.odometer },
                    { header: "Cost (AUD)", value: (m) => (m.costHidden ? HIDDEN : money(m.costCents)) },
                ]);
                rows = records.length;
            } else if (name === "expenditure") {
                const years = new Map<string, { records: number; cost: number; known: number; missing: number; hidden: number }>();
                for (const m of records.filter((r) => r.status === "completed" && r.completedOn)) {
                    const y = m.completedOn!.slice(0, 4);
                    const row = years.get(y) ?? { records: 0, cost: 0, known: 0, missing: 0, hidden: 0 };
                    row.records++;
                    if (m.costHidden) row.hidden++;
                    else if (m.costCents === null) row.missing++;
                    else {
                        row.cost += m.costCents;
                        row.known++;
                    }
                    years.set(y, row);
                }
                const list = [...years.entries()].sort(([a], [b]) => b.localeCompare(a));
                csv = toCsv(list, [
                    { header: "Year", value: ([y]) => y },
                    { header: "Completed records", value: ([, r]) => r.records },
                    { header: "Recorded cost (AUD)", value: ([, r]) => (r.known ? money(r.cost) : "") },
                    { header: "Records with a cost", value: ([, r]) => r.known },
                    { header: "Records without a cost", value: ([, r]) => r.missing },
                    { header: "Costs not shared with you", value: ([, r]) => r.hidden },
                ]);
                rows = list.length;
            } else {
                const vehicles = assets.filter((a) => a.vehicle);
                const year = date.slice(0, 4);
                const list = vehicles.map((v) => {
                    const done = records.filter((m) => m.assetId === v.id && m.status === "completed");
                    const known = done.filter((m) => m.costCents !== null && !m.costHidden);
                    const sum = (list: typeof done) => list.reduce((n, m) => n + (m.costCents ?? 0), 0);
                    return {
                        v,
                        records: done.length,
                        total: known.length ? sum(known) : null,
                        thisYear: sum(known.filter((m) => m.completedOn?.startsWith(year))),
                        lastYear: sum(known.filter((m) => m.completedOn?.startsWith(String(Number(year) - 1)))),
                        missing: done.length - known.length,
                    };
                });
                csv = toCsv(list, [
                    { header: "Vehicle or trailer", value: (r) => r.v.name },
                    { header: "Registration", value: (r) => r.v.vehicle?.registration },
                    { header: "Registration expiry", value: (r) => r.v.vehicle?.registrationExpiry },
                    { header: "Latest odometer", value: (r) => r.v.vehicle?.odometer },
                    { header: "Completed maintenance", value: (r) => r.records },
                    { header: "Recorded maintenance cost (AUD)", value: (r) => (r.v.financialHidden ? HIDDEN : money(r.total)) },
                    { header: `Recorded cost ${year} (AUD)`, value: (r) => (r.v.financialHidden ? HIDDEN : money(r.thisYear)) },
                    { header: `Recorded cost ${Number(year) - 1} (AUD)`, value: (r) => (r.v.financialHidden ? HIDDEN : money(r.lastYear)) },
                    { header: "Records without a cost", value: (r) => r.missing },
                    { header: "Purchase price (AUD)", value: (r) => moneyOr(r.v, r.v.purchasePriceCents) },
                ]);
                rows = list.length;
            }
            break;
        }
        case "renewals": {
            const policies = await listPolicies(db, user);
            csv = toCsv(policies, [
                { header: "Provider", value: (p) => p.provider },
                { header: "Policy", value: (p) => p.name },
                { header: "Type", value: (p) => POLICY_TYPE_LABELS[p.policyType] },
                { header: "Status", value: (p) => p.status },
                { header: "Starts", value: (p) => p.startsOn },
                { header: "Renews", value: (p) => p.renewsOn },
                { header: "Premium (AUD)", value: (p) => money(p.premiumCents) },
                { header: "Paid", value: (p) => (p.paymentFrequency ? FREQUENCY_LABELS[p.paymentFrequency] : "") },
                {
                    header: "Premium a year (AUD)",
                    value: (p) => money(annualPremium(p.premiumCents, p.paymentFrequency ? PAYMENTS_PER_YEAR[p.paymentFrequency] : null)),
                },
                {
                    header: "Previous period premium (AUD)",
                    value: (p) => money(p.premiums.find((x) => x.periodStart !== p.startsOn)?.premiumCents),
                },
                { header: "Excess (AUD)", value: (p) => money(p.excessCents) },
                { header: "Verified against documents", value: (p) => (p.verified ? `yes, ${p.verified.at.slice(0, 10)}` : "no") },
                {
                    header: "Linked assets",
                    value: (p) => p.assets.map((a) => a.name).join("; ") + (p.hiddenAssetCount ? ` (+${p.hiddenAssetCount} not shared)` : ""),
                },
            ]);
            rows = policies.length;
            break;
        }
        case "warranties": {
            const warranties = await listWarranties(db, user);
            csv = toCsv(warranties, [
                { header: "Asset", value: (w) => w.assetName },
                { header: "Warranty", value: (w) => WARRANTY_KIND_LABELS[w.kind] },
                { header: "Provider", value: (w) => w.provider },
                { header: "Starts", value: (w) => w.startsOn },
                { header: "Months", value: (w) => w.months },
                { header: "Ends", value: (w) => w.expiresOn },
                {
                    header: "End date is",
                    value: (w) => (w.expiresBasis === "stated" ? "as stated" : w.expiresBasis === "calculated" ? "calculated from start + months" : "unknown"),
                },
                { header: "State", value: (w) => w.state },
                { header: "Reference", value: (w) => w.reference },
            ]);
            rows = warranties.length;
            break;
        }
        case "claim": {
            const ids = new Set(options.assetIds ?? []);
            if (!ids.size) throw new HttpError(422, "validation", "Choose the assets to document");
            const chosen = all.filter((a) => ids.has(a.id));
            const { files } = await listFiles(db, user, 2000);
            const policies = await listPolicies(db, user);
            csv = toCsv(chosen, [
                { header: "Name", value: (a) => a.name },
                { header: "Category", value: (a) => a.categoryLabel },
                { header: "Manufacturer", value: (a) => a.manufacturer ?? a.brand },
                { header: "Model", value: (a) => a.model },
                { header: "Serial number", value: (a) => a.serialNumber },
                { header: "Location", value: (a) => (a.locationHidden ? HIDDEN : (a.location?.name ?? "")) },
                { header: "Purchase date", value: (a) => a.purchaseDate },
                { header: "Purchase price, actual (AUD)", value: (a) => moneyOr(a, a.purchasePriceCents) },
                { header: "Replacement value (AUD)", value: (a) => moneyOr(a, a.replacementValue?.amountCents) },
                { header: "Replacement value is", value: (a) => (a.replacementValue ? VALUE_BASIS_LABELS[a.replacementValue.basis] : "") },
                {
                    header: "Receipts and invoices",
                    value: (a) => files.filter((f) => f.assetId === a.id && (f.kind === "receipt" || f.kind === "invoice")).length,
                },
                { header: "Photos", value: (a) => files.filter((f) => f.assetId === a.id && f.kind === "photo").length },
                {
                    header: "Linked policies",
                    value: (a) =>
                        policies
                            .filter((p) => p.assets.some((x) => x.id === a.id))
                            .map((p) => `${p.provider}${p.reference ? ` ${p.reference}` : ""}`)
                            .join("; "),
                },
                { header: "Insurance record", value: (a) => COVERAGE_LABELS[a.coverage] },
            ]);
            rows = chosen.length;
            break;
        }
    }
    await activity(db, { actor: user.email, action: `export.${name}`, entityType: "export" }).run();
    return { filename: `home-assets-${name}-${date}.csv`, csv, rows };
}
