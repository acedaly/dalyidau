// Home & Assets: the register, vehicles, maintenance, insurance, warranties, places, sharing,
// files and QR labels, through the portal API with real (local) D1 and R2. See docs/HOME_ASSETS.md.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { parseAssetAddress } from "../src/shared/assets/address";
import { dueState, formulaValue, nextDue, warrantyExpiry } from "../src/shared/assets/engine";
import { BUILTIN_TEMPLATES } from "../src/shared/assets/templates";
import type { AssetSummary, LocationView, MaintenanceView, ScheduleView, WarrantyView } from "../src/shared/assets/types";
import { sniff, stripJpeg, stripPng } from "../worker/assets/files";
import type { Env } from "../worker/env";
import {
    A,
    ADMIN,
    B,
    NONE,
    WEDDING_EDITOR,
    activity,
    addPortalUser,
    call,
    createAsset,
    decodeQrSvg,
    detail,
    jpeg,
    pdf,
    plusDays,
    policy,
    record,
    schedule,
    share,
    sydneyToday,
    upload,
} from "./assets-helpers";
import { accessToken, db, call as rawCall, resetPortal } from "./portal-helpers";

beforeEach(resetPortal);
const media = () => (env as unknown as Env).MEDIA;

describe("who can open Home & Assets", () => {
    it("is for owners and admins; other portal roles are refused, and so is anyone without a token", async () => {
        await addPortalUser(ADMIN, "admin");
        await addPortalUser(WEDDING_EDITOR, "editor");
        expect((await call("GET", "/overview", undefined, ADMIN)).status).toBe(200);
        expect((await call("GET", "/overview", undefined, WEDDING_EDITOR)).status).toBe(403);
        expect((await rawCall("/api/portal/assets/overview")).status).toBe(401);
        const page = await rawCall("/portal/assets", { token: await accessToken({ email: WEDDING_EDITOR }) });
        expect(page.status).toBe(403);
    });

    it("refuses cross-site requests, including downloads", async () => {
        const token = await accessToken({ email: A });
        const response = await rawCall("/api/portal/assets/items", { token, headers: { "Sec-Fetch-Site": "cross-site" } });
        expect(response.status).toBe(403);
    });
});

