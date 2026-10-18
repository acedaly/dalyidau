// Reading and writing iCalendar, and fetching feeds safely. Feeds here are invented, in the shapes
// Google, Apple and Outlook publish. No real network: fetch and DNS are stand-ins.
import { afterEach, describe, expect, it, vi } from "vitest";
import { wallClock, zonedInstant } from "../src/shared/calendar/time";
import { expand } from "../worker/calendar/expand";
import { escapeText, fold, parseIcs, resolveZone, serializeCalendar, vtimezone } from "../worker/calendar/ics";
import { FeedError, fetchFeed, isPrivateAddress, maskUrl, normaliseFeedUrl } from "../worker/calendar/safe-fetch";

const SYD = "Australia/Sydney";
const ics = (...lines: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN", ...lines, "END:VCALENDAR"].join("\r\n");

describe("reading feeds", () => {
    it("reads a Google-style feed: IANA zones, a weekly series with an exclusion, a moved and a cancelled occurrence", () => {
        const parsed = parseIcs(
            ics(
                "X-WR-CALNAME:Riverside swim club",
                "X-WR-TIMEZONE:Australia/Sydney",
                "BEGIN:VEVENT",
                "UID:swim-1@example.com",
                "DTSTART;TZID=Australia/Sydney:20261005T170000",
                "DTEND;TZID=Australia/Sydney:20261005T180000",
                "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261207T060000Z",
                "EXDATE;TZID=Australia/Sydney:20261019T170000",
                "SUMMARY:Squad training\\, lane 3",
                "LOCATION:Aquatic centre",
                "END:VEVENT",
                "BEGIN:VEVENT",
                "UID:swim-1@example.com",
                "RECURRENCE-ID;TZID=Australia/Sydney:20261026T170000",
                "DTSTART;TZID=Australia/Sydney:20261027T163000",
                "DTEND;TZID=Australia/Sydney:20261027T173000",
                "SUMMARY:Squad training (moved)",
                "END:VEVENT",
                "BEGIN:VEVENT",
                "UID:swim-1@example.com",
                "RECURRENCE-ID;TZID=Australia/Sydney:20261102T170000",
                "DTSTART;TZID=Australia/Sydney:20261102T170000",
                "STATUS:CANCELLED",
                "END:VEVENT",
            ),
            { fallbackZone: "UTC" },
        );
        expect(parsed.name).toBe("Riverside swim club");
        expect(parsed.events).toHaveLength(1);
        const [e] = parsed.events;
        expect(e).toMatchObject({
            uid: "swim-1@example.com",
            title: "Squad training, lane 3",
            timeZone: SYD,
            startDate: "2026-10-05",
            startTime: "17:00",
            endTime: "18:00",
        });
        // UNTIL in UTC becomes the event's own local time (5 pm AEDT on 7 December).
        expect(e.rrule).toBe("FREQ=WEEKLY;BYDAY=MO;UNTIL=20261207T170000");
        expect(e.exdates).toEqual(["2026-10-19T17:00"]);
        expect(e.overrides).toEqual([
            expect.objectContaining({
                key: "2026-10-26T17:00",
                cancelled: false,
                fields: expect.objectContaining({ title: "Squad training (moved)", startDate: "2026-10-27", startTime: "16:30" }),
            }),
            { key: "2026-11-02T17:00", cancelled: true, fields: {} },
        ]);
        const row = {
            all_day: 0,
            start_date: e.startDate,
            start_time: e.startTime,
            end_date: e.endDate,
            end_time: e.endTime,
            time_zone: e.timeZone,
            rrule: e.rrule,
            rdates: null,
            exdates: JSON.stringify(e.exdates),
        };
        const overrides = e.overrides.map((o) => ({
            event_id: "x",
            occurrence_key: o.key,
            cancelled: o.cancelled ? 1 : 0,
            fields: JSON.stringify(o.fields),
            start_at: null,
            end_at: null,
        }));
        const { occurrences } = expand(row, overrides, { start: zonedInstant("2026-10-01", "00:00", SYD), end: zonedInstant("2026-12-31", "00:00", SYD) });
        expect(occurrences.map((o) => o.startDate)).toEqual([
            "2026-10-05",
            "2026-10-12",
            "2026-10-27",
            "2026-11-09",
            "2026-11-16",
            "2026-11-23",
            "2026-11-30",
            "2026-12-07",
        ]);
    });

    it("reads an Outlook-style feed: Windows zone names and their VTIMEZONE", () => {
        const parsed = parseIcs(
            ics(
                "BEGIN:VTIMEZONE",
                "TZID:AUS Eastern Standard Time",
                "BEGIN:STANDARD",
                "DTSTART:16010101T030000",
                "TZOFFSETFROM:+1100",
                "TZOFFSETTO:+1000",
                "RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=4",
                "END:STANDARD",
                "BEGIN:DAYLIGHT",
                "DTSTART:16010101T020000",
                "TZOFFSETFROM:+1000",
                "TZOFFSETTO:+1100",
                "RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=10",
                "END:DAYLIGHT",
                "END:VTIMEZONE",
                "BEGIN:VEVENT",
                "UID:040000008200E00074C5B7101A82E008",
                "DTSTART;TZID=AUS Eastern Standard Time:20261020T093000",
                "DTEND;TZID=AUS Eastern Standard Time:20261020T103000",
                "SUMMARY:Parent-teacher interviews",
                "CLASS:PRIVATE",
                "TRANSP:TRANSPARENT",
                "END:VEVENT",
            ),
            { fallbackZone: "UTC" },
        );
        expect(parsed.events[0]).toMatchObject({ timeZone: SYD, startTime: "09:30", visibility: "private", showAs: "free" });
        expect(resolveZone("(UTC+10:00) Canberra, Melbourne, Sydney")).toBe(SYD);
        expect(resolveZone("/freeassociation.sourceforge.net/Australia/Perth")).toBe("Australia/Perth");
        expect(resolveZone("Mars/Olympus_Mons")).toBeNull();
    });

    it("reads all-day and UTC events, and gives events without a UID a stable one", () => {
        const feed = ics(
            "BEGIN:VEVENT",
            "UID:holiday-1",
            "DTSTART;VALUE=DATE:20261225",
            "DTEND;VALUE=DATE:20261226",
            "SUMMARY:Christmas Day",
            "END:VEVENT",
            "BEGIN:VEVENT",
            "DTSTART:20261101T000000Z",
            "DURATION:PT90M",
            "SUMMARY:Webinar",
            "END:VEVENT",
        );
        const parsed = parseIcs(feed, { fallbackZone: SYD });
        expect(parsed.events[0]).toMatchObject({ allDay: true, startDate: "2026-12-25", endDate: "2026-12-25" });
        expect(parsed.events[1]).toMatchObject({ allDay: false, timeZone: "UTC", startTime: "00:00", endTime: "01:30" });
        expect(parsed.events[1].uid).toMatch(/^nouid-[0-9a-f]{8}$/);
        expect(parseIcs(feed, { fallbackZone: SYD }).events[1].uid).toBe(parsed.events[1].uid);
    });

    it("treats feed content as untrusted: control characters, script links, huge text, sub-daily repeats, cancelled masters", () => {
        const parsed = parseIcs(
            ics(
                "BEGIN:VEVENT",
                "UID:evil",
                "DTSTART:20261101T000000Z",
                `SUMMARY:<img src=x onerror=alert(1)>\u0007‮Reversed`,
                "URL:javascript:alert(1)",
                `DESCRIPTION:${"A".repeat(20_000)}`,
                "RRULE:FREQ=MINUTELY",
                "END:VEVENT",
                "BEGIN:VEVENT",
                "UID:gone",
                "DTSTART:20261101T000000Z",
                "STATUS:CANCELLED",
                "SUMMARY:Called off",
                "END:VEVENT",
            ),
            { fallbackZone: SYD },
        );
        expect(parsed.events).toHaveLength(1);
        const [e] = parsed.events;
        // Stored as plain text (never rendered as HTML), with control and direction-override characters removed.
        expect(e.title).toBe("<img src=x onerror=alert(1)>Reversed");
        expect(e.url).toBeNull();
        expect(e.description).toHaveLength(8000);
        expect(e.rrule).toBeNull();
        expect(parsed.skipped).toEqual({ sub_daily_repeat: 1, cancelled: 1 });
        expect(() => parseIcs("<html>Sign in</html>", { fallbackZone: SYD })).toThrow(/didn't return a calendar/);
        expect(() => parseIcs("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nnot a property", { fallbackZone: SYD })).toThrow();
    });
});

describe("writing ICS", () => {
    it("escapes text, folds long lines without splitting characters, and includes a VTIMEZONE", () => {
        expect(escapeText("Pick up; Sam, Ella\nthen\\home")).toBe("Pick up\\; Sam\\, Ella\\nthen\\\\home");
        const folded = fold(`SUMMARY:${"é".repeat(60)}`);
        for (const line of folded.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
        expect(folded.replace(/\r\n /g, "")).toBe(`SUMMARY:${"é".repeat(60)}`);
        const tz = vtimezone(SYD, 2026, 2026);
        expect(tz).toEqual(
            expect.arrayContaining(["BEGIN:DAYLIGHT", "DTSTART:20261004T020000", "TZOFFSETFROM:+1000", "TZOFFSETTO:+1100", "DTSTART:20260405T030000"]),
        );
        expect(vtimezone("Australia/Brisbane", 2026, 2026)).toEqual(expect.arrayContaining(["TZOFFSETTO:+1000"]));
    });

    it("round-trips a series with an exclusion and a moved occurrence through ical.js", () => {
        const text = serializeCalendar({
            name: "Family",
            events: [
                {
                    uid: "cev_round00000000@daly.id.au",
                    title: "Swimming, then dinner",
                    description: null,
                    location: "Pool",
                    url: null,
                    allDay: false,
                    startDate: "2026-10-05",
                    startTime: "17:00",
                    endDate: "2026-10-05",
                    endTime: "18:00",
                    timeZone: SYD,
                    rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=4",
                    exdates: ["2026-10-12T17:00"],
                    status: "confirmed",
                    showAs: "busy",
                    private: false,
                    updatedAt: "2026-10-01T00:00:00.000Z",
                    overrides: [
                        {
                            key: "2026-10-19T17:00",
                            cancelled: false,
                            title: "Swimming (late)",
                            description: null,
                            location: "Pool",
                            allDay: false,
                            startDate: "2026-10-19",
                            startTime: "18:00",
                            endDate: "2026-10-19",
                            endTime: "19:00",
                        },
                    ],
                },
            ],
        });
        expect(text).toContain("DTSTART;TZID=Australia/Sydney:20261005T170000");
        expect(text).toContain("SUMMARY:Swimming\\, then dinner");
        const back = parseIcs(text, { fallbackZone: "UTC" });
        expect(back.events[0]).toMatchObject({ timeZone: SYD, startTime: "17:00", exdates: ["2026-10-12T17:00"] });
        expect(back.events[0].overrides[0]).toMatchObject({
            key: "2026-10-19T17:00",
            fields: expect.objectContaining({ startTime: "18:00", title: "Swimming (late)" }),
        });
    });
});

describe("SSRF protection", () => {
    afterEach(() => vi.restoreAllMocks());
    const own = ["daly.id.au"];

    it("accepts https and webcal, and refuses everything that could reach somewhere private", () => {
        expect(normaliseFeedUrl("webcal://p01-caldav.icloud.com/published/2/abc", own).toString()).toBe("https://p01-caldav.icloud.com/published/2/abc");
        expect(normaliseFeedUrl(" https://calendar.google.com/calendar/ical/x/basic.ics#frag", own).toString()).toBe(
            "https://calendar.google.com/calendar/ical/x/basic.ics",
        );
        const refused = (url: string) => {
            try {
                normaliseFeedUrl(url, own);
                return "accepted";
            } catch (error) {
                return (error as FeedError).code;
            }
        };
        expect(refused("http://example.com/cal.ics")).toBe("insecure");
        expect(refused("file:///etc/passwd")).toBe("invalid_url");
        expect(refused("https://user:pass@example.com/cal.ics")).toBe("credentials_in_url");
        expect(refused("https://example.com:8443/cal.ics")).toBe("port");
        expect(refused("https://127.0.0.1/cal.ics")).toBe("private_address");
        expect(refused("https://[::1]/cal.ics")).toBe("private_address");
        expect(refused("https://169.254.169.254/latest/meta-data")).toBe("private_address");
        expect(refused("https://8.8.8.8/cal.ics")).toBe("ip_address");
        expect(refused("https://localhost/cal.ics")).toBe("private_address");
        expect(refused("https://printer.local/cal.ics")).toBe("private_address");
        expect(refused("https://intranet/cal.ics")).toBe("private_address");
        expect(refused("https://daly.id.au/calendar/feed/x.ics")).toBe("own_host");
        expect(refused("https://mcp.daly.id.au/x")).toBe("own_host");
        expect(refused("not a url")).toBe("invalid_url");
    });

    it("knows private and special-purpose addresses, including IPv4 inside IPv6", () => {
        for (const ip of [
            "10.1.2.3",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "100.64.0.1",
            "0.0.0.0",
            "224.0.0.1",
            "198.18.0.1",
            "::",
            "fd00::1",
            "fe80::1",
            "::ffff:10.0.0.1",
            "::ffff:7f00:1",
            "64:ff9b::a00:1",
            "2001:db8::1",
        ])
            expect(isPrivateAddress(ip), ip).toBe(true);
        for (const ip of ["1.1.1.1", "172.32.0.1", "8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPrivateAddress(ip), ip).toBe(false);
        expect(maskUrl(new URL("https://calendar.google.com/calendar/ical/secret-token/basic.ics"))).toBe("calendar.google.com/…");
    });

    const publicDns = async () => ["93.184.216.34"];
    const calendarResponse = (body = ics(), headers: Record<string, string> = {}) =>
        new Response(body, { status: 200, headers: { "Content-Type": "text/calendar", ...headers } });

    it("refuses a name that resolves to a private address, and redirects to private or insecure places", async () => {
        const url = new URL("https://cal.example.com/feed.ics");
        await expect(fetchFeed(url, { resolve: async () => ["10.0.0.5"] })).rejects.toMatchObject({ code: "private_address" });
        await expect(fetchFeed(url, { resolve: async () => [] })).rejects.toMatchObject({ code: "host_not_found" });
        const fetchMock = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: "https://internal.example.com/x" } }));
        const resolve = vi.fn(async (host: string) => (host === "internal.example.com" ? ["192.168.0.10"] : ["93.184.216.34"]));
        await expect(fetchFeed(url, { resolve })).rejects.toMatchObject({ code: "private_address" });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 301, headers: { Location: "http://cal.example.com/feed.ics" } }));
        await expect(fetchFeed(url, { resolve: publicDns })).rejects.toMatchObject({ code: "insecure_redirect" });
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: "https://127.0.0.1/" } }));
        await expect(fetchFeed(url, { resolve: publicDns })).rejects.toMatchObject({ code: "private_address" });
    });

    it("follows a safe redirect, sends conditional headers, and handles 304", async () => {
        const fetchMock = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: "/v2/feed.ics" } }))
            .mockResolvedValueOnce(calendarResponse(ics(), { ETag: '"abc"', "Last-Modified": "Sun, 18 Oct 2026 00:00:00 GMT" }));
        const result = await fetchFeed(new URL("https://cal.example.com/feed.ics"), { resolve: publicDns, etag: '"old"' });
        expect(result).toMatchObject({ status: "ok", etag: '"abc"', lastModified: "Sun, 18 Oct 2026 00:00:00 GMT" });
        expect(fetchMock.mock.calls[1][0]).toBe("https://cal.example.com/v2/feed.ics");
        const first = fetchMock.mock.calls[0][1] as RequestInit;
        expect((first.headers as Record<string, string>)["If-None-Match"]).toBe('"old"');
        expect(first.redirect).toBe("manual");
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 304 }));
        expect((await fetchFeed(new URL("https://cal.example.com/feed.ics"), { resolve: publicDns, etag: '"abc"' })).status).toBe("not_modified");
    });

    it("refuses web pages, oversized bodies, and says which errors are worth retrying", async () => {
        const url = new URL("https://cal.example.com/feed.ics");
        const fetchMock = vi.spyOn(globalThis, "fetch");
        fetchMock.mockResolvedValueOnce(new Response("<html></html>", { headers: { "Content-Type": "text/html" } }));
        await expect(fetchFeed(url, { resolve: publicDns })).rejects.toMatchObject({ code: "not_calendar", retryable: false });
        fetchMock.mockResolvedValueOnce(new Response("x".repeat(2000), { headers: { "Content-Type": "text/calendar" } }));
        await expect(fetchFeed(url, { resolve: publicDns, maxBytes: 1000 })).rejects.toMatchObject({ code: "too_large" });
        fetchMock.mockResolvedValueOnce(new Response("", { status: 503 }));
        await expect(fetchFeed(url, { resolve: publicDns })).rejects.toMatchObject({ code: "http_503", retryable: true });
        fetchMock.mockResolvedValueOnce(new Response("", { status: 404 }));
        await expect(fetchFeed(url, { resolve: publicDns })).rejects.toMatchObject({ code: "http_404", retryable: false });
        fetchMock.mockRejectedValueOnce(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
        await expect(fetchFeed(url, { resolve: publicDns })).rejects.toMatchObject({ code: "timeout", retryable: true });
    });
});

describe("time helpers used by feeds", () => {
    it("reads instants back as wall clock in any zone", () => {
        expect(wallClock("2026-12-31T13:00:00.000Z", SYD)).toEqual({ date: "2027-01-01", time: "00:00" });
        expect(wallClock("2026-12-31T13:00:00.000Z", "Australia/Perth")).toEqual({ date: "2026-12-31", time: "21:00" });
    });
});
