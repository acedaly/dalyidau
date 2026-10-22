// Office files (ZIP archives) are checked for decompression bombs before anything unpacks them
// (worker/lib/office-files.ts, used by Home & Assets uploads). The archives here are built in the test.
import { describe, expect, it } from "vitest";
import { zipBombReason } from "../worker/lib/office-files";

const text = (s: string) => new TextEncoder().encode(s);

/** A one-entry stored ZIP: local header, data, central directory and end record (no CRC: nothing here checks it). */
function zip(name: string, body: string): Uint8Array {
    const n = text(name);
    const data = text(body);
    const local = new Uint8Array(30 + n.length + data.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint32(18, data.length, true);
    l.setUint32(22, data.length, true);
    l.setUint16(26, n.length, true);
    local.set(n, 30);
    local.set(data, 30 + n.length);
    const central = new Uint8Array(46 + n.length);
    const c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, data.length, true);
    c.setUint16(28, n.length, true);
    central.set(n, 46);
    const end = new Uint8Array(22);
    const e = new DataView(end.buffer);
    e.setUint32(0, 0x06054b50, true);
    e.setUint16(8, 1, true);
    e.setUint16(10, 1, true);
    e.setUint32(12, central.length, true);
    e.setUint32(16, local.length, true);
    const out = new Uint8Array(local.length + central.length + end.length);
    out.set(local);
    out.set(central, local.length);
    out.set(end, local.length + central.length);
    return out;
}

describe("Office files", () => {
    it("reads the directory to refuse decompression bombs, and refuses something that isn't a ZIP", () => {
        const normal = zip("word/document.xml", "<w:document>Hello</w:document>");
        expect(zipBombReason(normal)).toBeNull();
        // Rewrite the central directory's uncompressed size to 4 GB: the classic bomb signature.
        const bomb = new Uint8Array(normal);
        const view = new DataView(bomb.buffer);
        for (let i = 0; i < bomb.length - 4; i++) if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, 0xfffffff0, true);
        expect(zipBombReason(bomb)).toMatch(/expands|compressed/);
        expect(zipBombReason(text("not a zip at all"))).toMatch(/complete/);
    });
});
