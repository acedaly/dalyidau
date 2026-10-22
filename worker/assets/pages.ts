// First-render data for Home & Assets' pages (/portal/assets/*). The portal page router has already
// checked "assets.use". Anything the caller can't see returns null (the 404 page): someone else's
// private asset, place or policy, an unknown id.
import { filtersFromQuery } from "../../src/shared/assets/filters";
import type { AssetsRoute, AssetsShell } from "../../src/shared/assets/types";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { can } from "../portal/auth";
import { isEnabled } from "../portal/flags";
import { HttpError } from "../portal/http";
import { assetPreferences, clockFor } from "./access";
import { listAssets, viewContext } from "./assets";
import { captureStatus } from "./capture";
import { listCategories } from "./catalog";
import { overview } from "./dashboard";
import { assetDetail } from "./detail";
import { filesFor, listFiles, retentionDue } from "./files";
import { listPolicies } from "./insurance";
import { listLocations, locationView } from "./locations";
import { builtinTemplates, listMaintenance, listSchedules, listTemplates, targetsFor } from "./maintenance";
import { searchAll } from "./search";
import { listClaims, listWarranties } from "./warranties";

export type AssetsPage =
    | "overview"
    | "all"
    | "vehicles"
    | "item"
    | "property"
    | "location"
    | "maintenance"
    | "insurance"
    | "warranties"
    | "documents"
    | "reports"
    | "register"
    | "settings"
    | "capture"
    | "labels"
    | "search";

async function shell(env: Env, user: PortalUser): Promise<AssetsShell> {
    const [ai, prefs, categories, locations, clock, emailOn] = await Promise.all([
        captureStatus(env, env.DB),
        assetPreferences(env.DB, user.email),
        listCategories(env.DB),
        listLocations(env.DB, user),
        clockFor(env.DB, user.email),
        isEnabled(env.DB, "assets.reminders.email"),
    ]);
    const unread = await env.DB.prepare("SELECT COUNT(*) AS n FROM asset_notifications WHERE email = ? AND dismissed_at IS NULL AND fire_on <= ?")
        .bind(user.email, clock.today)
        .first<{ n: number }>();
    return {
        canAi: ai.available,
        aiNote: ai.reason,
        preferences: prefs.preferences,
        preferencesVersion: prefs.version,
        categories,
        locations: locations.map((l) => ({ id: l.id, name: l.name, kind: l.kind })),
        unreadNotifications: unread?.n ?? 0,
        emailOn,
        canCalendar: can(user, "calendar.use"),
        today: clock.today,
    };
}

const notVisible = (error: unknown) => {
    if (error instanceof HttpError && (error.status === 404 || error.status === 422)) return null;
    throw error;
};

const pick = (assets: { id: string; name: string }[]) => assets.map((a) => ({ id: a.id, name: a.name }));

