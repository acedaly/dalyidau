// Insurance policies, the assets they name, premium history, renewals and verification.
//
// A policy record is what the household wrote down (or accepted from an AI suggestion), not proof
// of cover. It counts as verified only when a person confirms it against the policy documents, and
// an asset is shown as "linked to a verified policy" only then, and only while the policy is active
// and not past its renewal date. Nothing here calls an asset insured.
//
// A policy is its owner's unless shared with the household. Linking it to an asset needs edit
// rights on the asset and sight of the policy. Someone who can see an asset's insurance but not the
// policy itself sees only the asset's coverage state.
import type { D1Database } from "@cloudflare/workers-types";
import { type PolicyView, policyInput, updatePolicyInput } from "../../src/shared/assets/types";
import type { PortalUser } from "../../src/shared/portal/types";
import { newId, nowIso, parseJson } from "../portal/db";
import { HttpError } from "../portal/http";
import {
    POLICY_VISIBLE,
    type PolicyRow,
    activity,
    canEditPolicy,
    clockFor,
    namesFor,
    refuse,
    requireAsset,
    requirePolicy,
    rightsOf,
    visibleAssets,
} from "./access";
import { claimInboxFiles } from "./assets";

const COLUMNS: Record<string, string> = {
    provider: "provider",
    policyType: "policy_type",
    name: "name",
    reference: "reference",
    startsOn: "starts_on",
    renewsOn: "renews_on",
    premiumCents: "premium_cents",
    paymentFrequency: "payment_frequency",
    excessCents: "excess_cents",
    coverageSummary: "coverage_summary",
    coverageLimits: "coverage_limits",
    exclusions: "exclusions",
    contactPhone: "contact_phone",
    contactEmail: "contact_email",
    contactUrl: "contact_url",
    notes: "notes",
    status: "status",
    previousId: "previous_id",
};

/** Policies the caller can see, with the assets they can see linked to each. */
export async function listPolicies(db: D1Database, user: PortalUser, only?: string[]): Promise<PolicyView[]> {
    const where = only?.length ? `AND p.id IN (${only.map((_, i) => `?${i + 2}`).join(", ")})` : "";
    const rows = await db
        .prepare(`SELECT p.* FROM asset_policies p WHERE ${POLICY_VISIBLE} ${where} ORDER BY p.status <> 'active', p.renews_on IS NULL, p.renews_on LIMIT 500`)
        .bind(user.email, ...(only ?? []))
        .all<PolicyRow>();
    if (!rows.results.length) return [];
    const policyIds = rows.results.map((r) => r.id);
    // Assets the caller can see insurance for. Others linked to the policy are only counted.
    const visible = new Map((await visibleAssets(db, user, 5000)).filter((a) => rightsOf(a).insurance).map((a) => [a.id, a]));
    const [links, premiums, files] = await db.batch([
        db
            .prepare(
                `SELECT l.policy_id, l.asset_id, l.agreed_value_cents FROM asset_policy_links l JOIN asset_policies p ON p.id = l.policy_id AND ${POLICY_VISIBLE.replace(/\?1/g, "?")}`,
            )
            .bind(user.email),
        db
            .prepare(
                `SELECT x.policy_id, x.period_start, x.premium_cents, x.payment_frequency FROM asset_policy_premiums x JOIN asset_policies p ON p.id = x.policy_id AND ${POLICY_VISIBLE.replace(/\?1/g, "?")} ORDER BY x.period_start DESC`,
            )
            .bind(user.email),
        db
            .prepare(
                `SELECT f.policy_id, COUNT(*) AS n FROM asset_files f JOIN asset_policies p ON p.id = f.policy_id AND ${POLICY_VISIBLE.replace(/\?1/g, "?")} WHERE f.status = 'stored' GROUP BY f.policy_id`,
            )
            .bind(user.email),
    ]);
    const names = await namesFor(
        db,
        rows.results.map((r) => r.owner_email),
    );
    const linkRows = links.results as { policy_id: string; asset_id: string; agreed_value_cents: number | null }[];
    const premiumRows = premiums.results as {
        policy_id: string;
        period_start: string;
        premium_cents: number;
        payment_frequency: PolicyView["paymentFrequency"];
    }[];
    const fileRows = new Map((files.results as { policy_id: string; n: number }[]).map((f) => [f.policy_id, f.n]));
    return rows.results
        .filter((r) => policyIds.includes(r.id))
        .map((r): PolicyView => {
            const mine = linkRows.filter((l) => l.policy_id === r.id);
            const shown = mine.filter((l) => visible.has(l.asset_id));
            return {
                id: r.id,
                provider: r.provider,
                policyType: r.policy_type as PolicyView["policyType"],
                name: r.name,
                reference: r.reference,
                startsOn: r.starts_on,
                renewsOn: r.renews_on,
                premiumCents: r.premium_cents,
                paymentFrequency: r.payment_frequency as PolicyView["paymentFrequency"],
                excessCents: r.excess_cents,
                coverageSummary: r.coverage_summary,
                coverageLimits: r.coverage_limits,
                exclusions: r.exclusions,
                contactPhone: r.contact_phone,
                contactEmail: r.contact_email,
                contactUrl: r.contact_url,
                notes: r.notes,
                status: r.status as PolicyView["status"],
                previousId: r.previous_id,
                unverifiedFields: parseJson<string[]>(r.unverified_fields, []),
                verified: r.verified_at && r.verified_by ? { at: r.verified_at, by: r.verified_by } : null,
                shared: !!r.shared,
                householdCanEdit: !!r.household_can_edit,
                mine: r.owner_email === user.email,
                canEdit: canEditPolicy(r, user.email),
                owner: { email: r.owner_email, name: names.get(r.owner_email.toLowerCase()) ?? null },
                assets: shown.map((l) => ({
                    id: l.asset_id,
                    name: visible.get(l.asset_id)!.name,
                    agreedValueCents: rightsOf(visible.get(l.asset_id)!).financial ? l.agreed_value_cents : null,
                })),
                hiddenAssetCount: mine.length - shown.length,
                premiums: premiumRows
                    .filter((p) => p.policy_id === r.id)
                    .map((p) => ({ periodStart: p.period_start, premiumCents: p.premium_cents, paymentFrequency: p.payment_frequency })),
                fileCount: fileRows.get(r.id) ?? 0,
                version: r.version,
            };
        });
}

