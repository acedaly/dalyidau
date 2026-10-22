// Home & Assets with the rest of the portal: Daly Calendar, Today, the Chief of Staff, MCP, reminders
// and email, optional AI, reports, the migration and clean-up, and what's left of the retired Daly
// Tasks and Daly Knowledge links.
// Models are never called: the AI tests use the deterministic stand-in (worker/intelligence/bindings.ts).
import { beforeEach, describe, expect, it } from "vitest";
import type { AttentionItem, MaintenanceView, PhotoProposal, PolicyProposal, ReceiptProposal } from "../src/shared/assets/types";
import type { Overlays } from "../src/shared/calendar/types";
import { purgeDeletedAssets } from "../worker/assets/files";
import { processAssetReminders } from "../worker/assets/notify";
import type { EmailProvider, OutgoingEmail } from "../worker/comms/providers";
import type { Env } from "../worker/env";
import { handleMcpCall } from "../worker/mcp/entrypoint";
import {
    A,
    ADMIN,
    B,
    NONE,
    addPortalUser,
    call,
    createAsset,
    detail,
    jpeg,
    pdf,
    plusDays,
    record,
    schedule,
    share,
    sydneyToday,
    upload,
} from "./assets-helpers";
import { aiEnv, configure } from "./intelligence-helpers";
import { accessToken, apiCall, db, portalEnv, resetPortal } from "./portal-helpers";

beforeEach(resetPortal);

const MCP_AUD = "aud-mcp-gateway-0123456789abcdef";
async function mcp(tool: string, input: unknown = {}, email = A, env?: Env) {
    const assertion = await accessToken({ email, aud: [MCP_AUD] });
    return handleMcpCall(env ?? (await portalEnv({ MCP_ACCESS_AUD: MCP_AUD })), { assertion, tool, input });
}

const attention = async (email = A, days = 30) =>
    (await call<{ overview: { attention: AttentionItem[] } }>("GET", "/overview", undefined, email)).json.overview.attention.filter(
        (i) => i.daysAway === null || i.daysAway <= days,
    );