describe("asset register", () => {
    it("creates an asset from just a name and a category, private to its owner, with nothing invented", async () => {
        const asset = await createAsset({ name: "Cordless drill", category: "tools" });
        expect(asset).toMatchObject({ name: "Cordless drill", category: "tools", categoryLabel: "Tools", visibility: "private", mine: true, status: "active" });
        // Not recorded is null, never zero.
        expect(asset.purchasePriceCents).toBeNull();
        expect(asset.currentValue).toBeNull();
        expect(asset.financialHidden).toBe(false);
        expect(asset.warranty.state).toBe("none");
        expect(asset.coverage).toBe("none");
        expect(asset.needsDocuments).toEqual({ proof: true, photo: true });
        const rows = await activity();
        expect(rows).toContainEqual(expect.objectContaining({ action: "asset.create", entity_id: asset.id }));
        // History has ids and actions only.
        expect(JSON.stringify(rows)).not.toContain("Cordless drill");
    });

    it("refuses an unknown category and an empty name", async () => {
        expect((await call("POST", "/items", { name: "Thing", category: "spaceships" })).status).toBe(422);
        expect((await call("POST", "/items", { name: " ", category: "tools" })).status).toBe(422);
    });

    it("replays a retried create with the same client id instead of making two", async () => {
        const body = { name: "Fridge", category: "appliances", clientId: "create-fridge-0001" };
        const first = await createAsset(body);
        const again = await call<{ asset: AssetSummary; replayed: boolean }>("POST", "/items", body);
        expect(again.status).toBe(200);
        expect(again.json).toMatchObject({ replayed: true, asset: { id: first.id } });
        expect((await db().prepare("SELECT COUNT(*) AS n FROM assets").first<{ n: number }>())?.n).toBe(1);
    });

    it("edits with the version, and refuses a stale edit instead of overwriting it", async () => {
        const asset = await createAsset({ name: "TV", category: "electronics" });
        const edited = await call<{ asset: AssetSummary }>("PATCH", `/items/${asset.id}`, {
            version: asset.version,
            model: "X100",
            purchasePriceCents: 129900,
        });
        expect(edited.status, edited.text).toBe(200);
        expect(edited.json.asset).toMatchObject({ model: "X100", purchasePriceCents: 129900, version: asset.version + 1 });
        const stale = await call("PATCH", `/items/${asset.id}`, { version: asset.version, model: "Y200" });
        expect(stale.status).toBe(409);
        expect((await detail(asset.id)).asset.model).toBe("X100");
    });

    it("keeps custom fields only for the category's defined fields, of the right type", async () => {
        const made = await call<{ category: { id: string } }>("POST", "/categories", {
            name: "Musical instruments",
            fields: [
                { key: "strings", label: "Strings", type: "number" },
                { key: "finish", label: "Finish", type: "select", options: ["Natural", "Sunburst"] },
            ],
        });
        expect(made.status, made.text).toBe(201);
        const asset = await createAsset({ name: "Guitar", category: made.json.category.id, custom: { strings: 6, finish: "Natural" } });
        expect((await detail(asset.id)).asset.custom).toEqual({ strings: 6, finish: "Natural" });
        const bad = await call("PATCH", `/items/${asset.id}`, { version: asset.version, custom: { finish: "Purple" } });
        expect(bad.status).toBe(422);
    });

    it("bulk edits only the assets the caller may edit", async () => {
        const mine = await createAsset({ name: "Chair", category: "furniture" });
        const theirs = await createAsset({ name: "Desk", category: "furniture" }, B);
        await share(theirs.id, { visibility: "household", household: NONE }, B);
        const result = await call<{ changed: number; skipped: number }>("POST", "/items/bulk", {
            ids: [mine.id, theirs.id],
            set: { addTags: ["office"], condition: "good" },
        });
        expect(result.json).toEqual({ changed: 1, skipped: 1 });
        expect((await detail(mine.id)).asset.tags).toEqual(["office"]);
        expect((await detail(theirs.id, B)).asset.tags).toEqual([]);
    });

    it("marks sold assets with a disposal date and leaves them out of current totals", async () => {
        const asset = await createAsset({ name: "Old bike", category: "outdoor", purchasePriceCents: 50000, currentValueCents: 20000 });
        await call("PATCH", `/items/${asset.id}`, { version: asset.version, status: "sold", disposalMethod: "sold", disposalAmountCents: 15000 });
        const d = await detail(asset.id);
        expect(d.asset.disposal).toMatchObject({ method: "sold", amountCents: 15000 });
        expect(d.asset.disposal.on).toBe(sydneyToday());
        const overview = await call<{ overview: { totals: { assets: number; valueCents: number | null } } }>("GET", "/overview");
        expect(overview.json.overview.totals).toMatchObject({ assets: 0, valueCents: null });
    });

    it("deletes only for the owner, after a typed confirmation, and can be restored", async () => {
        const asset = await createAsset({ name: "Lamp", category: "furniture" });
        await share(asset.id, { visibility: "household", household: { ...NONE, edit: true, maintain: true } });
        expect((await call("DELETE", `/items/${asset.id}`, { confirm: "DELETE" }, B)).status).toBe(403);
        expect((await call("DELETE", `/items/${asset.id}`, {})).status).toBe(422);
        expect((await call("DELETE", `/items/${asset.id}`, { confirm: "DELETE" })).status).toBe(200);
        expect((await call("GET", `/items/${asset.id}`)).status).toBe(404);
        expect((await call("POST", `/items/${asset.id}/restore`)).status).toBe(200);
        expect((await call("GET", `/items/${asset.id}`)).status).toBe(200);
    });
});

describe("values", () => {
    it("labels every value with where it came from, and applies a depreciation model only when the person turns one on", async () => {
        const asset = await createAsset({ name: "Laptop", category: "computers", purchasePriceCents: 300000, purchaseDate: plusDays(sydneyToday(), -730) });
        expect(asset.currentValue).toBeNull();
        await call("PATCH", `/items/${asset.id}`, { version: asset.version, depreciation: { method: "straight_line", years: 4, residualPercent: 0 } });
        const formula = (await detail(asset.id)).asset.currentValue!;
        expect(formula.basis).toBe("formula");
        expect(formula.amountCents).toBeGreaterThan(145000);
        expect(formula.amountCents).toBeLessThan(155000);
        // A person's own estimate takes precedence and keeps its label.
        const added = await call("POST", `/items/${asset.id}/valuations`, {
            kind: "current",
            basis: "user_estimate",
            amountCents: 120000,
            valuedOn: sydneyToday(),
        });
        expect(added.status, added.text).toBe(201);
        expect((await detail(asset.id)).asset.currentValue).toMatchObject({ amountCents: 120000, basis: "user_estimate" });
        // Values can't be dated in the future.
        expect(
            (
                await call("POST", `/items/${asset.id}/valuations`, {
                    kind: "current",
                    basis: "user_estimate",
                    amountCents: 1,
                    valuedOn: plusDays(sydneyToday(), 2),
                })
            ).status,
        ).toBe(422);
    });

    it("works depreciation out from the actual price and date only", () => {
        expect(formulaValue({ method: "none" }, 1000, "2020-01-01", "2026-01-01")).toBeNull();
        expect(formulaValue({ method: "diminishing", ratePercent: 20 }, null, "2020-01-01", "2026-01-01")).toBeNull();
        expect(formulaValue({ method: "diminishing", ratePercent: 50 }, 10000, "2024-01-01", "2025-01-01")?.amountCents).toBeCloseTo(5000, -2);
    });

    it("counts assets without a value instead of treating them as zero", async () => {
        await createAsset({ name: "Valued", category: "tools", currentValueCents: 10000 });
        await createAsset({ name: "Unvalued", category: "tools" });
        const { overview } = (
            await call<{
                overview: { totals: Record<string, number | null>; byCategory: { category: string; valueCents: number | null; withoutValue: number }[] };
            }>("GET", "/overview")
        ).json;
        expect(overview.totals).toMatchObject({ assets: 2, valueCents: 10000, valued: 1, unvalued: 1 });
        expect(overview.byCategory.find((c) => c.category === "tools")).toMatchObject({ valueCents: 10000, withoutValue: 1 });
    });
});

