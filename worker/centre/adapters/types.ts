// What every source adapter receives and returns. An adapter only fetches and parses: storing,
// change detection, alerts and history are the ingestion engine's (worker/centre/ingest.ts), so a
// new public dataset is one adapter file plus a registry entry.
import { zonedInstant } from "../../../src/shared/calendar/time";
import type { HazardCategory, SourceDefinition } from "../../../src/shared/centre/sources";
import type { CentreSettings, GeometryQuality, RecordKind, RecordMetric } from "../../../src/shared/centre/types";
import type { Env } from "../../env";
import type { Geometry, Position } from "../geo";
import type { CentreTransport } from "../net";

export interface ParsedRecord {
    externalId: string;
    kind: RecordKind;
    category: HazardCategory;
    eventType?: string | null;
    title: string;
    description?: string | null;
    status?: string | null;
    /** The provider's own published level. Never derived. */
    warningLevel?: string | null;
    /** For sorting and filtering only; never shown as a level. */
    severityRank?: number;
    point?: Position | null;
    geometry?: Geometry | null;
    geometryQuality: GeometryQuality;
    uncertaintyM?: number | null;
    areaName?: string | null;
    publishedAt?: string | null;
    updatedAt?: string | null;
    observedAt?: string | null;
    sourceUrl?: string | null;
    metrics?: RecordMetric[];
    attrs?: Record<string, string>;
    /** The provider says, in its data, that this is over (CAP "Cancel", RFS status "Out", an ended road hazard). */
    ended?: boolean;
}

export interface SeriesPoint {
    externalId: string;
    metric: string;
    at: string;
    value: number;
}

export interface ParsedBatch {
    records: ParsedRecord[];
    /**
     * The response lists everything currently published, so a record missing from it is "no longer
     * in the feed" (never "resolved"). False for partial or windowed responses.
     */
    complete: boolean;
    /** Records the adapter didn't re-download because they're unchanged, to keep as seen. */
    keep?: string[];
    /** The newest publication time in the response (replay protection). */
    publishedAt: string | null;
    series?: SeriesPoint[];
    /** The adapter's cursor for next time, if it changed. */
    state?: Record<string, unknown>;
    bytes: number;
    httpStatus: number | null;
    etag?: string | null;
    lastModified?: string | null;
    /** Hash of the raw response, to recognise an identical re-send. */
    contentHash?: string | null;
    notModified?: boolean;
    /** A raw copy for the R2 snapshot (only kept for sources whose terms allow history). */
    snapshot?: Uint8Array;
}

export interface AdapterContext {
    env: Env;
    transport: CentreTransport;
    source: SourceDefinition;
    state: Record<string, unknown>;
    etag: string | null;
    lastModified: string | null;
    settings: CentreSettings;
    now: Date;
    /** The source's key, when it needs one. Never logged or stored. */
    secret: string | null;
}

export interface Adapter {
    id: string;
    allowedHosts: readonly string[];
    run(ctx: AdapterContext): Promise<ParsedBatch>;
}

// --- Parsing helpers shared by adapters ------------------------------------------------------------

export const SYDNEY = "Australia/Sydney";

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number) => String(n).padStart(2, "0");

/** An ISO instant from a provider's local wall-clock time in Sydney, or null if it doesn't parse. */
export function sydneyInstant(y: number, mo: number, d: number, h: number, mi: number): string | null {
    if (![y, mo, d, h, mi].every(Number.isFinite) || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
    return zonedInstant(`${y}-${pad(mo)}-${pad(d)}`, `${pad(h)}:${pad(mi)}`, SYDNEY);
}

/** "19/09/2026 12:00:00 AM" (RFS pubDate), Sydney time. */
export function parseDmyTime(value: string | null | undefined): string | null {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i.exec((value ?? "").trim());
    if (!m) return null;
    let h = Number(m[4]);
    if (m[6]) h = (h % 12) + (m[6].toUpperCase() === "PM" ? 12 : 0);
    return sydneyInstant(Number(m[3]), Number(m[2]), Number(m[1]), h, Number(m[5]));
}

/** "19 Sep 2026 10:00" or "19 Oct 2026 19:25:42.57" (RFS and ACT descriptions), Sydney time. */
export function parseDayMonthTime(value: string | null | undefined): string | null {
    const m = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})\s+(\d{1,2}):(\d{2})/.exec((value ?? "").trim());
    if (!m) return null;
    return sydneyInstant(Number(m[3]), MONTHS[m[2].toLowerCase()] ?? NaN, Number(m[1]), Number(m[4]), Number(m[5]));
}

/** "2026-10-19 11:30" (Endeavour, ACT pubDate without its zone label), Sydney time. */
export function parseLocalIsoish(value: string | null | undefined): string | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec((value ?? "").trim());
    if (!m) return null;
    if (m[1] === "1970") return null; // "1970-01-01 00:00" means "not set" in Endeavour's data.
    return sydneyInstant(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
}

/** A strict ISO instant (with a zone), normalised, or null. */
export function isoInstant(value: unknown): string | null {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) || !/(Z|[+-]\d{2}:?\d{2})$/.test(value.trim())) return null;
    const t = Date.parse(value);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** An HTTP date (Last-Modified), as ISO. */
export const httpDate = (value: string | null | undefined): string | null => {
    if (!value) return null;
    const t = Date.parse(value);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

export const clip = (value: unknown, max: number): string | null => {
    if (value === null || value === undefined) return null;
    // eslint-disable-next-line no-control-regex
    const text = String(value)
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
        .trim();
    return text ? text.slice(0, max) : null;
};

export const finite = (value: unknown): number | null => {
    const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    return Number.isFinite(n) ? n : null;
};

export const metric = (key: string, label: string, value: unknown, unit: string): RecordMetric | null => {
    const n = finite(value);
    return n === null ? null : { key, label, value: Math.round(n * 1000) / 1000, unit };
};

export const metrics = (...items: (RecordMetric | null)[]) => items.filter((m): m is RecordMetric => !!m);

/** Only https (or http) links go out to people; anything else is dropped. */
export const safeLink = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    try {
        const u = new URL(value.trim());
        return u.protocol === "https:" || u.protocol === "http:" ? u.toString().slice(0, 500) : null;
    } catch {
        return null;
    }
};

export const titleCase = (value: string) => value.toLowerCase().replace(/(^|[\s/-])([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase());

export async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
    const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
    const digest = await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
