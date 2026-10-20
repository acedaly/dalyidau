// A tiny PMTiles v3 archive for tests (https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md):
// a 127-byte header, one root directory (no leaves, internal compression none), empty metadata and
// gzip-compressed tile bodies. The tiles are invented bytes, not real map data: the tests check that
// the Worker finds, decompresses and serves the right tile, not what it draws.
import { zxyToTileId } from "pmtiles";

const varint = (out: number[], value: number) => {
    let v = value;
    while (v >= 0x80) {
        out.push((v & 0x7f) | 0x80);
        v = Math.floor(v / 128);
    }
    out.push(v);
};

const gzip = async (bytes: Uint8Array) =>
    new Uint8Array(await new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());

export async function pmtilesFixture(
    tiles: { z: number; x: number; y: number; body: string }[],
    bounds: [number, number, number, number] = [140.9, -37.6, 153.7, -28.1],
) {
    const entries = await Promise.all(tiles.map(async (t) => ({ id: zxyToTileId(t.z, t.x, t.y), data: await gzip(new TextEncoder().encode(t.body)) })));
    entries.sort((a, b) => a.id - b.id);
    let offset = 0;
    const placed = entries.map((e) => {
        const at = offset;
        offset += e.data.length;
        return { ...e, offset: at };
    });
    // Root directory: count, tile id deltas, run lengths, lengths, offsets (0 = contiguous with the previous).
    const dir: number[] = [];
    varint(dir, placed.length);
    let last = 0;
    for (const e of placed) {
        varint(dir, e.id - last);
        last = e.id;
    }
    for (const _ of placed) varint(dir, 1);
    for (const e of placed) varint(dir, e.data.length);
    placed.forEach((e, i) => varint(dir, i > 0 && e.offset === placed[i - 1].offset + placed[i - 1].data.length ? 0 : e.offset + 1));
    const metadata = new TextEncoder().encode("{}");
    const rootOffset = 127;
    const metadataOffset = rootOffset + dir.length;
    const dataOffset = metadataOffset + metadata.length;
    const header = new DataView(new ArrayBuffer(127));
    new Uint8Array(header.buffer).set(new TextEncoder().encode("PMTiles"), 0);
    header.setUint8(7, 3);
    const u64 = (at: number, v: number) => header.setBigUint64(at, BigInt(v), true);
    u64(8, rootOffset);
    u64(16, dir.length);
    u64(24, metadataOffset);
    u64(32, metadata.length);
    u64(40, dataOffset + offset);
    u64(48, 0);
    u64(56, dataOffset);
    u64(64, offset);
    u64(72, placed.length);
    u64(80, placed.length);
    u64(88, placed.length);
    header.setUint8(96, 1); // clustered
    header.setUint8(97, 1); // internal compression: none
    header.setUint8(98, 2); // tile compression: gzip
    header.setUint8(99, 1); // MVT
    header.setUint8(100, Math.min(...tiles.map((t) => t.z)));
    header.setUint8(101, Math.max(...tiles.map((t) => t.z)));
    const e7 = (at: number, v: number) => header.setInt32(at, Math.round(v * 1e7), true);
    e7(102, bounds[0]);
    e7(106, bounds[1]);
    e7(110, bounds[2]);
    e7(114, bounds[3]);
    header.setUint8(118, Math.min(...tiles.map((t) => t.z)));
    e7(119, (bounds[0] + bounds[2]) / 2);
    e7(123, (bounds[1] + bounds[3]) / 2);
    const out = new Uint8Array(dataOffset + offset);
    out.set(new Uint8Array(header.buffer), 0);
    out.set(dir, rootOffset);
    out.set(metadata, metadataOffset);
    for (const e of placed) out.set(e.data, dataOffset + e.offset);
    return out;
}