describe("vehicles and trailers", () => {
    it("records vehicle details, refuses an odometer reading lower than an earlier one unless it's a correction", async () => {
        const hilux = await createAsset({
            name: "Toyota Hilux",
            category: "vehicles",
            vehicle: {
                kind: "vehicle",
                registration: "TEST01",
                jurisdiction: "NSW",
                make: "Toyota",
                model: "Hilux",
                year: 2015,
                registrationExpiry: plusDays(sydneyToday(), 21),
            },
        });
        expect(hilux.vehicle).toMatchObject({ kind: "vehicle", registration: "TEST01", odometer: null });
        const add = (reading: number, readOn: string, correction = false) => call("POST", `/items/${hilux.id}/odometer`, { reading, readOn, correction });
        expect((await add(150000, plusDays(sydneyToday(), -30))).status).toBe(201);
        expect((await add(149000, sydneyToday())).status).toBe(422);
        expect((await add(149000, sydneyToday(), true)).status).toBe(201);
        expect((await add(151000, plusDays(sydneyToday(), 1))).status).toBe(422); // in the future
        expect((await detail(hilux.id)).vehicle?.odometer).toMatchObject({ reading: 149000 });
    });

    it("keeps trailer masses and systems", async () => {
        const camper = await createAsset({
            name: "Camper trailer",
            category: "trailers",
            vehicle: {
                kind: "trailer",
                atmKg: 1900,
                gtmKg: 1700,
                tareKg: 1300,
                ballWeightKg: 150,
                specs: { brakeSystem: "Electric", bearings: "Sealed", water: "Two tanks" },
            },
        });
        const d = await detail(camper.id);
        expect(d.vehicle).toMatchObject({ kind: "trailer", atmKg: 1900, gtmKg: 1700, tareKg: 1300, ballWeightKg: 150 });
        expect(d.vehicle?.specs).toEqual({ brakeSystem: "Electric", bearings: "Sealed", water: "Two tanks" });
        const merged = await call("PATCH", `/items/${camper.id}`, { version: d.asset.version, vehicle: { specs: { suspension: "Independent" } } });
        expect(merged.status, merged.text).toBe(200);
        expect((await detail(camper.id)).vehicle?.specs).toEqual({
            brakeSystem: "Electric",
            bearings: "Sealed",
            water: "Two tanks",
            suspension: "Independent",
        });
    });
});

