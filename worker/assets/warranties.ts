// Warranties and claims. A warranty's end date is either the one the person entered (stated) or the
// start (or purchase) date plus the months they entered (calculated); otherwise it's unknown, never
// guessed. Warranties are what a manufacturer, retailer or provider promised, separate from the
// Australian Consumer Law guarantees, which the pages explain don't simply end with them.
//
// Seeing a warranty needs sight of its asset; changing one needs edit rights. Costs and claim
// amounts need the asset's financial right. Claims under an insurance policy also need its
// insurance right.
import type { D1Database } from "@cloudflare/workers-types";
import { warrantyExpiry, warrantyState } from "../../src/shared/assets/engine";
import { type ClaimView, type WarrantyView, claimInput, updateClaimInput, updateWarrantyInput, warrantyInput } from "../../src/shared/assets/types";
import type { PortalUser } from "../../src/shared/portal/types";
import { newId, nowIso } from "../portal/db";
import { HttpError } from "../portal/http";
import { activity, assetPreferences, clockFor, notFound, refuse, requireAsset, requirePolicy, rightsOf, visibleAssets } from "./access";

interface WarrantyRow {
    id: string;
    asset_id: string;
    kind: WarrantyView["kind"];
    provider: string | null;
    starts_on: string | null;
    months: number | null;
    expires_on: string | null;
    expires_basis: WarrantyView["expiresBasis"];
    reference: string | null;
    terms: string | null;
    contact: string | null;
    cost_cents: number | null;
    version: number;
    asset_name: string;
    purchase_date: string | null;
}

export async function listWarranties(db: D1Database, user: PortalUser, assetId?: string): Promise<WarrantyView[]> {
    const assets = new Map((await visibleAssets(db, user, 5000)).map((a) => [a.id, a]));
    const rows = await db
        .prepare(
            `SELECT w.*, a.name AS asset_name, a.purchase_date FROM asset_warranties w JOIN assets a ON a.id = w.asset_id AND a.deleted_at IS NULL
             ${assetId ? "WHERE w.asset_id = ?" : ""} ORDER BY w.expires_on IS NULL, w.expires_on LIMIT 2000`,
        )
        .bind(...(assetId ? [assetId] : []))
        .all<WarrantyRow>();
    const [{ today }, { preferences }] = await Promise.all([clockFor(db, user.email), assetPreferences(db, user.email)]);
    return rows.results
        .filter((r) => assets.has(r.asset_id))
        .map((r): WarrantyView => {
            // Recalculated on read, so a purchase date added later is used.
            const end =
                r.expires_basis === "stated"
                    ? { expiresOn: r.expires_on, basis: "stated" as const }
                    : warrantyExpiry({ expiresOn: null, startsOn: r.starts_on, months: r.months, purchaseDate: r.purchase_date });
            return {
                id: r.id,
                assetId: r.asset_id,
                assetName: r.asset_name,
                kind: r.kind,
                provider: r.provider,
                startsOn: r.starts_on,
                months: r.months,
                expiresOn: end.expiresOn,
                expiresBasis: end.basis,
                state: warrantyState(end.expiresOn, today, preferences.dueSoonDays),
                reference: r.reference,
                terms: r.terms,
                contact: r.contact,
                costCents: rightsOf(assets.get(r.asset_id)!).financial ? r.cost_cents : null,
                version: r.version,
            };
        });
}

const resolveExpiry = (body: { expiresOn?: string | null; startsOn?: string | null; months?: number | null }, purchaseDate: string | null) => {
    const end = warrantyExpiry({ expiresOn: body.expiresOn ?? null, startsOn: body.startsOn ?? null, months: body.months ?? null, purchaseDate });
    return end;
};