describe("Daly Tasks and Daly Knowledge (retired)", () => {
    it("states attention items from records only, and refuses the task and Knowledge routes", async () => {
        const camper = await createAsset({
            name: "Cub Camper Frontier",
            category: "trailers",
            vehicle: { kind: "trailer", registrationExpiry: plusDays(sydneyToday(), 21) },
        });
        const item = (await attention()).find((i) => i.kind === "registration")!;
        expect(item.sentence).toBe("Cub Camper Frontier registration is due in 21 days.");
        expect(Object.keys(item)).not.toEqual(expect.arrayContaining(["taskNote", "taskRef", "taskId"]));
        for (const [method, path] of [
            ["POST", "/tasks"],
            ["POST", `/items/${camper.id}/knowledge`],
            ["DELETE", `/items/${camper.id}/knowledge/kob_aaaaaaaaaaaaaa`],
        ] as const) {
            const r = await call<{ error: string }>(method, path, method === "DELETE" ? undefined : { refKind: "registration", refId: camper.id });
            expect(r.status, `${method} ${path}`).toBe(410);
            expect(r.json.error).toBe("retired");
        }
        const d = await detail(camper.id);
        expect(d).not.toHaveProperty("knowledge");
        expect(d).not.toHaveProperty("tasks");
        const search = await call<{ results: Record<string, unknown> }>("GET", "/search?q=camper");
        expect(Object.keys(search.json.results).sort()).toEqual(["assets", "files", "locations", "maintenance"]);
    });

    it("completes maintenance without touching links made before the retirement, and makes no automatic tasks", async () => {
        const fridge = await createAsset({ name: "Fridge", category: "appliances" });
        const r = await record({ assetId: fridge.id, title: "Clean the coils", dueOn: sydneyToday() });
        const now = new Date().toISOString();
        await db().batch([
            db()
                .prepare(
                    "INSERT INTO asset_task_links (id, task_id, asset_id, ref_kind, ref_id, ref_date, created_by, created_at) VALUES ('atl_aaaaaaaaaaaaaa', 'tsk_aaaaaaaaaaaaaa', ?, 'maintenance', ?, '', ?, ?)",
                )
                .bind(fridge.id, r.id, A, now),
            db()
                .prepare("INSERT INTO asset_knowledge_links (asset_id, object_id, added_by, added_at) VALUES (?, 'kob_aaaaaaaaaaaaaa', ?, ?)")
                .bind(fridge.id, A, now),
        ]);
        const done = await call<Record<string, unknown>>("POST", `/maintenance/${r.id}/complete`, { completedOn: sydneyToday() });
        expect(done.status, done.text).toBe(200);
        expect(done.json).not.toHaveProperty("taskCompleted");
        expect((await call<{ record: MaintenanceView }>("GET", `/maintenance/${r.id}`)).json.record).not.toHaveProperty("task");
        expect((await db().prepare("SELECT COUNT(*) AS n FROM asset_task_links").first<{ n: number }>())?.n).toBe(1);
        expect((await db().prepare("SELECT COUNT(*) AS n FROM asset_knowledge_links").first<{ n: number }>())?.n).toBe(1);

        // A schedule saved with "create a task N days ahead" before the retirement: reminders still run, no task is made.
        const aircon = await createAsset({ name: "Air conditioner", category: "appliances" });
        const sc = await schedule({
            assetId: aircon.id,
            title: "Filter clean",
            category: "cleaning",
            intervalCount: 3,
            intervalUnit: "months",
            firstDueOn: plusDays(sydneyToday(), 5),
        });
        await db().prepare("UPDATE asset_schedules SET task_lead_days = 7 WHERE id = ?").bind(sc.id).run();
        const result = await processAssetReminders(await portalEnv(), { provider: null });
        expect(result).not.toHaveProperty("tasks");
        expect((await db().prepare("SELECT COUNT(*) AS n FROM asset_task_links").first<{ n: number }>())?.n).toBe(1);
        expect((await db().prepare("SELECT COUNT(*) AS n FROM task_items").first<{ n: number }>())?.n).toBe(0);
        expect(
            (await call("POST", "/schedules", { assetId: aircon.id, title: "Coil clean", intervalCount: 1, intervalUnit: "years", taskLeadDays: 7 })).status,
        ).toBe(422);
    });
});

describe("Daly Calendar", () => {
    it("shows asset dates as reminders in the caller's calendar, never someone else's private ones", async () => {
        await createAsset({ name: "Hilux", category: "vehicles", vehicle: { registrationExpiry: plusDays(sydneyToday(), 3) } });
        const window = `from=${sydneyToday()}&to=${plusDays(sydneyToday(), 7)}`;
        const mine = await apiCall<{ overlays: Overlays }>("GET", `/api/portal/calendar/overlays?${window}`);
        expect(mine.status, mine.text).toBe(200);
        expect(mine.json.overlays.assets?.map((a) => a.title)).toContain("Registration due: Hilux");
        const theirs = await apiCall<{ overlays: Overlays }>("GET", `/api/portal/calendar/overlays?${window}`, undefined, { email: B });
        expect(theirs.json.overlays.assets ?? []).toEqual([]);
    });

    it("makes a booked service a real Calendar appointment, once", async () => {
        const hilux = await createAsset({ name: "Hilux", category: "vehicles" });
        const r = await record({
            assetId: hilux.id,
            title: "Service",
            scheduledOn: plusDays(sydneyToday(), 4),
            scheduledTime: "09:00",
            provider: "Example Motors",
        });
        const first = await call<{ eventId: string; existing: boolean }>("POST", `/maintenance/${r.id}/appointment`, {});
        expect(first.status, first.text).toBe(200);
        expect(first.json.existing).toBe(false);
        const event = await apiCall<{ event: { title: string; category: string; startTime: string; endTime: string } }>(
            "GET",
            `/api/portal/calendar/events/${first.json.eventId}`,
        );
        expect(event.json.event).toMatchObject({ title: "Service: Hilux", category: "appointment", startTime: "09:00", endTime: "10:00" });
        const second = await call<{ eventId: string; existing: boolean }>("POST", `/maintenance/${r.id}/appointment`, {});
        expect(second.json).toEqual({ eventId: first.json.eventId, existing: true });
        expect((await call<{ record: MaintenanceView }>("GET", `/maintenance/${r.id}`)).json.record.status).toBe("scheduled");
    });
});

