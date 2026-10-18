// Reads the CSV files out of a Todoist backup (a zip of one CSV per project) in the browser, with
// the platform's own DecompressionStream: no library, and the zip never leaves the device. Only
// stored and deflated entries ending in .csv are read, each at most `maxBytes` once unpacked;
// anything else (folders, other files, encrypted or zip64 archives) is skipped or refused.
export class ZipError extends Error {}

const u16 = (b: DataView, o: number) => b.getUint16(o, true);
const u32 = (b: DataView, o: number) => b.getUint32(o, true);

async function inflate(data: Uint8Array, maxBytes: number): Promise<Uint8Array> {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel();
            throw new ZipError("A file in the zip is too large to import");
        }
        chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) (out.set(c, offset), (offset += c.byteLength));
    return out;
}

export async function csvFilesFromZip(buffer: ArrayBuffer, maxBytes: number, maxFiles: number): Promise<{ name: string; text: string }[]> {
    const view = new DataView(buffer);
    // The end-of-central-directory record is within the last 64 KB.
    let eocd = -1;
    for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65_557); i--)
        if (u32(view, i) === 0x06054b50) {
            eocd = i;
            break;
        }
    if (eocd < 0) throw new ZipError("That isn't a zip file");
    const entries = u16(view, eocd + 10);
    let p = u32(view, eocd + 16);
    const files: { name: string; text: string }[] = [];
    const decoder = new TextDecoder("utf-8", { fatal: false });
    for (let i = 0; i < entries; i++) {
        if (u32(view, p) !== 0x02014b50) throw new ZipError("The zip file is damaged");
        const flags = u16(view, p + 8);
        const method = u16(view, p + 10);
        const size = u32(view, p + 20);
        const nameLength = u16(view, p + 28);
        const extra = u16(view, p + 30);
        const comment = u16(view, p + 32);
        const local = u32(view, p + 42);
        const name = decoder.decode(new Uint8Array(buffer, p + 46, nameLength));
        p += 46 + nameLength + extra + comment;
        if (!/\.csv$/i.test(name) || name.startsWith("__MACOSX/")) continue;
        if (flags & 1) throw new ZipError("Encrypted zip files can't be read");
        if (size === 0xffffffff) throw new ZipError("This zip file is too large");
        if (files.length >= maxFiles) throw new ZipError(`The zip has more than ${maxFiles} projects; import them in smaller groups`);
        const start = local + 30 + u16(view, local + 26) + u16(view, local + 28);
        const data = new Uint8Array(buffer, start, size);
        let bytes: Uint8Array;
        if (method === 0) bytes = data;
        else if (method === 8) bytes = await inflate(data, maxBytes);
        else throw new ZipError(`${name} is compressed in a way that can't be read`);
        if (bytes.byteLength > maxBytes) throw new ZipError(`${name} is too large to import`);
        files.push({ name: name.split("/").pop()!, text: decoder.decode(bytes) });
    }
    return files;
}