export async function createWarranty(db: D1Database, user: PortalUser, assetId: string, input: unknown): Promise<WarrantyView[]> {
    const body = warrantyInput.parse(input);
    const { row, rights } = await requireAsset(db, user, assetId, "edit");
    if (body.costCents !== undefined && body.costCents !== null && !rights.financial) throw refuse("financial");
    if (body.startsOn && body.expiresOn && body.expiresOn < body.startsOn) throw new HttpError(422, "validation", "The expiry is before the start");
    const end = resolveExpiry(body, row.purchase_date);
    const id = newId("awr");
    const now = nowIso();
    await db.batch([
        db
            .prepare(
                `INSERT INTO asset_warranties (id, asset_id, kind, provider, starts_on, months, expires_on, expires_basis, reference, terms, contact, cost_cents, created_by, created_at, updated_by, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
                id,
                assetId,
                body.kind,
                body.provider ?? null,
                body.startsOn ?? null,
                body.months ?? null,
                end.expiresOn,
                end.basis,
                body.reference ?? null,
                body.terms ?? null,
                body.contact ?? null,
                body.costCents ?? null,
                user.email,
                now,
                user.email,
                now,
            ),
        activity(db, { actor: user.email, action: "warranty.create", entityType: "warranty", entityId: id, assetId }),
    ]);
    return listWarranties(db, user, assetId);
}

async function requireWarranty(db: D1Database, user: PortalUser, id: string) {
    const row = await db.prepare("SELECT * FROM asset_warranties WHERE id = ?").bind(id).first<WarrantyRow>();
    if (!row) throw notFound();
    const access = await requireAsset(db, user, row.asset_id, "edit").catch((e) => {
        throw e instanceof HttpError && e.status === 403 ? e : notFound();
    });
    return { warranty: row, asset: access.row, rights: access.rights };
}

export async function updateWarranty(db: D1Database, user: PortalUser, id: string, input: unknown): Promise<WarrantyView[]> {
    const body = updateWarrantyInput.parse(input);
    const { warranty: row, asset, rights } = await requireWarranty(db, user, id);
    if (body.costCents !== undefined && !rights.financial) throw refuse("financial");
    const merged = {
        kind: body.kind ?? row.kind,
        provider: body.provider === undefined ? row.provider : body.provider,
        startsOn: body.startsOn === undefined ? row.starts_on : body.startsOn,
        months: body.months === undefined ? row.months : body.months,
        expiresOn: body.expiresOn === undefined ? (row.expires_basis === "stated" ? row.expires_on : null) : body.expiresOn,
        reference: body.reference === undefined ? row.reference : body.reference,
        terms: body.terms === undefined ? row.terms : body.terms,
        contact: body.contact === undefined ? row.contact : body.contact,
        costCents: body.costCents === undefined ? row.cost_cents : body.costCents,
    };
    const end = resolveExpiry(merged, asset.purchase_date);
    const result = await db
        .prepare(
            `UPDATE asset_warranties SET kind = ?, provider = ?, starts_on = ?, months = ?, expires_on = ?, expires_basis = ?, reference = ?, terms = ?, contact = ?, cost_cents = ?,
                version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND version = ?`,
        )
        .bind(
            merged.kind,
            merged.provider ?? null,
            merged.startsOn ?? null,
            merged.months ?? null,
            end.expiresOn,
            end.basis,
            merged.reference ?? null,
            merged.terms ?? null,
            merged.contact ?? null,
            merged.costCents ?? null,
            user.email,
            nowIso(),
            id,
            body.version,
        )
        .run();
    if (!result.meta.changes) throw new HttpError(409, "conflict", "Someone changed this warranty since you opened it. Reload, then try again.");
    await activity(db, { actor: user.email, action: "warranty.update", entityType: "warranty", entityId: id, assetId: row.asset_id }).run();
    return listWarranties(db, user, row.asset_id);
}

export async function deleteWarranty(db: D1Database, user: PortalUser, id: string): Promise<WarrantyView[]> {
    const { warranty: row } = await requireWarranty(db, user, id);
    await db.batch([
        db.prepare("DELETE FROM asset_warranties WHERE id = ?").bind(id),
        activity(db, { actor: user.email, action: "warranty.delete", entityType: "warranty", entityId: id, assetId: row.asset_id }),
    ]);
    return listWarranties(db, user, row.asset_id);
}

// --- Claims --------------------------------------------------------------------------------------

interface ClaimRow {
    id: string;
    asset_id: string | null;
    warranty_id: string | null;
    policy_id: string | null;
    kind: ClaimView["kind"];
    lodged_on: string | null;
    reference: string | null;
    description: string | null;
    status: ClaimView["status"];
    amount_claimed_cents: number | null;
    amount_paid_cents: number | null;
    outcome: string | null;
    updated_at: string;
    asset_name: string | null;
    policy_owner: string | null;
    policy_shared: number | null;
}

export async function listClaims(db: D1Database, user: PortalUser, filter: { assetId?: string; policyId?: string } = {}): Promise<ClaimView[]> {
    const assets = new Map((await visibleAssets(db, user, 5000)).map((a) => [a.id, a]));
    const where = filter.assetId ? "WHERE c.asset_id = ?" : filter.policyId ? "WHERE c.policy_id = ?" : "";
    const rows = await db
        .prepare(
            `SELECT c.*, a.name AS asset_name, p.owner_email AS policy_owner, p.shared AS policy_shared FROM asset_claims c
             LEFT JOIN assets a ON a.id = c.asset_id AND a.deleted_at IS NULL LEFT JOIN asset_policies p ON p.id = c.policy_id
             ${where} ORDER BY c.updated_at DESC LIMIT 500`,
        )
        .bind(...(filter.assetId ? [filter.assetId] : filter.policyId ? [filter.policyId] : []))
        .all<ClaimRow>();
    return rows.results
        .filter((c) => {
            // An asset claim needs the asset; an insurance claim also needs its insurance, or the policy itself.
            const asset = c.asset_id ? assets.get(c.asset_id) : undefined;
            const policyVisible = c.policy_id ? c.policy_owner === user.email || !!c.policy_shared : false;
            if (c.asset_id && !asset) return false;
            if (c.kind === "insurance") return policyVisible || (asset ? rightsOf(asset).insurance : false);
            return !!asset || policyVisible;
        })
        .map((c): ClaimView => {
            const asset = c.asset_id ? assets.get(c.asset_id) : undefined;
            const financial = asset ? rightsOf(asset).financial : c.policy_owner === user.email;
            return {
                id: c.id,
                assetId: c.asset_id,
                assetName: asset ? c.asset_name : null,
                warrantyId: c.warranty_id,
                policyId: c.policy_id,
                kind: c.kind,
                lodgedOn: c.lodged_on,
                reference: c.reference,
                description: c.description,
                status: c.status,
                amountClaimedCents: financial ? c.amount_claimed_cents : null,
                amountPaidCents: financial ? c.amount_paid_cents : null,
                outcome: c.outcome,
                updatedAt: c.updated_at,
            };
        });
}

export async function createClaim(db: D1Database, user: PortalUser, input: unknown): Promise<ClaimView> {
    const body = claimInput.parse(input);
    if (!body.assetId && !body.policyId) throw new HttpError(422, "validation", "Choose an asset or a policy");
    let financial = true;
    if (body.assetId) {
        const { rights } = await requireAsset(db, user, body.assetId, "edit");
        if (body.kind === "insurance" && !rights.insurance) throw refuse("insurance");
        financial = rights.financial;
    }
    if (body.policyId) await requirePolicy(db, user, body.policyId);
    if (body.warrantyId) {
        const w = await db.prepare("SELECT asset_id FROM asset_warranties WHERE id = ?").bind(body.warrantyId).first<{ asset_id: string }>();
        if (!w || w.asset_id !== body.assetId) throw new HttpError(422, "validation", "That warranty belongs to another asset");
    }
    if ((body.amountClaimedCents ?? body.amountPaidCents) !== undefined && !financial) throw refuse("financial");
    const id = newId("acl");
    const now = nowIso();
    await db.batch([
        db
            .prepare(
                `INSERT INTO asset_claims (id, asset_id, warranty_id, policy_id, kind, lodged_on, reference, description, status, amount_claimed_cents, amount_paid_cents, outcome, created_by, created_at, updated_by, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
                id,
                body.assetId ?? null,
                body.warrantyId ?? null,
                body.policyId ?? null,
                body.kind,
                body.lodgedOn ?? null,
                body.reference ?? null,
                body.description ?? null,
                body.status ?? "open",
                body.amountClaimedCents ?? null,
                body.amountPaidCents ?? null,
                body.outcome ?? null,
                user.email,
                now,
                user.email,
                now,
            ),
        activity(db, { actor: user.email, action: "claim.create", entityType: "claim", entityId: id, assetId: body.assetId ?? null }),
    ]);
    return (await listClaims(db, user)).find((c) => c.id === id)!;
}

export async function updateClaim(db: D1Database, user: PortalUser, id: string, input: unknown): Promise<ClaimView> {
    const body = updateClaimInput.parse(input) as Record<string, unknown>;
    const row = await db.prepare("SELECT * FROM asset_claims WHERE id = ?").bind(id).first<ClaimRow>();
    if (!row) throw notFound();
    let financial = true;
    if (row.asset_id) {
        const { rights } = await requireAsset(db, user, row.asset_id, "edit").catch((e) => {
            throw e instanceof HttpError && e.status === 403 ? e : notFound();
        });
        financial = rights.financial;
    } else if (row.policy_id) await requirePolicy(db, user, row.policy_id, true);
    if ((body.amountClaimedCents !== undefined || body.amountPaidCents !== undefined) && !financial) throw refuse("financial");
    const map: Record<string, string> = {
        warrantyId: "warranty_id",
        policyId: "policy_id",
        lodgedOn: "lodged_on",
        reference: "reference",
        description: "description",
        status: "status",
        amountClaimedCents: "amount_claimed_cents",
        amountPaidCents: "amount_paid_cents",
        outcome: "outcome",
    };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [k, c] of Object.entries(map))
        if (body[k] !== undefined) {
            sets.push(`${c} = ?`);
            values.push(body[k] ?? null);
        }
    if (body.policyId) await requirePolicy(db, user, body.policyId as string);
    await db.batch([
        db
            .prepare(`UPDATE asset_claims SET ${[...sets, "updated_by = ?", "updated_at = ?"].join(", ")} WHERE id = ?`)
            .bind(...values, user.email, nowIso(), id),
        activity(db, { actor: user.email, action: "claim.update", entityType: "claim", entityId: id, assetId: row.asset_id }),
    ]);
    return (await listClaims(db, user)).find((c) => c.id === id)!;
}