describe("Today and the Chief of Staff", () => {
    it("adds a Home & Assets section to Today, and facts to the Chief of Staff's daily context", async () => {
        await createAsset({ name: "Cub Camper Frontier", category: "trailers", vehicle: { registrationExpiry: plusDays(sydneyToday(), 21) } });
        const page = await (await import("./portal-helpers")).call("/portal/today", { token: await accessToken({ email: A }) });
        const html = await page.text();
        expect(html).toContain("Cub Camper Frontier registration is due in 21 days.");

        const daily = await mcp("chief_of_staff_daily_context");
        expect(daily.ok).toBe(true);
        const home = (daily as unknown as { data: { homeAssets: { dueSoon: { fact: string }[] } } }).data.homeAssets;
        expect(home.dueSoon[0]).toEqual(expect.objectContaining({ fact: "Cub Camper Frontier registration is due in 21 days." }));
        expect(home.dueSoon[0]).not.toHaveProperty("taskNote");

        // The person can leave it out of Today.
        const prefs = await call<{ preferences: Record<string, unknown>; version: number }>("GET", "/preferences");
        const saved = await call("PUT", "/preferences", {
            version: prefs.json.version,
            preferences: { ...prefs.json.preferences, today: { enabled: false, horizonDays: 30, maxItems: 6 } },
        });
        expect(saved.status, saved.text).toBe(200);
        const again = await (await import("./portal-helpers")).call("/portal/today", { token: await accessToken({ email: A }) });
        expect(await again.text()).not.toContain("Cub Camper Frontier registration");
    });
});

