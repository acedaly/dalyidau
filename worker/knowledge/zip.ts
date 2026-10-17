// A minimal ZIP writer for exports: stored (uncompressed) entries with CRC-32 and UTF-8 names. Notes
// are small text, so compression isn't worth a dependency; any unzip tool reads these archives.
//
// Entry names are built by the export code, never taken from users, and are checked here as well:
// relative, forward slashes, no "." or ".." segments, no control characters.

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

export const crc32 = (bytes: Uint8Array) => {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
};

/** Whether a name is safe as a ZIP entry: no absolute paths, traversal or odd characters. */
export const isSafeEntryName = (name: string) =>
    name.length > 0 &&
    name.length <= 240 &&
    !name.startsWith("/") &&
    !/[\u0000-\u001F\u007F\\:*?"<>|]/.test(name) &&
    name.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");

export interface ZipEntry {
    name: string;
    data: string | Uint8Array;
}

const dosTime = (date: Date) => {
    const time = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
    const day = ((Math.max(date.getUTCFullYear(), 1980) - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
    return { time, day };
};

export function buildZip(entries: ZipEntry[], modified = new Date()): Uint8Array<ArrayBuffer> {
    const encoder = new TextEncoder();
    const { time, day } = dosTime(modified);
    const local: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;
    const seen = new Set<string>();

    for (const entry of entries) {
        if (!isSafeEntryName(entry.name)) throw new Error(`Unsafe ZIP entry name: ${JSON.stringify(entry.name.slice(0, 80))}`);
        if (seen.has(entry.name)) throw new Error(`Duplicate ZIP entry: ${entry.name}`);
        seen.add(entry.name);
        const name = encoder.encode(entry.name);
        const data = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
        const crc = crc32(data);

        const header = new Uint8Array(30 + name.length);
        const h = new DataView(header.buffer);
        h.setUint32(0, 0x04034b50, true); // local file header
        h.setUint16(4, 20, true); // version needed
        h.setUint16(6, 0x0800, true); // UTF-8 names
        h.setUint16(8, 0, true); // stored
        h.setUint16(10, time, true);
        h.setUint16(12, day, true);
        h.setUint32(14, crc, true);
        h.setUint32(18, data.length, true);
        h.setUint32(22, data.length, true);
        h.setUint16(26, name.length, true);
        h.setUint16(28, 0, true);
        header.set(name, 30);
        local.push(header, data);

        const record = new Uint8Array(46 + name.length);
        const c = new DataView(record.buffer);
        c.setUint32(0, 0x02014b50, true); // central directory header
        c.setUint16(4, 20, true); // version made by
        c.setUint16(6, 20, true);
        c.setUint16(8, 0x0800, true);
        c.setUint16(10, 0, true);
        c.setUint16(12, time, true);
        c.setUint16(14, day, true);
        c.setUint32(16, crc, true);
        c.setUint32(20, data.length, true);
        c.setUint32(24, data.length, true);
        c.setUint16(28, name.length, true);
        c.setUint32(42, offset, true);
        record.set(name, 46);
        central.push(record);
        offset += header.length + data.length;
    }

    const directorySize = central.reduce((n, part) => n + part.length, 0);
    const end = new Uint8Array(22);
    const e = new DataView(end.buffer);
    e.setUint32(0, 0x06054b50, true); // end of central directory
    e.setUint16(8, entries.length, true);
    e.setUint16(10, entries.length, true);
    e.setUint32(12, directorySize, true);
    e.setUint32(16, offset, true);

    if (offset + directorySize > 0xffffffff || entries.length > 0xffff) throw new Error("The export is too large for a ZIP file");
    const out = new Uint8Array(offset + directorySize + end.length);
    let at = 0;
    for (const part of [...local, ...central, end]) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}