export async function loadAssetsPage(env: Env, user: PortalUser, url: URL, page: AssetsPage, id?: string): Promise<AssetsRoute | null> {
    const base = await shell(env, user);
    const db = env.DB;
    switch (page) {
        case "overview":
            return { route: "assets-overview", ...base, overview: await overview(env, db, user) };
        case "all":
        case "vehicles": {
            const { assets, truncated } = await listAssets(db, user);
            const filters = filtersFromQuery(url.searchParams);
            if (page === "vehicles") filters.group = "vehicles";
            return { route: "assets-list", ...base, section: page, assets, truncated, filters };
        }
        case "item": {
            const detail = await assetDetail(db, user, id!).catch(notVisible);
            if (!detail) return null;
            const v = Number(url.searchParams.get("v"));
            return {
                route: "assets-item",
                ...base,
                detail,
                tab: url.searchParams.get("tab") ?? "overview",
                labelVersionScanned: Number.isInteger(v) && v > 0 ? v : null,
            };
        }
        case "property": {
            const targets = await targetsFor(db, user);
            const [locations, maintenance, schedules] = await Promise.all([
                listLocations(db, user, { includeArchived: url.searchParams.get("archived") === "1" }),
                listMaintenance(db, user, { scope: "open" }, targets),
                listSchedules(db, user, {}, targets),
            ]);
            return {
                route: "assets-property",
                ...base,
                places: locations,
                maintenance: maintenance.filter((m) => m.locationId),
                schedules: schedules.filter((s) => s.locationId),
            };
        }
        case "location": {
            const location = await locationView(db, user, id!).catch(notVisible);
            if (!location) return null;
            const targets = await targetsFor(db, user);
            const [{ assets }, maintenance, schedules, files] = await Promise.all([
                listAssets(db, user),
                listMaintenance(db, user, { locationId: id, scope: "all", limit: 300 }, targets),
                listSchedules(db, user, { locationId: id }, targets),
                filesFor(db, user, "location_id", id!),
            ]);
            return { route: "assets-location", ...base, location, assets: assets.filter((a) => a.location?.id === id), maintenance, schedules, files };
        }
        case "maintenance": {
            const view = url.searchParams.get("view");
            const chosen = view === "open" || view === "history" || view === "schedules" || view === "templates" ? view : "upcoming";
            const targets = await targetsFor(db, user);
            const [maintenance, schedules, household] = await Promise.all([
                listMaintenance(db, user, { scope: chosen === "history" ? "history" : "open", limit: 1000 }, targets),
                listSchedules(db, user, {}, targets),
                listTemplates(db),
            ]);
            return {
                route: "assets-maintenance",
                ...base,
                view: chosen,
                maintenance,
                schedules,
                templates: { builtin: builtinTemplates(), household },
                targets: [...targets.values()].filter((t) => t.maintain).map((t) => ({ id: t.id, name: t.name, kind: t.kind })),
            };
        }
        case "insurance": {
            const ctx = await viewContext(db, user);
            const [policies, { assets }, claims] = await Promise.all([listPolicies(db, user), listAssets(db, user, ctx), listClaims(db, user)]);
            return {
                route: "assets-insurance",
                ...base,
                policies,
                coverage: assets
                    .filter((a) => a.coverage !== "hidden" && !["sold", "disposed", "gifted"].includes(a.status))
                    .map((a) => ({ asset: { id: a.id, name: a.name, categoryLabel: a.categoryLabel }, state: a.coverage })),
                claims: claims.filter((c) => c.kind === "insurance"),
                assets: pick(assets.filter((a) => a.rights.edit && a.rights.insurance)),
            };
        }
        case "warranties": {
            const [warranties, claims, { assets }] = await Promise.all([listWarranties(db, user), listClaims(db, user), listAssets(db, user)]);
            return {
                route: "assets-warranties",
                ...base,
                warranties,
                claims: claims.filter((c) => c.kind !== "insurance"),
                assets: pick(assets.filter((a) => a.rights.edit)),
            };
        }
        case "documents": {
            const [{ files, inbox }, { assets }, retention] = await Promise.all([listFiles(db, user), listAssets(db, user), retentionDue(db, user)]);
            return {
                route: "assets-documents",
                ...base,
                files,
                inbox,
                needsDocuments: assets.filter(
                    (a) => a.needsDocuments && (a.needsDocuments.proof || a.needsDocuments.photo) && !["sold", "disposed", "gifted"].includes(a.status),
                ),
                retentionDue: retention,
                assets: pick(assets.filter((a) => a.rights.edit)),
            };
        }
        case "reports": {
            const { assets } = await listAssets(db, user);
            return { route: "assets-reports", ...base, assets: assets.map((a) => ({ id: a.id, name: a.name, locationName: a.location?.name ?? null })) };
        }
        case "register": {
            const kind = url.searchParams.get("kind") === "claim" ? "claim" : url.searchParams.get("kind") === "inventory" ? "inventory" : "household";
            const { assets } = await listAssets(db, user);
            const ids = new Set((url.searchParams.get("assets") ?? "").split(",").filter((x) => /^ast_[a-z0-9]{14}$/.test(x)));
            const chosen =
                kind === "claim" ? assets.filter((a) => ids.has(a.id)).slice(0, 50) : assets.filter((a) => !["sold", "disposed", "gifted"].includes(a.status));
            const details = kind === "claim" ? await Promise.all(chosen.map((a) => assetDetail(db, user, a.id))) : [];
            await db
                .prepare("INSERT INTO asset_activity (at, actor, action, entity_type, via) VALUES (?, ?, ?, 'export', 'portal')")
                .bind(new Date().toISOString(), user.email, `print.${kind}`)
                .run();
            return { route: "assets-register", ...base, kind, assets: chosen, details, generatedAt: new Date().toISOString() };
        }
        case "settings":
            return { route: "assets-settings", ...base, templates: await listTemplates(db) };
        case "capture": {
            const mode = url.searchParams.get("mode");
            const { inbox } = await listFiles(db, user);
            return { route: "assets-capture", ...base, inbox, mode: mode === "photo" || mode === "receipt" || mode === "scan" ? mode : "quick" };
        }
        case "labels": {
            const { assets } = await listAssets(db, user);
            const ids = new Set((url.searchParams.get("ids") ?? "").split(",").filter(Boolean));
            const chosen = ids.size ? assets.filter((a) => ids.has(a.id)) : assets.filter((a) => !["sold", "disposed", "gifted"].includes(a.status));
            const versions = new Map(
                (
                    await db
                        .prepare(
                            "SELECT id, label_version FROM assets WHERE owner_email = ? OR id IN (SELECT asset_id FROM asset_shares WHERE email IN (?, '*'))",
                        )
                        .bind(user.email, user.email)
                        .all<{ id: string; label_version: number }>()
                ).results.map((r) => [r.id, r.label_version]),
            );
            return {
                route: "assets-labels",
                ...base,
                assets: chosen.slice(0, 200).map((a) => ({ id: a.id, name: a.name, labelVersion: versions.get(a.id) ?? 1, categoryLabel: a.categoryLabel })),
            };
        }
        case "search": {
            const q = (url.searchParams.get("q") ?? "").slice(0, 100);
            return { route: "assets-search", ...base, q, results: await searchAll(db, user, q) };
        }
    }
}
