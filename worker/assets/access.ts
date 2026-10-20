// Who may see and change what in Home & Assets.
//
// Portal roles decide whether someone may open Home & Assets at all ("assets.use"). Inside it,
// every asset has one owner, who can do everything. Anyone else reaches an asset only through
// asset_shares: a row for their own email, or the household row (email '*', meaning everyone who
// can open Home & Assets). Viewing comes with any row; editing, recording maintenance, financial
// values, insurance and documents are granted separately, and a person's rights are their own row
// and the household row together. Being a portal owner grants nothing here: neither owner can see
// the other's private assets. An asset you can't see doesn't exist as far as the API is concerned
// (404, never 403), so ids can't be probed.
//
// Locations and insurance policies are their owner's, unless shared with the household (view, and
// optionally edit). Seeing an asset doesn't reveal a location you can't see, or a policy.
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { type AssetPreferences, DEFAULT_ASSET_PREFERENCES, NO_GRANT, type Rights, assetPreferencesSchema } from "../../src/shared/assets/types";
import { localDate } from "../../src/shared/calendar/time";
import { isRole, permissionsFor } from "../../src/shared/portal/permissions";
import type { PortalUser } from "../../src/shared/portal/types";
import { preferences as calendarPreferences } from "../calendar/access";
import type { Env } from "../env";
import { ownerEmails } from "../portal/auth";
import { nowIso, parseJson } from "../portal/db";
import { HttpError } from "../portal/http";

export const notFound = () => new HttpError(404, "not_found", "Not found");

const REFUSALS: Record<Exclude<keyof Rights, "view">, string> = {
    edit: "You can view this asset but not change it",
    maintain: "You can't record maintenance for this asset",
    financial: "Values and costs for this asset aren't shared with you",
    insurance: "Insurance for this asset isn't shared with you",
    documents: "Documents for this asset aren't shared with you",
    manage: "Only the asset's owner can do that",
};
export const refuse = (right: Exclude<keyof Rights, "view">) => new HttpError(403, "forbidden", REFUSALS[right]);

export const ALL_RIGHTS: Rights = { view: true, edit: true, maintain: true, financial: true, insurance: true, documents: true, manage: true };

/** The asset columns every read selects, plus the caller's rights from their own and the household share. */
export const ACCESS_SELECT = `a.*,
    CASE WHEN a.owner_email = ?1 THEN 1 ELSE 0 END AS mine,
    MAX(COALESCE(s.can_edit, 0), COALESCE(h.can_edit, 0)) AS g_edit,
    MAX(COALESCE(s.can_maintain, 0), COALESCE(h.can_maintain, 0)) AS g_maintain,
    MAX(COALESCE(s.can_financial, 0), COALESCE(h.can_financial, 0)) AS g_financial,
    MAX(COALESCE(s.can_insurance, 0), COALESCE(h.can_insurance, 0)) AS g_insurance,
    MAX(COALESCE(s.can_documents, 0), COALESCE(h.can_documents, 0)) AS g_documents`;

/** FROM … WHERE for assets the caller (bound as ?1) can see. */
export const ACCESS_FROM = `FROM assets a
    LEFT JOIN asset_shares s ON s.asset_id = a.id AND s.email = ?1
    LEFT JOIN asset_shares h ON h.asset_id = a.id AND h.email = '*'
    WHERE a.deleted_at IS NULL AND (a.owner_email = ?1 OR s.asset_id IS NOT NULL OR h.asset_id IS NOT NULL)`;

/** A CTE naming the ids of the assets the caller (?1) can see, for joining other tables to. */
export const VISIBLE = `visible AS (SELECT a.id ${ACCESS_FROM})`;

export interface AssetRow {
    id: string;
    owner_email: string;
    name: string;
    category: string;
    manufacturer: string | null;
    brand: string | null;
    model: string | null;
    serial_number: string | null;
    barcode: string | null;
    description: string | null;
    purchase_date: string | null;
    purchase_price_cents: number | null;
    purchase_location: string | null;
    condition: string;
    status: string;
    ownership: string | null;
    location_id: string | null;
    notes: string | null;
    tags: string;
    custom: string;
    depreciation: string;
    disposed_on: string | null;
    disposal_method: string | null;
    disposal_amount_cents: number | null;
    disposal_notes: string | null;
    label_version: number;
    cover_file_id: string | null;
    visibility: "private" | "selected" | "household";
    client_id: string | null;
    deleted_at: string | null;
    version: number;
    created_by: string;
    created_at: string;
    updated_by: string;
    updated_at: string;
}

export interface AssetAccessRow extends AssetRow {
    mine: number;
    g_edit: number;
    g_maintain: number;
    g_financial: number;
    g_insurance: number;
    g_documents: number;
}