describe("MCP", () => {
    it("reads only what the caller can see, and hides values that aren't shared", async () => {
        const ring = await createAsset({ name: "Ring", category: "valuables", purchasePriceCents: 500000 });
        const tv = await createAsset({ name: "TV", category: "electronics", purchasePriceCents: 200000 });
        await share(tv.id, { visibility: "household", household: NONE });
        const listed = await mcp("assets_list", {}, B);
        expect(listed.ok).toBe(true);
        const assets = (listed as unknown as { data: { assets: { id: string; financialValues?: string; purchasePriceAud?: number }[] } }).data.assets;
        expect(assets.map((a) => a.id)).toEqual([tv.id]);
        expect(assets[0]).toMatchObject({ financialValues: "not shared with you" });
        expect(assets[0]).not.toHaveProperty("purchasePriceAud");
        expect(await mcp("assets_get", { assetId: ring.id }, B)).toMatchObject({ ok: false, error: { code: "not_found" } });
        const summary = await mcp("assets_summary", {}, A);
        expect(summary).toMatchObject({ ok: true, data: { assets: 2, recordedCurrentValueAud: null, withoutAValue: 2 } });
    });

    it("creates through the ledger, replays a retried request id, and refuses a stale update", async () => {
        const created = await mcp("assets_create", { name: "Kayak", category: "outdoor", requestId: "create-kayak-0001" });
        expect(created.ok).toBe(true);
        const id = (created as unknown as { data: { asset: { id: string; version: number } } }).data.asset.id;
        const replayed = await mcp("assets_create", { name: "Kayak", category: "outdoor", requestId: "create-kayak-0001" });
        expect(replayed).toMatchObject({ ok: true, data: { replayed: true, asset: { id } } });
        expect((await db().prepare("SELECT COUNT(*) AS n FROM assets").first<{ n: number }>())?.n).toBe(1);
        const ledger = await db().prepare("SELECT tool, status, entity_type, entity_id FROM mcp_writes").all();
        expect(ledger.results).toEqual([{ tool: "assets_create", status: "done", entity_type: "asset", entity_id: id }]);
        expect(await mcp("assets_update", { assetId: id, version: 5, notes: "x" })).toMatchObject({ ok: false, error: { code: "conflict" } });
        // History records MCP as the channel.
        expect((await db().prepare("SELECT via FROM asset_activity WHERE action = 'asset.create'").first<{ via: string }>())?.via).toBe("mcp");
    });

    it("adds and completes maintenance, and refuses the retired task and Knowledge tools", async () => {
        const hilux = await createAsset({ name: "Hilux", category: "vehicles", vehicle: { registrationExpiry: plusDays(sydneyToday(), 10) } });
        const added = await mcp("assets_create_maintenance", {
            assetId: hilux.id,
            title: "Wheel alignment",
            dueOn: plusDays(sydneyToday(), 2),
            requestId: "add-maint-00001",
        });
        expect(added.ok).toBe(true);
        const recordId = (added as unknown as { data: { record: { id: string } } }).data.record.id;
        const attention = await mcp("assets_get_attention", { days: 30 });
        const items = (attention as unknown as { data: { items: Record<string, unknown>[] } }).data.items;
        expect(items.find((i) => i.kind === "registration")).not.toHaveProperty("createTask");
        expect(await mcp("assets_create_task", { refKind: "registration", refId: hilux.id, requestId: "task-rego-00001" })).toMatchObject({
            ok: false,
            error: { code: "retired" },
        });
        expect(await mcp("assets_link_knowledge", { assetId: hilux.id, objectId: "kob_aaaaaaaaaaaaaa" })).toMatchObject({
            ok: false,
            error: { code: "retired" },
        });
        const done = await mcp("assets_complete_maintenance", { maintenanceId: recordId, completedOn: sydneyToday(), requestId: "complete-0001" });
        expect(done).toMatchObject({ ok: true, data: { record: { status: "completed" } } });
        expect((done as unknown as { data: Record<string, unknown> }).data).not.toHaveProperty("linkedTaskCompleted");
    });
});

describe("reminders and email", () => {
    const fakeProvider = () => {
        const sent: OutgoingEmail[] = [];
        const provider: EmailProvider = {
            channel: "email",
            name: "test",
            supportsAttachments: false,
            async send(m) {
                sent.push(m);
                return { providerId: null };
            },
        };
        return { sent, provider };
    };

    it("records each reminder once, however often the cron runs, and shows it in the portal", async () => {
        await createAsset({ name: "Cub Camper Frontier", category: "trailers", vehicle: { registrationExpiry: plusDays(sydneyToday(), 7) } });
        const env = await portalEnv();
        const { provider, sent } = fakeProvider();
        await processAssetReminders(env, { provider });
        await processAssetReminders(env, { provider });
        const rows = await db().prepare("SELECT reminder, offset_days, email_status FROM asset_notifications").all();
        expect(rows.results).toEqual([{ reminder: "registration", offset_days: 7, email_status: "none" }]);
        // Email is off by default: nothing was sent.
        expect(sent).toEqual([]);
        const list = await call<{ notifications: { sentence: string }[] }>("GET", "/notifications");
        expect(list.json.notifications.map((n) => n.sentence)).toEqual(["Cub Camper Frontier registration is due in 7 days."]);
        // Notification rows hold ids and dates only.
        const raw = JSON.stringify((await db().prepare("SELECT * FROM asset_notifications").all()).results);
        expect(raw).not.toContain("Cub Camper");
    });

    it("emails only with the switch on, a provider and the person's own opt-in, without details unless they asked", async () => {
        await createAsset({ name: "Cub Camper Frontier", category: "trailers", vehicle: { registrationExpiry: plusDays(sydneyToday(), 7) } });
        const env = await portalEnv();
        const { provider, sent } = fakeProvider();
        expect((await apiCall("PUT", "/api/portal/flags/assets.reminders.email", { enabled: true })).status).toBe(200);
        // Switch on, but the person hasn't opted in.
        await processAssetReminders(env, { provider });
        expect(sent).toEqual([]);
        await db().prepare("DELETE FROM asset_notifications").run();
        const prefs = await call<{ preferences: { reminders: Record<string, unknown> }; version: number }>("GET", "/preferences");
        await call("PUT", "/preferences", {
            version: prefs.json.version,
            preferences: {
                ...prefs.json.preferences,
                reminders: { ...prefs.json.preferences.reminders, registration: { inApp: true, email: true, days: [7] } },
            },
        });
        await processAssetReminders(env, { provider });
        await processAssetReminders(env, { provider });
        expect(sent).toHaveLength(1);
        expect(sent[0].subject).toBe("You have a Home & Assets reminder");
        expect(sent[0].text).not.toContain("Cub Camper");
    });

    it("reminds about shared assets only for people who asked for household reminders", async () => {
        const camper = await createAsset({ name: "Camper", category: "trailers", vehicle: { registrationExpiry: plusDays(sydneyToday(), 7) } });
        await share(camper.id, { visibility: "household", household: NONE });
        const env = await portalEnv();
        await processAssetReminders(env, { provider: null });
        expect((await db().prepare("SELECT email FROM asset_notifications").all()).results).toEqual([{ email: A }]);
    });
});

