// Reads pixel dimensions from image headers so <img> tags can reserve space (no layout shift).

export const ALLOWED_IMAGE_TYPES: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/avif": "avif",
};

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export const imageDimensions = (bytes: Uint8Array, type: string): { width: number; height: number } | null => {
    try {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (type === "image/png" && bytes.length > 24) return { width: view.getUint32(16), height: view.getUint32(20) };
        if (type === "image/gif" && bytes.length > 10) return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
        if (type === "image/jpeg") return jpegDimensions(bytes, view);
        if (type === "image/webp") return webpDimensions(bytes, view);
    } catch {
        // Fall through: dimensions are a nicety, not a requirement.
    }
    return null;
};

const jpegDimensions = (bytes: Uint8Array, view: DataView) => {
    let offset = 2;
    while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) return null;
        const marker = bytes[offset + 1];
        const length = view.getUint16(offset + 2);
        // SOF0..SOF15, excluding DHT (C4), JPG (C8) and DAC (CC).
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
        }
        offset += 2 + length;
    }
    return null;
};

const webpDimensions = (bytes: Uint8Array, view: DataView) => {
    const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (chunk === "VP8X")
        return { width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)), height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) };
    if (chunk === "VP8 ") return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    if (chunk === "VP8L") {
        const b = view.getUint32(21, true);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    return null;
};

const WIDTHS = [480, 768, 1200, 1600];

/** Public URL for an R2 media key, plus a srcset when Cloudflare image transformations are enabled. */
export const mediaUrls = (key: string, width: number | null | undefined, transforms: boolean) => {
    const src = `/media/${key}`;
    if (!transforms) return { src };
    const widths = WIDTHS.filter((w) => !width || w < width);
    if (width) widths.push(Math.min(width, 2000));
    const srcSet = widths.map((w) => `/cdn-cgi/image/width=${w},format=auto,quality=82${src} ${w}w`).join(", ");
    return { src, srcSet };
};
