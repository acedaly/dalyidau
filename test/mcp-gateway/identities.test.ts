// Two independent people through the full MCP path (gateway → PortalMcpEntrypoint → D1), each with
// their own Access assertion: private records stay private, shared ones are shared exactly as far as
// the membership goes, and nothing about one person leaks into the other's answers. Both are portal
// owners, so an owner role is shown not to open someone else's private data. Every identity and
// record is fictional.
import { beforeEach, describe, expect, it } from "vitest";
import { OWNER, SECOND_OWNER, apiCall, resetPortal } from "../portal-helpers";
import { guardOutbound, session } from "./helpers";

const A = OWNER;
const B = SECOND_OWNER;
const C = "/api/portal/calendar";

beforeEach(async () => {
    await resetPortal();
    guardOutbound();
});

type Event = { id: string; title: string; version: number };
type Asset = { id: string; name: string; version: number };

/** Words only A's private records contain. They must never appear in anything B receives. */
const SECRET = ["Zanzibar", "pineapple-lantern"];
const leaks = (value: unknown) => SECRET.filter((word) => JSON.stringify(value).includes(word));
const DAY = "2030-03-01";

async function privateRecordsOfA() {
    const a = await session(A);
    const event = (
        await a.ok<{ event: Event }>("calendar_create_event", {
            title: "Zanzibar flights",
            description: "pineapple-lantern",
            startDate: DAY,
            startTime: "09:00",
        })
    ).event;
    const asset = (await a.ok<{ asset: Asset }>("assets_create", { name: "Zanzibar surfboard", category: "outdoor", notes: "pineapple-lantern" })).asset;
    return { a, event, asset };
}

async function sharedCalendar(role: "editor" | "viewer") {
    const created = await apiCall<{ calendar: { id: string } }>(
        "POST",
        `${C}/calendars`,
        { name: "Household", kind: "shared", purpose: "family" },
        { email: A },
    );
    expect(created.status, created.text).toBe(201);
    const added = await apiCall("POST", `${C}/calendars/${created.json.calendar.id}/members`, { email: B, role }, { email: A });
    expect(added.status, added.text).toBeLessThan(300);
    return created.json.calendar.id;
}

describe("private records", () => {
    it("B can't read A's private event or asset by id, list, search or briefing", async () => {
        const { asset } = await privateRecordsOfA();
        const b = await session(B);
        const answer = await b.tool("assets_get", { assetId: asset.id });
        expect(answer.isError).toBe(true);
        expect(answer.data.error?.code).toBe("not_found");
        for (const [tool, args] of [
            ["calendar_list_events", { from: DAY, to: DAY }],
            ["calendar_search_events", { query: "Zanzibar" }],
            ["calendar_get_agenda", { date: DAY }],
            ["assets_search", { query: "Zanzibar" }],
            ["assets_list", {}],
            ["chief_of_staff_daily_context", {}],
            ["today_get_summary", {}],
        ] as const) {
            const result = await b.ok(tool, args);
            expect(leaks(result), tool).toEqual([]);
        }
    });

    it("A still sees their own records through the same tools", async () => {
        const { a, asset } = await privateRecordsOfA();
        expect((await a.ok<{ asset: Asset }>("assets_get", { assetId: asset.id })).asset.name).toBe("Zanzibar surfboard");
        expect(JSON.stringify(await a.ok("calendar_search_events", { query: "Zanzibar" }))).toContain("Zanzibar flights");
    });

    it("B can't change A's private records", async () => {
        const { a, event, asset } = await privateRecordsOfA();
        const b = await session(B);
        for (const [tool, args] of [
            ["calendar_update_event", { eventId: event.id, version: event.version, title: "Hijacked" }],
            ["assets_update", { assetId: asset.id, version: asset.version, name: "Hijacked" }],
            ["assets_create_maintenance", { assetId: asset.id, title: "Hijacked" }],
        ] as const) {
            const answer = await b.tool(tool, args);
            expect(answer.isError, tool).toBe(true);
            expect(answer.data.error?.code, tool).toBe("not_found");
        }
        expect((await a.ok<{ asset: Asset }>("assets_get", { assetId: asset.id })).asset.name).toBe("Zanzibar surfboard");
    });

    it("identity comes only from the assertion: arguments can't name someone else", async () => {
        const b = await session(B);
        for (const extra of [{ email: A }, { user: A }, { owner: A }, { actor: A }]) {
            const answer = await b.tool("calendar_create_event", { title: "As A", startDate: DAY, ...extra });
            expect(answer.isError || !!answer.rpcError).toBe(true);
        }
        const a = await session(A);
        expect(JSON.stringify(await a.ok("calendar_search_events", { query: "As A" }))).not.toContain("As A");
    });

    it("the same requestId from two people creates two separate records and replays neither across them", async () => {
        const a = await session(A);
        const b = await session(B);
        const first = (await a.ok<{ event: Event }>("calendar_create_event", { title: "Zanzibar visa", startDate: DAY, requestId: "shared-request-0001" }))
            .event;
        const second = await b.ok<{ event: Event; replayed?: boolean }>("calendar_create_event", {
            title: "B's own event",
            startDate: DAY,
            requestId: "shared-request-0001",
        });
        expect(second.event.id).not.toBe(first.id);
        expect(second.event.title).toBe("B's own event");
        expect(leaks(second)).toEqual([]);
        const retry = await a.ok<{ event: Event; replayed?: boolean }>("calendar_create_event", {
            title: "Zanzibar visa",
            startDate: DAY,
            requestId: "shared-request-0001",
        });
        expect(retry.event.id).toBe(first.id);
    });
});