export async function policyView(db: D1Database, user: PortalUser, id: string): Promise<PolicyView> {
    await requirePolicy(db, user, id);
    return (await listPolicies(db, user, [id]))[0];
}

/** A period's premium for the history, once per period start. */
const premiumStatement = (db: D1Database, user: PortalUser, policyId: string, periodStart: string | null, cents: number | null, frequency: string | null) =>
    periodStart && cents !== null
        ? [
              db
                  .prepare(
                      `INSERT INTO asset_policy_premiums (id, policy_id, period_start, premium_cents, payment_frequency, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT (policy_id, period_start) DO UPDATE SET premium_cents = excluded.premium_cents, payment_frequency = excluded.payment_frequency`,
                  )
                  .bind(newId("aprm"), policyId, periodStart, cents, frequency, user.email, nowIso()),
          ]
        : [];

export async function createPolicy(db: D1Database, user: PortalUser, input: unknown): Promise<PolicyView> {
    const raw = (input ?? {}) as Record<string, unknown>;
    const fileIds = Array.isArray(raw.fileIds)
        ? (raw.fileIds as unknown[]).filter((f): f is string => typeof f === "string" && /^afl_[a-z0-9]{14}$/.test(f)).slice(0, 10)
        : [];
    const { fileIds: _ignored, ...rest } = raw;
    const body = policyInput.parse(rest) as Record<string, unknown>;
    if (body.previousId) await requirePolicy(db, user, body.previousId as string);
    if (body.householdCanEdit && !body.shared) throw new HttpError(422, "validation", "Share the policy with the household before letting them edit it");
    const id = newId("aip");
    const now = nowIso();
    const columns = Object.keys(COLUMNS).filter((k) => body[k] !== undefined);
    await db.batch([
        db
            .prepare(
                `INSERT INTO asset_policies (id, owner_email, ${columns.map((k) => COLUMNS[k]).join(", ")}, unverified_fields, shared, household_can_edit, created_by, created_at, updated_by, updated_at)
                 VALUES (?, ?, ${columns.map(() => "?").join(", ")}, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
                id,
                user.email,
                ...columns.map((k) => body[k] ?? null),
                JSON.stringify(body.unverifiedFields ?? []),
                body.shared ? 1 : 0,
                body.householdCanEdit ? 1 : 0,
                user.email,
                now,
                user.email,
                now,
            ),
        ...premiumStatement(db, user, id, (body.startsOn as string) ?? null, (body.premiumCents as number) ?? null, (body.paymentFrequency as string) ?? null),
        ...(body.previousId
            ? [db.prepare("UPDATE asset_policies SET status = 'replaced', updated_at = ? WHERE id = ? AND status = 'active'").bind(now, body.previousId)]
            : []),
        ...claimInboxFiles(db, user, fileIds, "policy_id", id),
        activity(db, { actor: user.email, action: "policy.create", entityType: "policy", entityId: id }),
    ]);
    return policyView(db, user, id);
}

export async function updatePolicy(db: D1Database, user: PortalUser, id: string, input: unknown): Promise<PolicyView> {
    const body = updatePolicyInput.parse(input) as Record<string, unknown> & { version: number };
    const row = await requirePolicy(db, user, id, true);
    // Only the owner decides who else sees the policy.
    if ((body.shared !== undefined || body.householdCanEdit !== undefined) && row.owner_email !== user.email)
        throw new HttpError(403, "forbidden", "Only the policy's owner can change who can see it");
    const shared = body.shared === undefined ? !!row.shared : (body.shared as boolean);
    const canEdit = body.householdCanEdit === undefined ? !!row.household_can_edit && shared : (body.householdCanEdit as boolean);
    if (canEdit && !shared) throw new HttpError(422, "validation", "Share the policy with the household before letting them edit it");
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(COLUMNS))
        if (body[key] !== undefined) {
            sets.push(`${column} = ?`);
            values.push(body[key] ?? null);
        }
    sets.push("shared = ?", "household_can_edit = ?");
    values.push(shared ? 1 : 0, canEdit ? 1 : 0);
    // Changing a detail the person typed in themselves makes it verified-by-hand only if they verify again.
    const changedFacts = [
        "provider",
        "reference",
        "startsOn",
        "renewsOn",
        "premiumCents",
        "excessCents",
        "coverageSummary",
        "coverageLimits",
        "exclusions",
    ].some((k) => body[k] !== undefined);
    if (body.unverifiedFields !== undefined) {
        sets.push("unverified_fields = ?");
        values.push(JSON.stringify(body.unverifiedFields));
    }
    if (changedFacts) sets.push("verified_at = NULL", "verified_by = NULL");
    const result = await db
        .prepare(`UPDATE asset_policies SET ${[...sets, "version = version + 1", "updated_by = ?", "updated_at = ?"].join(", ")} WHERE id = ? AND version = ?`)
        .bind(...values, user.email, nowIso(), id, body.version)
        .run();
    if (!result.meta.changes) throw new HttpError(409, "conflict", "Someone changed this policy since you opened it. Reload, then try again.");
    const fresh = (await requirePolicy(db, user, id))!;
    await db.batch([
        ...premiumStatement(db, user, id, fresh.starts_on, fresh.premium_cents, fresh.payment_frequency),
        activity(db, { actor: user.email, action: "policy.update", entityType: "policy", entityId: id }),
    ]);
    return policyView(db, user, id);
}

/** A person confirms the details match the policy documents. Clears AI-suggested flags. */
export async function verifyPolicy(db: D1Database, user: PortalUser, id: string, version: unknown): Promise<PolicyView> {
    await requirePolicy(db, user, id, true);
    if (typeof version !== "number") throw new HttpError(422, "validation", "Send the version you checked");
    const result = await db
        .prepare(
            "UPDATE asset_policies SET verified_at = ?, verified_by = ?, unverified_fields = '[]', version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
        )
        .bind(nowIso(), user.email, nowIso(), id, version)
        .run();
    if (!result.meta.changes) throw new HttpError(409, "conflict", "The policy changed since you checked it. Reload and check it again.");
    await activity(db, { actor: user.email, action: "policy.verify", entityType: "policy", entityId: id }).run();
    return policyView(db, user, id);
}

/** Renewal: a new period, its premium in the history, and verification starting again. */
export async function renewPolicy(db: D1Database, user: PortalUser, id: string, input: unknown): Promise<PolicyView> {
    const body = updatePolicyInput
        .pick({ startsOn: true, renewsOn: true, premiumCents: true, paymentFrequency: true, excessCents: true, version: true })
        .strict()
        .parse(input);
    const row = await requirePolicy(db, user, id, true);
    if (!body.startsOn || !body.renewsOn) throw new HttpError(422, "validation", "Enter the new period's start and renewal dates");
    if (body.renewsOn <= body.startsOn) throw new HttpError(422, "validation", "The renewal date must be after the start");
    if (row.premium_cents !== null && row.starts_on) await db.batch(premiumStatement(db, user, id, row.starts_on, row.premium_cents, row.payment_frequency));
    const result = await db
        .prepare(
            `UPDATE asset_policies SET starts_on = ?, renews_on = ?, premium_cents = ?, payment_frequency = COALESCE(?, payment_frequency), excess_cents = COALESCE(?, excess_cents),
                status = 'active', verified_at = NULL, verified_by = NULL, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND version = ?`,
        )
        .bind(
            body.startsOn,
            body.renewsOn,
            body.premiumCents ?? null,
            body.paymentFrequency ?? null,
            body.excessCents ?? null,
            user.email,
            nowIso(),
            id,
            body.version,
        )
        .run();
    if (!result.meta.changes) throw new HttpError(409, "conflict", "Someone changed this policy since you opened it. Reload, then try again.");
    await db.batch([
        ...premiumStatement(db, user, id, body.startsOn, body.premiumCents ?? null, body.paymentFrequency ?? row.payment_frequency),
        activity(db, { actor: user.email, action: "policy.renew", entityType: "policy", entityId: id }),
    ]);
    return policyView(db, user, id);
}

export async function linkAsset(db: D1Database, user: PortalUser, policyId: string, input: unknown): Promise<PolicyView> {
    const body = (input ?? {}) as { assetId?: unknown; agreedValueCents?: unknown; note?: unknown };
    if (typeof body.assetId !== "string" || !/^ast_[a-z0-9]{14}$/.test(body.assetId)) throw new HttpError(422, "validation", "Choose an asset");
    await requirePolicy(db, user, policyId);
    const { rights } = await requireAsset(db, user, body.assetId, "edit");
    if (!rights.insurance) throw refuse("insurance");
    const agreed =
        typeof body.agreedValueCents === "number" && Number.isInteger(body.agreedValueCents) && body.agreedValueCents >= 0 ? body.agreedValueCents : null;
    if (agreed !== null && !rights.financial) throw refuse("financial");
    await db.batch([
        db
            .prepare(
                `INSERT INTO asset_policy_links (policy_id, asset_id, agreed_value_cents, note, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT (policy_id, asset_id) DO UPDATE SET agreed_value_cents = excluded.agreed_value_cents, note = excluded.note`,
            )
            .bind(policyId, body.assetId, agreed, typeof body.note === "string" ? body.note.slice(0, 300) : null, user.email, nowIso()),
        activity(db, { actor: user.email, action: "policy.link", entityType: "policy", entityId: policyId, assetId: body.assetId }),
    ]);
    return policyView(db, user, policyId);
}

export async function unlinkAsset(db: D1Database, user: PortalUser, policyId: string, assetId: string): Promise<PolicyView> {
    await requirePolicy(db, user, policyId);
    await requireAsset(db, user, assetId, "edit");
    await db.batch([
        db.prepare("DELETE FROM asset_policy_links WHERE policy_id = ? AND asset_id = ?").bind(policyId, assetId),
        activity(db, { actor: user.email, action: "policy.unlink", entityType: "policy", entityId: policyId, assetId }),
    ]);
    return policyView(db, user, policyId);
}

export async function deletePolicy(db: D1Database, user: PortalUser, id: string, confirm: unknown) {
    const row = await requirePolicy(db, user, id, true);
    if (row.owner_email !== user.email) throw new HttpError(403, "forbidden", "Only the policy's owner can delete it");
    if (confirm !== "DELETE") throw new HttpError(422, "validation", "Type DELETE to confirm");
    await db.batch([
        db
            .prepare("UPDATE asset_files SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE policy_id = ? AND status = 'stored'")
            .bind(nowIso(), nowIso(), id),
        db.prepare("DELETE FROM asset_policies WHERE id = ?").bind(id),
        activity(db, { actor: user.email, action: "policy.delete", entityType: "policy", entityId: id }),
    ]);
}

/** Policies linked to one asset, for its page (only when the caller can see its insurance). */
export async function policiesForAsset(db: D1Database, user: PortalUser, assetId: string): Promise<PolicyView[]> {
    const ids = await db.prepare("SELECT policy_id FROM asset_policy_links WHERE asset_id = ? LIMIT 50").bind(assetId).all<{ policy_id: string }>();
    if (!ids.results.length) return [];
    return listPolicies(
        db,
        user,
        ids.results.map((r) => r.policy_id),
    );
}

export const policyToday = async (db: D1Database, user: PortalUser) => (await clockFor(db, user.email)).today;