describe("optional AI", () => {
    it("works by hand with AI off, and says why it's off", async () => {
        const inbox = await upload({ kind: "receipt", filename: "receipt.pdf", bytes: pdf("Example Hardware\n12/03/2026\nDrill $299.00\nTotal $299.00") });
        const status = await call<{ available: boolean; reason: string }>("GET", "/capture/status");
        expect(status.json).toMatchObject({ available: false });
        expect(status.json.reason).toContain("switched off");
        expect((await call("POST", "/capture/receipt", { fileId: inbox.json.file.id })).status).toBe(409);
        // Creating the asset from the receipt by hand attaches the receipt.
        const asset = await createAsset({ name: "Drill", category: "tools", purchasePriceCents: 29900, fileIds: [inbox.json.file.id] });
        expect(asset.needsDocuments).toEqual({ proof: false, photo: true });
    });

    it("proposes receipt values grounded in the document, and saves nothing", async () => {
        const { env } = await aiEnv();
        await configure(env);
        expect((await apiCall("PUT", "/api/portal/flags/assets.ai", { enabled: true }, { env })).status).toBe(200);
        const text = "Example Hardware\nDate: 12/03/2026\nCordless drill $299.00\nTotal $299.00\n2 year manufacturer warranty";
        const file = await apiCall<{ file: { id: string } }>(
            "POST",
            "/api/portal/assets/files",
            { kind: "receipt", filename: "r.pdf", data: btoa(`%PDF-1.4\n${text}\n%%EOF`) },
            { env },
        );
        const proposal = await apiCall<{ proposal: ReceiptProposal }>("POST", "/api/portal/assets/capture/receipt", { fileId: file.json.file.id }, { env });
        expect(proposal.status, proposal.text).toBe(200);
        expect(proposal.json.proposal).toMatchObject({
            merchant: { value: expect.stringContaining("Example Hardware"), grounded: true },
            purchaseDate: { value: "2026-03-12", grounded: true },
            totalCents: { value: 29900, grounded: true },
            warranty: { grounded: true },
        });
        expect((await db().prepare("SELECT COUNT(*) AS n FROM assets").first<{ n: number }>())?.n).toBe(0);
        // Usage is recorded without content.
        const usage = JSON.stringify((await db().prepare("SELECT * FROM ai_usage").all()).results);
        expect(usage).not.toContain("Example Hardware");
    });

    it("marks a value the model gave that isn't in the document as not found", async () => {
        const { env } = await aiEnv({
            text: () =>
                JSON.stringify({ merchant: "Invented Store", purchaseDate: "2026-01-01", items: [], total: 1234.5, warranty: null, documentKind: "receipt" }),
        });
        await configure(env);
        await apiCall("PUT", "/api/portal/flags/assets.ai", { enabled: true }, { env });
        const file = await apiCall<{ file: { id: string } }>(
            "POST",
            "/api/portal/assets/files",
            { kind: "receipt", filename: "r.pdf", data: btoa("%PDF-1.4\nA receipt with nothing useful\n%%EOF") },
            { env },
        );
        const proposal = (await apiCall<{ proposal: ReceiptProposal }>("POST", "/api/portal/assets/capture/receipt", { fileId: file.json.file.id }, { env }))
            .json.proposal;
        expect(proposal.merchant).toMatchObject({ value: "Invented Store", grounded: false, evidence: null });
        expect(proposal.totalCents).toMatchObject({ value: 123450, grounded: false });
        expect(proposal.purchaseDate).toMatchObject({ grounded: false });
    });

    it("suggests what a photo shows without claiming certainty", async () => {
        const { env } = await aiEnv();
        await configure(env);
        await apiCall("PUT", "/api/portal/flags/assets.ai", { enabled: true }, { env });
        const photo = jpeg({ description: "A photo of a cordless drill with a logo reading Makita, model DHP485 on a bench." });
        const file = await apiCall<{ file: { id: string } }>(
            "POST",
            "/api/portal/assets/files",
            { kind: "photo", filename: "p.jpg", data: btoa(String.fromCharCode(...photo)) },
            { env },
        );
        const proposal = (await apiCall<{ proposal: PhotoProposal }>("POST", "/api/portal/assets/capture/photo", { fileId: file.json.file.id }, { env })).json
            .proposal;
        expect(proposal).toMatchObject({ manufacturer: "Makita", model: "DHP485", category: "tools", confidence: "medium" });
        expect(proposal.note).toContain("can be wrong");
    });

    it("summarises a policy as wording to check, with each statement's evidence", async () => {
        const { env } = await aiEnv();
        await configure(env);
        await apiCall("PUT", "/api/portal/flags/assets.ai", { enabled: true }, { env });
        const p = await apiCall<{ policy: { id: string } }>(
            "POST",
            "/api/portal/assets/policies",
            { provider: "Example", policyType: "caravan_trailer" },
            { env },
        );
        const text =
            "Insurer: Example Insurance\nPolicy number: TEST-123\nPeriod of insurance: 01/11/2026 to 01/11/2027\nTotal premium: $640.00\nExcess: $250\nCovered: Accidental damage\nNot covered: Wear and tear";
        const file = await apiCall<{ file: { id: string } }>(
            "POST",
            "/api/portal/assets/files",
            { kind: "policy", filename: "pol.pdf", policyId: p.json.policy.id, data: btoa(`%PDF-1.4\n${text}\n%%EOF`) },
            { env },
        );
        const proposal = (
            await apiCall<{ proposal: PolicyProposal }>(
                "POST",
                `/api/portal/assets/policies/${p.json.policy.id}/extract`,
                { fileId: file.json.file.id },
                { env },
            )
        ).json.proposal;
        expect(proposal.fields).toMatchObject({
            reference: { value: "TEST-123", grounded: true },
            renewsOn: { value: "2027-11-01", grounded: true },
            premiumCents: { value: 64000, grounded: true },
        });
        expect(proposal.coverage).toEqual([{ statement: "Accidental damage", evidence: "Covered: Accidental damage", grounded: true }]);
        expect(proposal.note).toContain("not confirmation of cover");
        // Nothing changed on the policy itself.
        expect(
            (await apiCall<{ policy: { reference: string | null } }>("GET", `/api/portal/assets/policies/${p.json.policy.id}`, undefined, { env })).json.policy
                .reference,
        ).toBeNull();
    });
});