export const rightsOf = (row: AssetAccessRow): Rights =>
    row.mine
        ? ALL_RIGHTS
        : {
              view: true,
              edit: !!row.g_edit,
              maintain: !!row.g_edit || !!row.g_maintain,
              financial: !!row.g_financial,
              insurance: !!row.g_insurance,
              documents: !!row.g_documents,
              manage: false,
          };

export interface AssetAccess {
    row: AssetAccessRow;
    rights: Rights;
}

/** The asset, if the caller can see it and has `need`. Not visible: 404. Visible without the right: 403. */
export async function requireAsset(db: D1Database, user: PortalUser, id: string, need: keyof Rights = "view"): Promise<AssetAccess> {
    const row = await db.prepare(`SELECT ${ACCESS_SELECT} ${ACCESS_FROM} AND a.id = ?2`).bind(user.email, id).first<AssetAccessRow>();
    if (!row) throw notFound();
    const rights = rightsOf(row);
    if (need !== "view" && !rights[need]) throw refuse(need);
    return { row, rights };
}

/** Every asset the caller can see, most recently changed first, bounded. */
export async function visibleAssets(db: D1Database, user: PortalUser, limit: number, extra = "", binds: unknown[] = []): Promise<AssetAccessRow[]> {
    const rows = await db
        .prepare(`SELECT ${ACCESS_SELECT} ${ACCESS_FROM} ${extra} ORDER BY a.updated_at DESC LIMIT ${Math.max(1, Math.min(limit, 5000))}`)
        .bind(user.email, ...binds)
        .all<AssetAccessRow>();
    return rows.results;
}

// --- Locations -----------------------------------------------------------------------------------

export interface LocationRow {
    id: string;
    owner_email: string;
    name: string;
    kind: string;
    parent_id: string | null;
    tenure: string | null;
    address: string | null;
    lease_start: string | null;
    lease_end: string | null;
    manager_name: string | null;
    manager_phone: string | null;
    manager_email: string | null;
    next_inspection_on: string | null;
    utilities: string | null;
    notes: string | null;
    visibility: "private" | "household";
    household_can_edit: number;
    archived_at: string | null;
    version: number;
    created_at: string;
    updated_at: string;
}

export const LOCATION_VISIBLE = "(l.owner_email = ?1 OR l.visibility = 'household')";

export const canEditLocation = (row: Pick<LocationRow, "owner_email" | "visibility" | "household_can_edit">, email: string) =>
    row.owner_email === email || (row.visibility === "household" && !!row.household_can_edit);

export async function requireLocation(db: D1Database, user: PortalUser, id: string, edit = false): Promise<LocationRow> {
    const row = await db.prepare(`SELECT l.* FROM asset_locations l WHERE l.id = ?2 AND ${LOCATION_VISIBLE}`).bind(user.email, id).first<LocationRow>();
    if (!row) throw notFound();
    if (edit && !canEditLocation(row, user.email)) throw new HttpError(403, "forbidden", "You can view this place but not change it");
    return row;
}

export async function visibleLocations(db: D1Database, user: PortalUser, includeArchived = false): Promise<LocationRow[]> {
    const rows = await db
        .prepare(`SELECT l.* FROM asset_locations l WHERE ${LOCATION_VISIBLE} ${includeArchived ? "" : "AND l.archived_at IS NULL"} ORDER BY l.name LIMIT 500`)
        .bind(user.email)
        .all<LocationRow>();
    return rows.results;
}

// --- Policies ------------------------------------------------------------------------------------

export interface PolicyRow {
    id: string;
    owner_email: string;
    provider: string;
    policy_type: string;
    name: string | null;
    reference: string | null;
    starts_on: string | null;
    renews_on: string | null;
    premium_cents: number | null;
    payment_frequency: string | null;
    excess_cents: number | null;
    coverage_summary: string | null;
    coverage_limits: string | null;
    exclusions: string | null;
    contact_phone: string | null;
    contact_email: string | null;
    contact_url: string | null;
    notes: string | null;
    status: string;
    previous_id: string | null;
    unverified_fields: string;
    verified_at: string | null;
    verified_by: string | null;
    shared: number;
    household_can_edit: number;
    version: number;
    created_at: string;
    updated_at: string;
}

export const POLICY_VISIBLE = "(p.owner_email = ?1 OR p.shared = 1)";

export const canEditPolicy = (row: Pick<PolicyRow, "owner_email" | "shared" | "household_can_edit">, email: string) =>
    row.owner_email === email || (!!row.shared && !!row.household_can_edit);

export async function requirePolicy(db: D1Database, user: PortalUser, id: string, edit = false): Promise<PolicyRow> {
    const row = await db.prepare(`SELECT p.* FROM asset_policies p WHERE p.id = ?2 AND ${POLICY_VISIBLE}`).bind(user.email, id).first<PolicyRow>();
    if (!row) throw notFound();
    if (edit && !canEditPolicy(row, user.email)) throw new HttpError(403, "forbidden", "You can view this policy but not change it");
    return row;
}

