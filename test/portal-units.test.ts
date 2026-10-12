import { describe, expect, it } from "vitest";
import type { Guest } from "../src/shared/portal/types";
import { matchesAudience, renderMergeFields, unknownMergeFields } from "../worker/portal/comms";
import { csvCell, parseCsv, toCsv } from "../worker/portal/csv";
import { diff, likePattern, newRsvpCode, normaliseRsvpCode } from "../worker/portal/db";
import { deriveRsvp } from "../worker/portal/guests";

describe("csv", () => {
    it("quotes, escapes and neutralises formulas", () => {
        expect(csvCell("plain")).toBe("plain");
        expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
        expect(csvCell("=1+1")).toBe("'=1+1");
        expect(csvCell("+61 400 000 000")).toBe("'+61 400 000 000");
        expect(csvCell("-5")).toBe("'-5");
        expect(csvCell("@cmd")).toBe("'@cmd");
        expect(csvCell(-5)).toBe("-5"); // numbers are data, not formulas
        expect(csvCell(true)).toBe("yes");
        expect(csvCell(null)).toBe("");
    });

    it("round-trips through the parser", () => {
        const rows = [{ a: 'x, "y"', b: "line\nbreak" }];
        const csv = toCsv(rows, [
            { header: "A", value: (r) => r.a },
            { header: "B", value: (r) => r.b },
        ]);
        expect(parseCsv(csv)).toEqual([
            ["A", "B"],
            ['x, "y"', "line\nbreak"],
        ]);
    });

    it("parses CRLF, blank lines and a BOM", () => {
        expect(parseCsv("﻿a,b\r\n1,2\r\n\r\n3,\r\n")).toEqual([
            ["a", "b"],
            ["1", "2"],
            ["3", ""],
        ]);
    });
});

describe("helpers", () => {
    it("makes unambiguous RSVP codes and normalises what guests type", () => {
        for (let i = 0; i < 50; i++) expect(newRsvpCode()).toMatch(/^[346789ABCDEFGHJKMNPQRTWXY]{8}$/);
        expect(normaliseRsvpCode(" k7mx-q4rd ")).toBe("K7MXQ4RD");
    });

    it("diffs only changed fields", () => {
        expect(diff({ a: 1, b: [1], c: null }, { a: 1, b: [2], c: undefined })).toEqual({ b: [[1], [2]] });
    });

    it("escapes LIKE wildcards", () => {
        expect(likePattern("50%_off\\")).toBe("%50\\%\\_off\\\\%");
    });

    it("derives a guest's overall RSVP", () => {
        const e = (status: "pending" | "attending" | "declined") => ({ eventId: "e", status, source: null, respondedAt: null });
        expect(deriveRsvp([])).toBe("not_invited");
        expect(deriveRsvp([e("declined"), e("attending")])).toBe("attending");
        expect(deriveRsvp([e("declined"), e("declined")])).toBe("declined");
        expect(deriveRsvp([e("declined"), e("pending")])).toBe("pending");
    });
});

describe("merge fields and audiences", () => {
    it("fills known fields and leaves unknown ones visible", () => {
        expect(renderMergeFields("Hi {{ first_name }}, {{oops}}", { first_name: "Jo" })).toBe("Hi Jo, {{oops}}");
        expect(unknownMergeFields("{{first_name}} {{oops}} {{oops}}")).toEqual(["oops"]);
    });

    it("filters guests by RSVP, event, side, group and tag", () => {
        const guest = {
            id: "g1",
            side: "partner_one",
            groupName: "Work",
            tags: ["vip"],
            rsvp: "attending",
            events: [{ eventId: "e1", status: "declined", source: null, respondedAt: null }],
        } as unknown as Guest;
        expect(matchesAudience(guest, {})).toBe(true);
        expect(matchesAudience(guest, { rsvp: ["attending"] })).toBe(true);
        expect(matchesAudience(guest, { rsvp: ["attending"], eventId: "e1" })).toBe(false);
        expect(matchesAudience(guest, { rsvp: ["declined"], eventId: "e1" })).toBe(true);
        expect(matchesAudience(guest, { eventId: "e2" })).toBe(false);
        expect(matchesAudience(guest, { side: ["partner_two"] })).toBe(false);
        expect(matchesAudience(guest, { groupName: "Work", tag: "vip" })).toBe(true);
        expect(matchesAudience(guest, { guestIds: ["other"] })).toBe(false);
    });
});