describe("maintenance", () => {
    it("works out the next due date only from the interval the person set", () => {
        const rule = {
            intervalCount: 12,
            intervalUnit: "months" as const,
            intervalKm: 10000,
            firstDueOn: null,
            firstDueKm: null,
            lastDoneOn: "2026-01-31",
            lastDoneKm: 100000,
        };
        expect(nextDue(rule)).toEqual({ dueOn: "2027-01-31", dueKm: 110000 });
        expect(nextDue({ ...rule, lastDoneOn: null, lastDoneKm: null })).toEqual({ dueOn: null, dueKm: null });
        expect(nextDue({ ...rule, intervalUnit: "months", intervalCount: 1, lastDoneOn: "2026-01-31" }).dueOn).toBe("2026-02-28");
        // Whichever comes first: the distance is reached before the date.
        expect(dueState({ dueOn: "2027-01-31", dueKm: 110000, currentKm: 110500, today: "2026-10-20", soonDays: 30, soonKm: 1000 }).state).toBe("overdue");
        expect(dueState({ dueOn: null, dueKm: 110000, currentKm: null, today: "2026-10-20", soonDays: 30, soonKm: 1000 })).toMatchObject({
            state: "unknown",
            reason: expect.stringContaining("odometer"),
        });
    });

    it("offers templates without intervals, and refuses a schedule with no interval at all", async () => {
        for (const t of BUILTIN_TEMPLATES) {
            expect(t).not.toHaveProperty("intervalCount");
            expect(t.intervalSource.length).toBeGreaterThan(10);
        }
        const asset = await createAsset({ name: "Air conditioner", category: "appliances" });
        expect((await call("POST", "/schedules", { assetId: asset.id, title: "Filter clean", category: "cleaning" })).status).toBe(422);
        expect((await call("POST", "/schedules", { assetId: asset.id, title: "Filter clean", category: "cleaning", intervalCount: 3 })).status).toBe(422);
    });

    it("completing a scheduled record moves the schedule on and creates exactly one next record", async () => {
        const hilux = await createAsset({ name: "Hilux", category: "vehicles" });
        const service = await schedule({
            assetId: hilux.id,
            title: "Service",
            category: "service",
            intervalCount: 6,
            intervalUnit: "months",
            intervalKm: 10000,
            lastDoneOn: plusDays(sydneyToday(), -200),
            lastDoneKm: 140000,
            templateId: "vehicle-service",
        });
        expect(service.nextDueOn).not.toBeNull();
        expect(service.nextDueKm).toBe(150000);
        expect(service.state).toBe("overdue"); // 200 days > 6 months
        const open = await record({ assetId: hilux.id, scheduleId: service.id, title: "Service", dueOn: service.nextDueOn, dueKm: 150000 });
        // A second open record for the same schedule is a duplicate.
        expect((await call("POST", "/maintenance", { assetId: hilux.id, scheduleId: service.id, title: "Service again" })).status).toBe(409);

        const done = await call<{ record: MaintenanceView; next: MaintenanceView | null; alreadyDone: boolean }>("POST", `/maintenance/${open.id}/complete`, {
            completedOn: sydneyToday(),
            odometer: 149500,
            costCents: 45000,
        });
        expect(done.status, done.text).toBe(200);
        expect(done.json.record).toMatchObject({ status: "completed", completedOn: sydneyToday(), costCents: 45000 });
        expect(done.json.next).toMatchObject({ status: "open", dueKm: 159500 });
        const schedules = (await detail(hilux.id)).schedules as ScheduleView[];
        expect(schedules[0]).toMatchObject({ lastDoneOn: sydneyToday(), lastDoneKm: 149500, nextDueKm: 159500, openRecordId: done.json.next!.id });
        // The completion's odometer reading is recorded (a "vehicles" asset always has vehicle details).
        expect((await detail(hilux.id)).vehicle?.odometer?.reading).toBe(149500);
        // Completing again changes nothing and makes no second next record.
        const again = await call<{ alreadyDone: boolean }>("POST", `/maintenance/${open.id}/complete`, { completedOn: sydneyToday() });
        expect(again.json.alreadyDone).toBe(true);
        const openCount = await db()
            .prepare("SELECT COUNT(*) AS n FROM asset_maintenance WHERE schedule_id = ? AND status = 'open'")
            .bind(service.id)
            .first<{ n: number }>();
        expect(openCount?.n).toBe(1);
    });

    it("records problem reports, refuses completion in the future, and keeps costs from people who can't see them", async () => {
        const fridge = await createAsset({ name: "Fridge", category: "appliances" });
        await share(fridge.id, { visibility: "household", household: { ...NONE, maintain: true } });
        const problem = await call<{ record: MaintenanceView }>("POST", `/items/${fridge.id}/problem`, { title: "Not cooling", priority: "urgent" }, B);
        expect(problem.status, problem.text).toBe(201);
        expect(problem.json.record).toMatchObject({ kind: "corrective", status: "open", priority: "urgent", costHidden: true, costCents: null });
        expect((await call("POST", `/maintenance/${problem.json.record.id}/complete`, { completedOn: plusDays(sydneyToday(), 3) }, B)).status).toBe(422);
        expect((await call("POST", `/maintenance/${problem.json.record.id}/complete`, { completedOn: sydneyToday(), costCents: 100 }, B)).status).toBe(403);
        expect((await call("POST", `/maintenance/${problem.json.record.id}/complete`, { completedOn: sydneyToday() }, B)).status).toBe(200);
    });

    it("records a rental maintenance request without assuming approval", async () => {
        const home = await call<{ location: LocationView }>("POST", "/locations", {
            name: "Our rental",
            kind: "rental",
            tenure: "renting",
            managerName: "Example Realty",
        });
        const request = await record({
            locationId: home.json.location.id,
            title: "Fix the leaking tap",
            status: "requested",
            responsibility: "landlord",
            requestReference: "REQ-TEST-1",
            requestedOn: sydneyToday(),
            approval: "pending",
        });
        expect(request).toMatchObject({ status: "requested", responsibility: "landlord", approval: "pending" });
    });
});