// --- People --------------------------------------------------------------------------------------

/** Only people who can already open Home & Assets in the portal can be given an asset. */
export async function canUseAssets(env: Env, db: D1Database, email: string) {
    if (ownerEmails(env).has(email)) return true;
    const row = await db.prepare("SELECT role, active FROM portal_users WHERE email = ?").bind(email).first<{ role: string; active: number }>();
    return !!row?.active && isRole(row.role) && permissionsFor(row.role).includes("assets.use");
}

/** The household: everyone who can open Home & Assets (names and emails only). */
export async function assetPeople(env: Env, db: D1Database): Promise<{ email: string; name: string | null }[]> {
    const rows = await db
        .prepare("SELECT email, name, role, active FROM portal_users WHERE active = 1")
        .all<{ email: string; name: string | null; role: string }>();
    const people = new Map<string, { email: string; name: string | null }>();
    for (const email of ownerEmails(env)) people.set(email, { email, name: null });
    for (const r of rows.results) {
        const email = r.email.toLowerCase();
        if (ownerEmails(env).has(email)) people.set(email, { email, name: r.name ?? null });
        else if (isRole(r.role) && permissionsFor(r.role).includes("assets.use")) people.set(email, { email, name: r.name ?? null });
    }
    return [...people.values()].sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email));
}

/** Display names for emails, from portal_users (null when unknown). */
export async function namesFor(db: D1Database, emails: string[]): Promise<Map<string, string | null>> {
    const unique = [...new Set(emails.map((e) => e.toLowerCase()))].slice(0, 90);
    const out = new Map<string, string | null>(unique.map((e) => [e, null]));
    if (!unique.length) return out;
    const rows = await db
        .prepare(`SELECT email, name FROM portal_users WHERE lower(email) IN (${unique.map(() => "?").join(", ")})`)
        .bind(...unique)
        .all<{ email: string; name: string | null }>();
    for (const r of rows.results) out.set(r.email.toLowerCase(), r.name);
    return out;
}

// --- History -------------------------------------------------------------------------------------

export interface ActivityInput {
    actor: string;
    action: string;
    entityType: string;
    entityId?: string | null;
    assetId?: string | null;
    via?: "portal" | "mcp" | "system";
}

/** History without content: who did what to which record. Never a name, identifier, amount or address. */
export const activity = (db: D1Database, entry: ActivityInput): D1PreparedStatement =>
    db
        .prepare("INSERT INTO asset_activity (at, actor, action, entity_type, entity_id, asset_id, via) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(nowIso(), entry.actor, entry.action, entry.entityType, entry.entityId ?? null, entry.assetId ?? null, entry.via ?? "portal");

// --- Preferences and time ------------------------------------------------------------------------

export async function assetPreferences(db: D1Database, email: string): Promise<{ preferences: AssetPreferences; version: number }> {
    const row = await db.prepare("SELECT value, version FROM asset_preferences WHERE email = ?").bind(email).first<{ value: string; version: number }>();
    if (!row) return { preferences: DEFAULT_ASSET_PREFERENCES, version: 0 };
    // A document that no longer validates falls back to the defaults rather than failing.
    const parsed = assetPreferencesSchema.safeParse(parseJson<Record<string, unknown>>(row.value, {}));
    return { preferences: parsed.success ? parsed.data : DEFAULT_ASSET_PREFERENCES, version: row.version };
}

export async function saveAssetPreferences(db: D1Database, user: PortalUser, input: unknown, version: number) {
    const value = assetPreferencesSchema.parse(input);
    const now = nowIso();
    const result =
        version === 0
            ? await db
                  .prepare("INSERT INTO asset_preferences (email, value, version, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT (email) DO NOTHING")
                  .bind(user.email, JSON.stringify(value), now)
                  .run()
            : await db
                  .prepare("UPDATE asset_preferences SET value = ?, version = version + 1, updated_at = ? WHERE email = ? AND version = ?")
                  .bind(JSON.stringify(value), now, user.email, version)
                  .run();
    if (!result.meta.changes) throw new HttpError(409, "conflict", "Your settings were changed somewhere else. Reload and try again.");
    await activity(db, { actor: user.email, action: "preferences.update", entityType: "preferences" }).run();
    return assetPreferences(db, user.email);
}

/** The person's time zone (from Calendar) and today's date in it. */
export async function clockFor(db: D1Database, email: string): Promise<{ today: string; timeZone: string }> {
    const timeZone = (await calendarPreferences(db, email)).timeZone;
    return { today: localDate(new Date(), timeZone), timeZone };
}

export const grantOf = (row: { can_edit: number; can_maintain: number; can_financial: number; can_insurance: number; can_documents: number } | null) =>
    row
        ? { edit: !!row.can_edit, maintain: !!row.can_maintain, financial: !!row.can_financial, insurance: !!row.can_insurance, documents: !!row.can_documents }
        : NO_GRANT;
