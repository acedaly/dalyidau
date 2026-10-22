// Checks on uploaded Office files (ZIP archives) before anything decompresses one.

/**
 * Office files are ZIP archives: before anything decompresses one, its central directory is read
 * to refuse decompression bombs (huge or suspiciously compressible contents, ZIP64, too many entries).
 */
export function zipBombReason(bytes: Uint8Array, limits = { maxEntries: 2_000, maxTotal: 100_000_000, maxRatio: 200 }): string | null {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
        if (view.getUint32(i, true) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) return "That document isn't a complete Office file";
    const entries = view.getUint16(eocd + 10, true);
    const offset = view.getUint32(eocd + 16, true);
    if (entries === 0xffff || offset === 0xffffffff) return "Very large (ZIP64) Office files aren't supported";
    if (entries > limits.maxEntries) return "That document has too many parts to process safely";
    let total = 0;
    let compressed = 0;
    let p = offset;
    for (let n = 0; n < entries; n++) {
        if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) return "That document's structure is damaged";
        compressed += view.getUint32(p + 20, true);
        total += view.getUint32(p + 24, true);
        p += 46 + view.getUint16(p + 28, true) + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
    }
    if (total > limits.maxTotal) return "That document expands to more than can be processed safely";
    if (compressed > 0 && total / compressed > limits.maxRatio) return "That document is compressed suspiciously well and wasn't processed";
    return null;
}