describe("insurance", () => {
    it("never shows an asset as covered until a linked, current policy is verified by a person", async () => {
        const camper = await createAsset({ name: "Camper", category: "trailers" });
        const p = await policy({
            provider: "Example Insurance",
            policyType: "caravan_trailer",
            reference: "TEST-POLICY-1",
            startsOn: sydneyToday(),
            renewsOn: plusDays(sydneyToday(), 365),
            premiumCents: 60000,
            paymentFrequency: "annual",
        });
        expect(p.verified).toBeNull();
        expect((await call("POST", `/policies/${p.id}/assets`, { assetId: camper.id, agreedValueCents: 2500000 })).status).toBe(200);
        expect((await detail(camper.id)).asset.coverage).toBe("unverified");
        const verified = await call<{ policy: { verified: unknown; version: number } }>("POST", `/policies/${p.id}/verify`, { version: p.version });
        expect(verified.status, verified.text).toBe(200);
        expect((await detail(camper.id)).asset.coverage).toBe("verified");
        // Changing a fact undoes verification: it has to be checked again.
        const changed = await call("PATCH", `/policies/${p.id}`, { version: verified.json.policy.version, excessCents: 50000 });
        expect(changed.status, changed.text).toBe(200);
        expect((await detail(camper.id)).asset.coverage).toBe("unverified");
    });

    it("keeps premium history across renewals, for comparison", async () => {
        const p = await policy({
            provider: "Example Insurance",
            policyType: "motor",
            startsOn: "2025-11-01",
            renewsOn: "2026-11-01",
            premiumCents: 90000,
            paymentFrequency: "annual",
        });
        const renewed = await call<{ policy: { premiums: { periodStart: string; premiumCents: number }[]; renewsOn: string } }>(
            "POST",
            `/policies/${p.id}/renew`,
            {
                version: p.version,
                startsOn: "2026-11-01",
                renewsOn: "2027-11-01",
                premiumCents: 99000,
            },
        );
        expect(renewed.status, renewed.text).toBe(200);
        expect(renewed.json.policy.renewsOn).toBe("2027-11-01");
        expect(renewed.json.policy.premiums.map((x) => [x.periodStart, x.premiumCents])).toEqual([
            ["2026-11-01", 99000],
            ["2025-11-01", 90000],
        ]);
    });

    it("shows a lapsed link as lapsed, and keeps unshared policies private", async () => {
        const tv = await createAsset({ name: "TV", category: "electronics" });
        const p = await policy({ provider: "Example Insurance", policyType: "contents", renewsOn: plusDays(sydneyToday(), -5) });
        await call("POST", `/policies/${p.id}/assets`, { assetId: tv.id });
        expect((await detail(tv.id)).asset.coverage).toBe("lapsed");
        expect((await call("GET", `/policies/${p.id}`, undefined, B)).status).toBe(404);
    });
});

describe("warranties", () => {
    it("works out an end date only from a stated date, or a start (or purchase date) and stated months", async () => {
        expect(warrantyExpiry({ expiresOn: null, startsOn: null, months: 24, purchaseDate: "2025-03-31" })).toEqual({
            expiresOn: "2027-03-31",
            basis: "calculated",
        });
        expect(warrantyExpiry({ expiresOn: "2026-12-01", startsOn: null, months: 24, purchaseDate: "2025-03-31" })).toEqual({
            expiresOn: "2026-12-01",
            basis: "stated",
        });
        expect(warrantyExpiry({ expiresOn: null, startsOn: null, months: 24, purchaseDate: null })).toEqual({ expiresOn: null, basis: "unknown" });

        const drill = await createAsset({ name: "Drill", category: "tools", purchaseDate: plusDays(sydneyToday(), -700) });
        const added = await call<{ warranties: WarrantyView[] }>("POST", `/items/${drill.id}/warranties`, { kind: "manufacturer", months: 24 });
        expect(added.status, added.text).toBe(201);
        expect(added.json.warranties[0]).toMatchObject({ expiresBasis: "calculated", state: "expiring" });
        expect((await detail(drill.id)).asset.warranty.state).toBe("expiring");
    });
});

