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

/** Larger than any photo or screenshot the site would show; a file claiming more is refused, not decoded by visitors. */
export const MAX_IMAGE_SIDE = 20000;
export const MAX_IMAGE_PIXELS = 100_000_000;

const ascii = (bytes: Uint8Array, at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));

/** Whether a PNG's chunks run, whole, from IHDR through image data to IEND. */
function pngProblem(bytes: Uint8Array, view: DataView): string | null {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (!signature.every((b, i) => bytes[i] === b)) return "isn't a PNG";
    let offset = 8;
    let first = true;
    let data = false;
    while (offset + 12 <= bytes.length) {
        const length = view.getUint32(offset);
        const type = ascii(bytes, offset + 4, 4);
        if (length > bytes.length - offset - 12) return "is cut short";
        if (first && (type !== "IHDR" || length !== 13)) return "is damaged";
        first = false;
        if (type === "IDAT") data = true;
        if (type === "IEND") return data ? null : "has no picture in it";
        offset += 12 + length;
    }
    return "is cut short";
}

/** Whether a JPEG has its start, a frame header before the picture data, and its end marker. */
function jpegProblem(bytes: Uint8Array, view: DataView): string | null {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return "isn't a JPEG";
    let offset = 2;
    let frame = false;
    while (offset + 4 <= bytes.length) {
        if (bytes[offset] !== 0xff) return "is damaged";
        const marker = bytes[offset + 1];
        if (marker === 0xff) {
            offset += 1; // fill byte
            continue;
        }
        if (marker === 0xda) {
            if (!frame) return "is damaged";
            // The picture data runs from here; the file must still reach its end marker.
            for (let i = bytes.length - 2; i > offset; i--) if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) return null;
            return "is cut short";
        }
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            offset += 2;
            continue;
        }
        const length = view.getUint16(offset + 2);
        if (length < 2 || offset + 2 + length > bytes.length) return "is cut short";
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) frame = true;
        offset += 2 + length;
    }
    return "is cut short";
}

function gifProblem(bytes: Uint8Array): string | null {
    const header = ascii(bytes, 0, 6);
    if (header !== "GIF87a" && header !== "GIF89a") return "isn't a GIF";
    let end = bytes.length - 1;
    while (end > 13 && bytes[end] === 0) end--; // some encoders pad with zeros
    return bytes[end] === 0x3b ? null : "is cut short";
}

/** Whether a WebP's chunks fill the file exactly as its header says, with picture data that starts as it must. */
function webpProblem(bytes: Uint8Array, view: DataView): string | null {
    if (bytes.length < 30 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return "isn't a WebP";
    const end = view.getUint32(4, true) + 8;
    if (end > bytes.length) return "is cut short";
    // Nothing but one padding byte may follow what the header accounts for.
    if (bytes.length - end > 1) return "is damaged";
    if (!["VP8 ", "VP8L", "VP8X"].includes(ascii(bytes, 12, 4))) return "is damaged";
    let offset = 12;
    let picture = false;
    while (offset + 8 <= end) {
        const type = ascii(bytes, offset, 4);
        const length = view.getUint32(offset + 4, true);
        const data = offset + 8;
        if (length > end - data) return "is cut short";
        // A lossy frame carries the start code 9d 01 2a after its 3-byte tag; a lossless one starts with 0x2f.
        if (type === "VP8 ") {
            if (length < 10 || bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a) return "is damaged";
            picture = true;
        } else if (type === "VP8L") {
            if (length < 5 || bytes[data] !== 0x2f) return "is damaged";
            picture = true;
        } else if (type === "ANMF") picture = true;
        offset = data + length + (length & 1);
    }
    if (offset < end) return "is cut short";
    return picture ? null : "has no picture in it";
}

/** Whether an AVIF's boxes are whole, start with an AVIF file type and include the picture's description. */
function avifProblem(bytes: Uint8Array, view: DataView): string | null {
    if (bytes.length < 16 || ascii(bytes, 4, 4) !== "ftyp") return "isn't an AVIF";
    let offset = 0;
    let meta = false;
    let first = true;
    while (offset + 8 <= bytes.length) {
        let size = view.getUint32(offset);
        const type = ascii(bytes, offset + 4, 4);
        let header = 8;
        if (size === 1) {
            if (offset + 16 > bytes.length || view.getUint32(offset + 8) !== 0) return "is damaged";
            size = view.getUint32(offset + 12);
            header = 16;
        } else if (size === 0) size = bytes.length - offset;
        if (size < header) return "is damaged";
        if (size > bytes.length - offset) return "is cut short";
        if (first) {
            const brands = [ascii(bytes, offset + 8, 4)];
            for (let at = offset + 16; at + 4 <= offset + size; at += 4) brands.push(ascii(bytes, at, 4));
            if (!brands.some((b) => b === "avif" || b === "avis")) return "isn't an AVIF";
            first = false;
        }
        if (type === "meta") meta = true;
        offset += size;
    }
    if (offset !== bytes.length) return "is cut short";
    return meta ? null : "has no picture in it";
}

/**
 * Why a file can't be published as an image of this type, or null. This reads the file's structure, not
 * its pixels: it catches a file that only starts like an image, one that's cut short or missing its
 * picture, and one that claims an absurd size (which would cost a visitor's browser the memory to decode).
 * It is not a decoder: a file that is whole and well-formed but whose compressed picture data is corrupt
 * passes, and shows as a broken or partial picture in the browser, which decodes it in its own sandbox.
 */
export function imageProblem(bytes: Uint8Array, type: string): string | null {
    if (!ALLOWED_IMAGE_TYPES[type]) return "isn't a JPEG, PNG, GIF, WebP or AVIF";
    if (bytes.byteLength > MAX_IMAGE_BYTES) return "is over 15 MB";
    try {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const problem =
            type === "image/png"
                ? pngProblem(bytes, view)
                : type === "image/jpeg"
                  ? jpegProblem(bytes, view)
                  : type === "image/gif"
                    ? gifProblem(bytes)
                    : type === "image/webp"
                      ? webpProblem(bytes, view)
                      : avifProblem(bytes, view);
        if (problem) return problem;
    } catch {
        return "is damaged";
    }
    const size = imageDimensions(bytes, type);
    // AVIF's size sits deep in its boxes and isn't read here.
    if (type === "image/avif") return null;
    if (!size || size.width < 1 || size.height < 1) return "has no readable size";
    if (size.width > MAX_IMAGE_SIDE || size.height > MAX_IMAGE_SIDE || size.width * size.height > MAX_IMAGE_PIXELS) return "is too large (over 100 megapixels)";
    return null;
}

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