describe("shared records", () => {
    it("a shared calendar's events are visible to a member, and A's private events in it are only Busy", async () => {
        const calendarId = await sharedCalendar("viewer");
        const a = await session(A);
        await a.ok("calendar_create_event", { calendarId, title: "Clean gutters", startDate: DAY, startTime: "10:00" });
        await a.ok("calendar_create_event", { calendarId, title: "Zanzibar surprise", startDate: DAY, startTime: "12:00", visibility: "private" });
        const b = await session(B);
        const events = JSON.stringify(await b.ok("calendar_list_events", { from: DAY, to: DAY }));
        expect(events).toContain("Clean gutters");
        expect(events).toContain("Busy");
        expect(leaks(events)).toEqual([]);
        // A viewer can't change it.
        const shared = JSON.parse(events) as { events: { eventId: string; title: string }[] };
        const gutters = shared.events.find((e) => e.title === "Clean gutters");
        if (gutters) {
            const answer = await b.tool("calendar_update_event", { eventId: gutters.eventId, version: 1, title: "Changed" });
            expect(answer.isError).toBe(true);
        }
    });

    it("removing B from a shared calendar cuts off access on the very next call", async () => {
        const calendarId = await sharedCalendar("editor");
        const a = await session(A);
        await a.ok("calendar_create_event", { calendarId, title: "Shared chore", startDate: DAY, startTime: "10:00" });
        const b = await session(B);
        expect(JSON.stringify(await b.ok("calendar_list_events", { from: DAY, to: DAY }))).toContain("Shared chore");
        expect((await apiCall("DELETE", `${C}/calendars/${calendarId}/members/${encodeURIComponent(B)}`, undefined, { email: A })).status).toBeLessThan(300);
        expect(JSON.stringify(await b.ok("calendar_list_events", { from: DAY, to: DAY }))).not.toContain("Shared chore");
    });
});

describe("people without access", () => {
    it("a verified Access identity with no portal role gets no data from any tool", async () => {
        await privateRecordsOfA();
        const stranger = await session("stranger@example.com");
        for (const tool of ["calendar_list_calendars", "assets_list", "chief_of_staff_daily_context"]) {
            const answer = await stranger.tool(tool);
            expect(answer.isError, tool).toBe(true);
            expect(answer.data.error?.code, tool).toBe("forbidden");
            expect(leaks(answer)).toEqual([]);
        }
    });

    it("an Access service token (no email) can't use the portal", async () => {
        const service = await session(null);
        const answer = await service.tool("calendar_list_calendars");
        expect(answer.isError).toBe(true);
        expect(answer.data.error?.code).toBe("unauthenticated");
    });
});