describe("household sharing and private assets", () => {
    it("hides a private asset from everyone else, including the other owner, as not found", async () => {
        const ring = await createAsset({ name: "Engagement ring", category: "valuables", purchasePriceCents: 500000 });
        expect((await call("GET", `/items/${ring.id}`, undefined, B)).status).toBe(404);
        expect((await call("PATCH", `/items/${ring.id}`, { version: 1, name: "x" }, B)).status).toBe(404);
        const list = await call<{ assets: AssetSummary[] }>("GET", "/items", undefined, B);
        expect(list.json.assets).toEqual([]);
        const search = await call<{ results: { assets: AssetSummary[] } }>("GET", "/search?q=ring", undefined, B);
        expect(search.json.results.assets).toEqual([]);
    });

    it("shares with the household for viewing without sharing values, insurance or documents", async () => {
        const tv = await createAsset({ name: "Television", category: "electronics", purchasePriceCents: 200000, currentValueCents: 150000 });
        await upload({ assetId: tv.id, kind: "receipt", filename: "receipt.pdf", bytes: pdf("Receipt for a television") });
        await share(tv.id, { visibility: "household", household: NONE });
        const seen = await detail(tv.id, B);
        expect(seen.asset).toMatchObject({
            purchasePriceCents: null,
            currentValue: null,
            financialHidden: true,
            coverage: "hidden",
            needsDocuments: null,
            mine: false,
        });
        expect(seen.valuations).toBeNull();
        expect(seen.policies).toBeNull();
        expect(seen.files).toEqual([]);
        expect(seen.documentsHidden).toBe(1);
        expect(seen.sharing).toBeNull();
        expect((await call("PATCH", `/items/${tv.id}`, { version: seen.asset.version, name: "Mine now" }, B)).status).toBe(403);
    });

    it("gives selected people exactly the rights chosen", async () => {
        await addPortalUser(ADMIN, "admin");
        const tools = await createAsset({ name: "Mitre saw", category: "tools", purchasePriceCents: 40000 });
        await share(tools.id, { visibility: "selected", people: [{ email: ADMIN, ...NONE, financial: true, maintain: true }] });
        expect((await detail(tools.id, ADMIN)).asset).toMatchObject({ purchasePriceCents: 40000, rights: { maintain: true, edit: false, financial: true } });
        expect((await call("GET", `/items/${tools.id}`, undefined, B)).status).toBe(404);
        // Only people who can open Home & Assets can be given an asset.
        await addPortalUser(WEDDING_EDITOR, "editor");
        const refused = await call("PUT", `/items/${tools.id}/sharing`, {
            version: (await detail(tools.id)).asset.version,
            visibility: "selected",
            people: [{ email: WEDDING_EDITOR, ...NONE }],
        });
        expect(refused.status).toBe(422);
        // Only the owner can change sharing.
        expect((await call("PUT", `/items/${tools.id}/sharing`, { version: 99, visibility: "private" }, ADMIN)).status).toBe(403);
    });

    it("keeps a private place private even when an asset in it is shared", async () => {
        const shed = await call<{ location: LocationView }>("POST", "/locations", { name: "Back shed", kind: "shed", address: "1 Example Street" });
        const mower = await createAsset({ name: "Mower", category: "outdoor", locationId: shed.json.location.id });
        await share(mower.id, { visibility: "household", household: NONE });
        expect((await detail(mower.id, B)).asset).toMatchObject({ location: null, locationHidden: true });
        expect((await call("GET", `/locations/${shed.json.location.id}`, undefined, B)).status).toBe(404);
        // Once the place is shared, it shows.
        await call("PATCH", `/locations/${shed.json.location.id}`, { version: shed.json.location.version, visibility: "household" });
        expect((await detail(mower.id, B)).asset.location?.name).toBe("Back shed");
    });
});