describe("reports and exports", () => {
    it("exports only visible assets, leaves unshared values as 'not shared', and neutralises formulas", async () => {
        await createAsset({ name: '=HYPERLINK("x")', category: "tools", purchasePriceCents: 1000 });
        const tv = await createAsset({ name: "TV", category: "electronics", purchasePriceCents: 200000 });
        await createAsset({ name: "Private ring", category: "valuables" });
        await share(tv.id, { visibility: "household", household: NONE });
        const mine = await call("GET", "/reports/inventory.csv");
        expect(mine.status).toBe(200);
        expect(mine.headers.get("Content-Disposition")).toContain("attachment");
        expect(mine.text).toContain("'=HYPERLINK");
        const theirs = await call("GET", "/reports/inventory.csv", undefined, B);
        expect(theirs.text).toContain("TV");
        expect(theirs.text).not.toContain("Private ring");
        expect(theirs.text).toContain("not shared");
        expect(theirs.text).not.toContain("2000.00");
        expect((await db().prepare("SELECT action FROM asset_activity WHERE action LIKE 'export.%'").all()).results).toHaveLength(2);
    });

    it("reports maintenance spend from recorded costs only, counting records without one", async () => {
        const hilux = await createAsset({ name: "Hilux", category: "vehicles" });
        await record({ assetId: hilux.id, title: "Service", status: "completed", completedOn: sydneyToday(), costCents: 45000 });
        await record({ assetId: hilux.id, title: "Tyre rotation", status: "completed", completedOn: sydneyToday() });
        const csv = (await call("GET", "/reports/expenditure.csv")).text;
        expect(csv).toContain(`${sydneyToday().slice(0, 4)},2,450.00,1,1,0`);
    });

    it("needs chosen assets for an insurance claim pack", async () => {
        expect((await call("GET", "/reports/claim.csv")).status).toBe(422);
        const tv = await createAsset({ name: "TV", category: "electronics" });
        expect((await call("GET", `/reports/claim.csv?assets=${tv.id}`)).text).toContain("TV");
    });
});

