// Helpers for the Home & Assets tests. Every person, asset, registration, policy and document here
// is invented: no real VIN, registration number, policy reference, value or address.
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { expect } from "vitest";
import type { AssetDetail, AssetSummary, MaintenanceView, PolicyView, ScheduleView } from "../src/shared/assets/types";
import { OWNER, SECOND_OWNER, apiCall, db } from "./portal-helpers";

export const AS = "/api/portal/assets";
export const A = OWNER;
export const B = SECOND_OWNER; // the other portal owner: still sees none of A's private assets
export const ADMIN = "admin@example.com";
export const WEDDING_EDITOR = "wedding-editor@example.com";

export const call = <R = unknown>(method: string, path: string, body?: unknown, email = A) => apiCall<R>(method, `${AS}${path}`, body, { email });

export async function createAsset(body: Record<string, unknown>, email = A): Promise<AssetSummary> {
    const result = await call<{ asset: AssetSummary }>("POST", "/items", body, email);
    expect(result.status, result.text).toBe(201);
    return result.json.asset;
}

export async function detail(id: string, email = A): Promise<AssetDetail> {
    const result = await call<{ detail: AssetDetail }>("GET", `/items/${id}`, undefined, email);
    expect(result.status, result.text).toBe(200);
    return result.json.detail;
}

export async function share(id: string, body: Record<string, unknown>, email = A) {
    const version = (await detail(id, email)).asset.version;
    const result = await call("PUT", `/items/${id}/sharing`, { version, ...body }, email);
    expect(result.status, result.text).toBe(200);
    return result.json;
}

export const NONE = { edit: false, maintain: false, financial: false, insurance: false, documents: false };

export async function schedule(body: Record<string, unknown>, email = A): Promise<ScheduleView> {
    const result = await call<{ schedule: ScheduleView }>("POST", "/schedules", body, email);
    expect(result.status, result.text).toBe(201);
    return result.json.schedule;
}

export async function record(body: Record<string, unknown>, email = A): Promise<MaintenanceView> {
    const result = await call<{ record: MaintenanceView }>("POST", "/maintenance", body, email);
    expect(result.status, result.text).toBe(201);
    return result.json.record;
}

export async function policy(body: Record<string, unknown>, email = A): Promise<PolicyView> {
    const result = await call<{ policy: PolicyView }>("POST", "/policies", body, email);
    expect(result.status, result.text).toBe(201);
    return result.json.policy;
}

export const base64 = (bytes: Uint8Array) => {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
};

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));
const segment = (marker: number, payload: number[]) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];

/**
 * A tiny JPEG-shaped file (not a decodable picture): JFIF, an EXIF segment with a fake GPS tag, an
 * APP2 segment carrying readable text (the AI stand-in "describes" a photo by its readable text),
 * a frame header with its size and an empty scan.
 */
export function jpeg(options: { description?: string; width?: number; height?: number; exif?: string } = {}) {
    const w = options.width ?? 640;
    const h = options.height ?? 480;
    return new Uint8Array([
        0xff,
        0xd8,
        ...segment(0xe0, ascii("JFIF\0\x01\x01\0\0\x01\0\x01\0\0")),
        ...segment(0xe1, ascii(`Exif\0\0${options.exif ?? "GPSLatitude -33.8688 GPSLongitude 151.2093 CameraSerial SN-TEST-0001"}`)),
        ...segment(0xe2, ascii(options.description ?? "A photo of an item on a bench.")),
        ...segment(0xc0, [8, h >> 8, h & 0xff, w >> 8, w & 0xff, 1, 1, 0x11, 0]),
        ...segment(0xda, [1, 1, 0, 0, 0x3f, 0]),
        0x00,
        0xff,
        0xd9,
    ]);
}

export const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.4\n${text}\n%%EOF\n`);

export async function upload(body: Record<string, unknown> & { bytes: Uint8Array }, email = A) {
    const { bytes, ...rest } = body;
    return call<{ file: { id: string; kind: string; contentType: string; filename: string; width: number | null }; duplicate: boolean; alsoOn: unknown[] }>(
        "POST",
        "/files",
        { filename: "file.jpg", kind: "photo", data: base64(bytes), ...rest },
        email,
    );
}

/** Reads a QR code back from the SVG the qrcode library draws (one path of horizontal runs per row). */
export function decodeQrSvg(svg: string): string | null {
    const size = Number(/viewBox="0 0 (\d+) \1"/.exec(svg)?.[1]);
    const path = /<path stroke="#000000" d="([^"]+)"/.exec(svg)?.[1];
    if (!size || !path) return null;
    const dark = new Set<string>();
    let x = 0;
    let y = 0;
    for (const [, op, a, b] of path.matchAll(/([Mmh])([\d.]+)(?: ([\d.]+))?/g)) {
        if (op === "M") {
            x = Number(a);
            y = Number(b);
        } else if (op === "m") {
            x += Number(a);
            y += Number(b);
        } else {
            for (let i = 0; i < Number(a); i++) dark.add(`${Math.floor(y)}:${x + i}`);
            x += Number(a);
        }
    }
    const scale = 6;
    const width = size * scale;
    const png = new PNG({ width, height: width });
    for (let py = 0; py < width; py++)
        for (let px = 0; px < width; px++) {
            const o = (py * width + px) * 4;
            png.data[o] = png.data[o + 1] = png.data[o + 2] = dark.has(`${Math.floor(py / scale)}:${Math.floor(px / scale)}`) ? 0 : 255;
            png.data[o + 3] = 255;
        }
    return jsQR(new Uint8ClampedArray(png.data), width, width)?.data ?? null;
}

export const activity = async () =>
    (await db().prepare("SELECT actor, action, entity_type, entity_id, asset_id, via FROM asset_activity ORDER BY id").all<Record<string, string | null>>())
        .results;

export const addPortalUser = (email: string, role: "admin" | "editor" | "viewer") => apiCall("POST", "/api/portal/users", { email, role });

/** Today in Sydney, and a date some days from it. */
export const sydneyToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date());
export const plusDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