describe("files and photos", () => {
    it("stores photos without location or camera metadata, under an unguessable private key", async () => {
        const drill = await createAsset({ name: "Drill", category: "tools" });
        const uploaded = await upload({
            assetId: drill.id,
            bytes: jpeg({ description: "A photo of a cordless drill." }),
            thumb: btoa(String.fromCharCode(...jpeg({ width: 120, height: 90 }))),
        });
        expect(uploaded.status, uploaded.text).toBe(201);
        expect(uploaded.json.file).toMatchObject({ kind: "photo", contentType: "image/jpeg", width: 640 });
        const row = await db()
            .prepare("SELECT r2_key, thumb_key FROM asset_files WHERE id = ?")
            .bind(uploaded.json.file.id)
            .first<{ r2_key: string; thumb_key: string }>();
        expect(row?.r2_key).toMatch(/^private\/assets\/afl_[a-z0-9]{14}\/[0-9a-f]{32}$/);
        const stored = new TextDecoder("latin1").decode(await (await media().get(row!.r2_key))!.arrayBuffer());
        expect(stored).not.toContain("GPSLatitude");
        expect(stored).not.toContain("Exif");
        expect(stored).toContain("cordless drill"); // other segments are untouched
        const thumb = new TextDecoder("latin1").decode(await (await media().get(row!.thumb_key))!.arrayBuffer());
        expect(thumb).not.toContain("GPSLatitude");
        // The first photo becomes the cover.
        expect((await detail(drill.id)).asset.coverFileId).toBe(uploaded.json.file.id);
    });

    it("checks files by their bytes, not their names, and refuses SVG, HTML and HEIC", async () => {
        const drill = await createAsset({ name: "Drill", category: "tools" });
        const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
        const html = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");
        const heic = new Uint8Array([0, 0, 0, 24, ...[..."ftypheic"].map((c) => c.charCodeAt(0)), 0, 0, 0, 0]);
        for (const [bytes, filename] of [
            [svg, "photo.jpg"],
            [html, "manual.txt"],
            [heic, "IMG_0001.jpg"],
        ] as const) {
            const result = await upload({ assetId: drill.id, kind: "manual", filename, bytes });
            expect(result.status, filename).toBe(422);
        }
        // A PDF named .jpg is stored as a PDF, and can't be a photo.
        expect((await upload({ assetId: drill.id, kind: "photo", filename: "x.jpg", bytes: pdf("hello") })).status).toBe(422);
        const manual = await upload({ assetId: drill.id, kind: "manual", filename: "manual.jpg", bytes: pdf("Owner's manual") });
        expect(manual.status, manual.text).toBe(201);
        expect(manual.json.file).toMatchObject({ contentType: "application/pdf", filename: "manual.pdf" });
        expect(sniff(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toMatchObject({ type: "application/zip" });
    });

    it("recognises the same file added twice to one asset and doesn't store it again", async () => {
        const drill = await createAsset({ name: "Drill", category: "tools" });
        const bytes = pdf("Receipt 123");
        const first = await upload({ assetId: drill.id, kind: "receipt", filename: "r.pdf", bytes });
        const second = await upload({ assetId: drill.id, kind: "receipt", filename: "again.pdf", bytes });
        expect(second.status).toBe(201);
        expect(second.json).toMatchObject({ duplicate: true, file: { id: first.json.file.id } });
        expect((await db().prepare("SELECT COUNT(*) AS n FROM asset_files").first<{ n: number }>())?.n).toBe(1);
        // On another asset it's stored, with a note of where else it is.
        const saw = await createAsset({ name: "Saw", category: "tools" });
        const elsewhere = await upload({ assetId: saw.id, kind: "receipt", filename: "r.pdf", bytes });
        expect(elsewhere.json.alsoOn).toEqual([{ assetId: drill.id, name: "Drill" }]);
    });

    it("serves files only after the record's own checks, as private downloads that are never rendered", async () => {
        const drill = await createAsset({ name: "Drill", category: "tools" });
        const doc = await upload({ assetId: drill.id, kind: "invoice", filename: "invoice.pdf", bytes: pdf("Invoice") });
        const photo = await upload({ assetId: drill.id, bytes: jpeg() });
        const get = async (id: string, email: string) => rawCall(`/api/portal/assets/files/${id}/content`, { token: await accessToken({ email }) });
        const own = await get(doc.json.file.id, A);
        expect(own.status).toBe(200);
        expect(own.headers.get("Content-Disposition")).toMatch(/^attachment;/);
        expect(own.headers.get("X-Content-Type-Options")).toBe("nosniff");
        expect(own.headers.get("Content-Security-Policy")).toContain("sandbox");
        expect(own.headers.get("Cache-Control")).toContain("no-store");
        expect((await get(photo.json.file.id, A)).headers.get("Content-Disposition")).toMatch(/^inline;/);
        // Not shared: not found. Shared without documents: photos only.
        expect((await get(doc.json.file.id, B)).status).toBe(404);
        await share(drill.id, { visibility: "household", household: NONE });
        expect((await get(doc.json.file.id, B)).status).toBe(404);
        expect((await get(photo.json.file.id, B)).status).toBe(200);
        // A file in someone's capture inbox is theirs alone.
        const inbox = await upload({ kind: "receipt", filename: "r.pdf", bytes: pdf("Inbox receipt") });
        expect((await get(inbox.json.file.id, B)).status).toBe(404);
    });

    it("deleting a file removes it from R2 at once", async () => {
        const drill = await createAsset({ name: "Drill", category: "tools" });
        const photo = await upload({ assetId: drill.id, bytes: jpeg() });
        const key = (await db().prepare("SELECT r2_key FROM asset_files WHERE id = ?").bind(photo.json.file.id).first<{ r2_key: string }>())!.r2_key;
        expect((await call("DELETE", `/files/${photo.json.file.id}`)).status).toBe(200);
        expect(await media().get(key)).toBeNull();
        expect((await detail(drill.id)).asset.coverFileId).toBeNull();
    });

    it("strips PNG text chunks too", () => {
        const chunk = (type: string, data: number[]) => {
            const out = new Uint8Array(12 + data.length);
            new DataView(out.buffer).setUint32(0, data.length);
            out.set(
                [...type].map((c) => c.charCodeAt(0)),
                4,
            );
            out.set(data, 8);
            return [...out];
        };
        const png = new Uint8Array([
            0x89,
            0x50,
            0x4e,
            0x47,
            0x0d,
            0x0a,
            0x1a,
            0x0a,
            ...chunk("IHDR", Array(13).fill(0)),
            ...chunk("tEXt", [...new TextEncoder().encode("Location secret")]),
            ...chunk("IEND", []),
        ]);
        expect(new TextDecoder("latin1").decode(stripPng(png))).not.toContain("secret");
        expect(stripJpeg(new Uint8Array([1, 2, 3]))).toEqual(new Uint8Array([1, 2, 3]));
    });
});

describe("QR labels", () => {
    it("encodes only the asset's portal address, which still needs sign-in and access to open", async () => {
        const drill = await createAsset({ name: "Drill", category: "tools", serialNumber: "SN-TEST-123" });
        const svg = await call("GET", `/items/${drill.id}/qr.svg`);
        expect(svg.status).toBe(200);
        expect(svg.headers.get("Content-Type")).toBe("image/svg+xml");
        const decoded = decodeQrSvg(svg.text);
        expect(decoded).toBe(`https://daly.id.au/portal/assets/item/${drill.id}?v=1`);
        expect(decoded).not.toContain("SN-TEST");
        expect((await call("GET", `/items/${drill.id}/qr.svg`, undefined, B)).status).toBe(404);
        // Opening the address without a token is refused, and as someone without access it's a 404 page.
        expect((await rawCall(`/portal/assets/item/${drill.id}`)).status).toBe(401);
        expect((await rawCall(`/portal/assets/item/${drill.id}`, { token: await accessToken({ email: B }) })).status).toBe(404);
        expect((await rawCall(`/portal/assets/item/${drill.id}?v=1`, { token: await accessToken({ email: A }) })).status).toBe(200);
    });

    it("regenerates a label without changing the asset's id", async () => {
        const drill = await createAsset({ name: "Drill", category: "tools" });
        const regenerated = await call<{ labelVersion: number }>("POST", `/items/${drill.id}/label`);
        expect(regenerated.json.labelVersion).toBe(2);
        expect(decodeQrSvg((await call("GET", `/items/${drill.id}/qr.svg`)).text)).toBe(`https://daly.id.au/portal/assets/item/${drill.id}?v=2`);
        expect((await detail(drill.id)).asset.id).toBe(drill.id);
    });

    it("recognises only this portal's asset addresses when a code is scanned", () => {
        expect(parseAssetAddress("https://daly.id.au/portal/assets/item/ast_abcdefghjkmnpq?v=3", "https://daly.id.au")).toEqual({
            id: "ast_abcdefghjkmnpq",
            labelVersion: 3,
        });
        expect(parseAssetAddress("https://evil.example/portal/assets/item/ast_abcdefghjkmnpq", "https://daly.id.au")).toBeNull();
        expect(parseAssetAddress("javascript:alert(1)", "https://daly.id.au")).toBeNull();
        expect(parseAssetAddress("https://daly.id.au/portal/tasks/t/tsk_abcdefghjkmnpq", "https://daly.id.au")).toBeNull();
    });
});

describe("the portal pages", () => {
    it("renders every section for its owner, and a 404 for a place they can't see", async () => {
        const token = await accessToken({ email: A });
        const asset = await createAsset({ name: "Drill", category: "tools" });
        const place = await call<{ location: LocationView }>("POST", "/locations", { name: "Garage", kind: "garage" });
        for (const path of [
            "/portal/assets",
            "/portal/assets/all",
            "/portal/assets/vehicles",
            "/portal/assets/property",
            `/portal/assets/property/${place.json.location.id}`,
            "/portal/assets/maintenance",
            "/portal/assets/maintenance?view=schedules",
            "/portal/assets/insurance",
            "/portal/assets/warranties",
            "/portal/assets/documents",
            "/portal/assets/reports",
            "/portal/assets/reports/register",
            `/portal/assets/reports/register?kind=claim&assets=${asset.id}`,
            "/portal/assets/settings",
            "/portal/assets/capture",
            "/portal/assets/labels",
            "/portal/assets/search?q=drill",
            `/portal/assets/item/${asset.id}`,
        ]) {
            const response = await rawCall(path, { token });
            expect(response.status, path).toBe(200);
            expect(response.headers.get("Cache-Control"), path).toContain("no-store");
        }
        expect((await rawCall(`/portal/assets/property/${place.json.location.id}`, { token: await accessToken({ email: B }) })).status).toBe(404);
    });

    it("lists Home & Assets on the launcher for people who can open it", async () => {
        const page = await rawCall("/portal", { token: await accessToken({ email: A }) });
        expect(await page.text()).toContain('"assets"');
    });
});