describe("migration 0026 and clean-up", () => {
    it("rebuilds mcp_writes keeping every row, and accepts the asset outcomes", async () => {
        const { default: sql } = await import("../migrations/0026_home_assets.sql?raw");
        const statements = (sql as string)
            .split("\n")
            .filter((line) => !line.trim().startsWith("--"))
            .join("\n")
            .split(";")
            .map((s) => s.trim())
            .filter(Boolean);
        const rebuild = statements.slice(statements.findIndex((s) => s.startsWith("CREATE TABLE mcp_writes_next")));
        expect(rebuild.join("\n")).not.toMatch(/\bDELETE\b|\bUPDATE\b/);
        await db()
            .prepare(
                "INSERT INTO mcp_writes (id, email, tool, request_key, status, entity_type, entity_id, created_at) VALUES ('mcw_aaaaaaaaaaaaaa', 'one@example.com', 'tasks_create', 'req-one-000001', 'done', 'task', 'tsk_aaaaaaaaaaaaaa', '2026-10-01T00:00:00.000Z')",
            )
            .run();
        await db().batch(rebuild.map((s) => db().prepare(s)));
        expect((await db().prepare("SELECT id, entity_type FROM mcp_writes").all()).results).toEqual([{ id: "mcw_aaaaaaaaaaaaaa", entity_type: "task" }]);
        await db()
            .prepare(
                "INSERT INTO mcp_writes (id, email, tool, status, entity_type, entity_id, created_at) VALUES ('mcw_bbbbbbbbbbbbbb', 'one@example.com', 'assets_create', 'done', 'asset', 'ast_aaaaaaaaaaaaaa', '2026-10-02T00:00:00.000Z')",
            )
            .run();
        await expect(
            db()
                .prepare(
                    "INSERT INTO mcp_writes (id, email, tool, status, entity_type, created_at) VALUES ('mcw_cccccccccccccc', 'x@example.com', 't', 'done', 'nonsense', 'now')",
                )
                .run(),
        ).rejects.toThrow();
    });

    it("refuses impossible rows in the database itself", async () => {
        const now = "2026-10-20T00:00:00.000Z";
        await db()
            .prepare(
                "INSERT INTO assets (id, owner_email, name, category, created_by, created_at, updated_by, updated_at) VALUES ('ast_aaaaaaaaaaaaaa', ?, 'X', 'tools', ?, ?, ?, ?)",
            )
            .bind(A, A, now, A, now)
            .run();
        // Editing without maintenance, a negative price, a schedule with no interval, a completed record without a date.
        await expect(
            db()
                .prepare(
                    "INSERT INTO asset_shares (asset_id, email, can_edit, can_maintain, added_by, added_at) VALUES ('ast_aaaaaaaaaaaaaa', '*', 1, 0, 'x', 'now')",
                )
                .run(),
        ).rejects.toThrow();
        await expect(db().prepare("UPDATE assets SET purchase_price_cents = -1 WHERE id = 'ast_aaaaaaaaaaaaaa'").run()).rejects.toThrow();
        await expect(
            db()
                .prepare(
                    "INSERT INTO asset_schedules (id, asset_id, title, category, created_by, created_at, updated_by, updated_at) VALUES ('ams_aaaaaaaaaaaaaa', 'ast_aaaaaaaaaaaaaa', 'S', 'service', 'x', 'now', 'x', 'now')",
                )
                .run(),
        ).rejects.toThrow();
        await expect(
            db()
                .prepare(
                    "INSERT INTO asset_maintenance (id, asset_id, title, status, created_by, created_at, updated_by, updated_at) VALUES ('amr_aaaaaaaaaaaaaa', 'ast_aaaaaaaaaaaaaa', 'M', 'completed', 'x', 'now', 'x', 'now')",
                )
                .run(),
        ).rejects.toThrow();
        await expect(
            db()
                .prepare(
                    "INSERT INTO asset_files (id, owner_email, kind, filename, content_type, bytes, sha256, r2_key, created_at, updated_at) VALUES ('afl_aaaaaaaaaaaaaa', 'x', 'photo', 'a', 'b', 1, ?, 'wedding/x', 'now', 'now')",
                )
                .bind("a".repeat(64))
                .run(),
        ).rejects.toThrow();
    });

    it("removes a deleted asset's files from R2 after 30 days, and the asset with them", async () => {
        const drill = await createAsset({ name: "Drill", category: "tools" });
        const photo = await upload({ assetId: drill.id, bytes: jpeg() });
        await call("DELETE", `/items/${drill.id}`, { confirm: "DELETE" });
        const env = await portalEnv();
        // Not yet: it can still be restored.
        expect(await purgeDeletedAssets(env.DB, env.MEDIA)).toEqual({ files: 0, assets: 0 });
        await db().prepare("UPDATE assets SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").bind(drill.id).run();
        const key = (await db().prepare("SELECT r2_key FROM asset_files WHERE id = ?").bind(photo.json.file.id).first<{ r2_key: string }>())!.r2_key;
        expect(await purgeDeletedAssets(env.DB, env.MEDIA)).toEqual({ files: 1, assets: 1 });
        expect(await env.MEDIA.get(key)).toBeNull();
        expect(await purgeDeletedAssets(env.DB, env.MEDIA)).toEqual({ files: 0, assets: 0 });
        expect(await db().prepare("SELECT id FROM assets WHERE id = ?").bind(drill.id).first()).toBeNull();
    });

    it("admins can open it too; the people list shows the household", async () => {
        await addPortalUser(ADMIN, "admin");
        const people = await call<{ people: { email: string }[] }>("GET", "/people");
        expect(people.json.people.map((p) => p.email).sort()).toEqual([ADMIN, B].sort());
    });
});
