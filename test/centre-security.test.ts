// Intelligence Centre safety: what the ingestion engine refuses (SSRF, redirects to other hosts,
// oversized or slow responses, hostile XML, broken or enormous geometry), and that nothing a feed
// contains becomes markup, a command or an instruction.
import { describe, expect, it } from "vitest";
import { capPolygon, descriptionFields } from "../worker/centre/adapters/rfs";
import { parseListLine } from "../worker/centre/ftp";
import { GeometryError, MAX_VERTICES, cleanGeometry, positions } from "../worker/centre/geo";
import { FetchFailure, checkUrl, decodeText, safeFetch } from "../worker/centre/net";
import { XmlError, parseXml, plainText } from "../worker/centre/xml";
import { fakeTransport } from "./centre-helpers";

const allowed = { allowedHosts: ["www.rfs.nsw.gov.au"] as const };

describe("SSRF and redirects", () => {
    it("allows only https to the source's own hosts, never private, numeric or credentialed addresses", () => {
        expect(checkUrl("https://www.rfs.nsw.gov.au/feeds/x.json", allowed).hostname).toBe("www.rfs.nsw.gov.au");
        for (const bad of [
            "http://www.rfs.nsw.gov.au/feeds/x.json",
            "https://evil.example.com/",
            "https://localhost/",
            "https://127.0.0.1/",
            "https://10.0.0.5/",
            "https://169.254.169.254/latest/meta-data",
            "https://[::1]/",
            "https://user:pass@www.rfs.nsw.gov.au/",
            "https://www.rfs.nsw.gov.au:8443/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "not a url",
        ])
            expect(() => checkUrl(bad, allowed), bad).toThrow(FetchFailure);
    });

    it("refuses redirects to another host, and stops after two", async () => {
        const offsite = fakeTransport(new Date(), {
            "https://www.rfs.nsw.gov.au/feeds/a.json": () => new Response(null, { status: 302, headers: { Location: "https://169.254.169.254/" } }),
        });
        await expect(safeFetch(offsite, "https://www.rfs.nsw.gov.au/feeds/a.json", { ...allowed, timeoutMs: 1000, maxBytes: 1000 })).rejects.toMatchObject({
            code: "redirect_refused",
        });
        const loop = fakeTransport(new Date(), {
            "https://www.rfs.nsw.gov.au/feeds/a.json": () => new Response(null, { status: 302, headers: { Location: "/feeds/a.json" } }),
        });
        await expect(safeFetch(loop, "https://www.rfs.nsw.gov.au/feeds/a.json", { ...allowed, timeoutMs: 1000, maxBytes: 1000 })).rejects.toMatchObject({
            code: "redirect_refused",
        });
        const same = fakeTransport(new Date(), {
            "https://www.rfs.nsw.gov.au/feeds/a.json": () => new Response(null, { status: 301, headers: { Location: "/feeds/b.json" } }),
            "https://www.rfs.nsw.gov.au/feeds/b.json": "{}",
        });
        expect(decodeText((await safeFetch(same, "https://www.rfs.nsw.gov.au/feeds/a.json", { ...allowed, timeoutMs: 1000, maxBytes: 1000 })).bytes)).toBe(
            "{}",
        );
    });

    it("enforces the size limit while streaming, and the timeout", async () => {
        const big = fakeTransport(new Date(), {
            "https://www.rfs.nsw.gov.au/feeds/big": () =>
                new Response(
                    new ReadableStream({
                        pull(c) {
                            c.enqueue(new Uint8Array(4096));
                        },
                    }),
                ),
        });
        await expect(safeFetch(big, "https://www.rfs.nsw.gov.au/feeds/big", { ...allowed, timeoutMs: 5000, maxBytes: 64_000 })).rejects.toMatchObject({
            code: "too_large",
        });
        const slow = fakeTransport(new Date(), {
            "https://www.rfs.nsw.gov.au/feeds/slow": (_u, init) =>
                new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
        });
        await expect(safeFetch(slow, "https://www.rfs.nsw.gov.au/feeds/slow", { ...allowed, timeoutMs: 50, maxBytes: 1000 })).rejects.toMatchObject({
            code: "timeout",
        });
    });

    it("tells a refused key and a rate limit apart from an outage", async () => {
        const t = fakeTransport(new Date(), {
            "https://www.rfs.nsw.gov.au/401": () => new Response("no", { status: 401 }),
            "https://www.rfs.nsw.gov.au/429": () => new Response("slow down", { status: 429 }),
        });
        await expect(safeFetch(t, "https://www.rfs.nsw.gov.au/401", { ...allowed, timeoutMs: 1000, maxBytes: 1000 })).rejects.toMatchObject({
            code: "credentials_rejected",
            retryable: false,
        });
        await expect(safeFetch(t, "https://www.rfs.nsw.gov.au/429", { ...allowed, timeoutMs: 1000, maxBytes: 1000 })).rejects.toMatchObject({
            code: "rate_limited",
            retryable: true,
        });
    });
});

describe("XML safety", () => {
    it("refuses DOCTYPE and ENTITY declarations (XXE, entity expansion)", () => {
        expect(() => parseXml('<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>')).toThrow(XmlError);
        expect(() => parseXml('<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><lolz>&lol2;</lolz>')).toThrow(XmlError);
    });

    it("bounds depth, element count and size, and rejects broken documents", () => {
        expect(() => parseXml(`${"<a>".repeat(100)}${"</a>".repeat(100)}`)).toThrow(/nested too deeply/);
        expect(() => parseXml(`<r>${"<i/>".repeat(50)}</r>`, { maxElements: 10 })).toThrow(/Too many elements/);
        expect(() => parseXml("<r>x</r>", { maxBytes: 3 })).toThrow(/too large/);
        expect(() => parseXml("<a><b></a></b>")).toThrow(XmlError);
        expect(() => parseXml("<a>")).toThrow(XmlError);
    });

    it("decodes only the predefined entities and character references; CDATA stays text", () => {
        const doc = parseXml('<r a="x &amp; y"><t>&lt;script&gt;alert(1)&lt;/script&gt; &#169; &unknown;</t><c><![CDATA[<b>bold</b>]]></c></r>');
        expect(doc.attrs.a).toBe("x & y");
        expect(doc.children[0].text).toBe("<script>alert(1)</script> © &unknown;");
        expect(doc.children[1].text).toBe("<b>bold</b>");
    });

    it("feed text becomes plain text (markup stripped), never HTML", () => {
        expect(plainText("Line one<br />Line two <img src=x onerror=alert(1)> <script>bad()</script> &amp; more")).toBe("Line one\nLine two bad() & more");
        expect(descriptionFields("ALERT LEVEL: Advice <br />STATUS: <b>Out</b> of control <br />TYPE: Bush Fire")).toEqual({
            "ALERT LEVEL": "Advice",
            STATUS: "Out of control",
            TYPE: "Bush Fire",
        });
    });

    it("decodes by byte order mark, not by a document's declaration", () => {
        expect(decodeText(new TextEncoder().encode('<?xml version="1.0" encoding="utf-16"?><r/>'))).toContain("<r/>");
        const utf16 = new Uint8Array([0xff, 0xfe, ...[..."<r/>"].flatMap((c) => [c.charCodeAt(0), 0])]);
        expect(decodeText(utf16)).toBe("<r/>");
    });
});

describe("Geometry safety", () => {
    it("rejects out-of-range coordinates, unsupported types and deep nesting", () => {
        expect(() => cleanGeometry({ type: "Point", coordinates: [200, 0] })).toThrow(GeometryError);
        expect(() => cleanGeometry({ type: "Point", coordinates: [Number.NaN, 0] })).toThrow(GeometryError);
        expect(() => cleanGeometry({ type: "Circle", coordinates: [1, 1] })).toThrow(GeometryError);
        let nested: unknown = { type: "Point", coordinates: [150, -33] };
        for (let i = 0; i < 6; i++) nested = { type: "GeometryCollection", geometries: [nested] };
        expect(() => cleanGeometry(nested)).toThrow(GeometryError);
        expect(cleanGeometry(null)).toBeNull();
    });

    it("thins oversized areas to the vertex budget, keeping them closed and never inventing points", () => {
        const ring = Array.from({ length: 50_000 }, (_, i) => [
            150 + Math.cos((i / 50_000) * 2 * Math.PI) * 0.1,
            -33 + Math.sin((i / 50_000) * 2 * Math.PI) * 0.1,
        ]);
        ring.push(ring[0]);
        const g = cleanGeometry({ type: "Polygon", coordinates: [ring] })!;
        const pts = [...positions(g)];
        expect(pts.length).toBeLessThanOrEqual(MAX_VERTICES + 2);
        expect(pts[0]).toEqual(pts[pts.length - 1]);
        const original = new Set(ring.map(([x, y]) => `${Math.round(x * 1e6) / 1e6},${Math.round(y * 1e6) / 1e6}`));
        expect(pts.every(([x, y]) => original.has(`${x},${y}`))).toBe(true);
    });

    it("parses CAP polygons (lat,lon order) into GeoJSON (lon,lat)", () => {
        expect(capPolygon("-33.1,150.1 -33.1,150.2 -33.2,150.2 -33.1,150.1")).toEqual([
            [150.1, -33.1],
            [150.2, -33.1],
            [150.2, -33.2],
            [150.1, -33.1],
        ]);
        expect(capPolygon("nonsense")).toBeNull();
    });
});

describe("FTP listing", () => {
    it("parses Unix listings and ignores anything else", () => {
        const now = new Date("2026-10-19T12:00:00Z");
        expect(parseListLine("-rw-rw-r--    1 1050     1502         6348 Oct 19 04:00 IDN10008.xml", now)).toEqual({
            name: "IDN10008.xml",
            modified: "2026-10-19T04:00:00Z",
            size: 6348,
        });
        expect(parseListLine("-rw-rw-r--    1 1050     1502         6348 Dec 30 04:00 IDN10008.xml", now)?.modified).toBe("2025-12-30T04:00:00Z");
        expect(parseListLine("drwxr-xr-x 2 1050 1502 4096 Oct 19 04:00 subdir", now)).toBeNull();
        expect(parseListLine("-rw-rw-r-- 1 1050 1502 1 Oct 19 04:00 ../../etc/passwd", now)).toBeNull();
        expect(parseListLine("garbage", now)).toBeNull();
    });
});
