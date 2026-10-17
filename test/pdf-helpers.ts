// Reading a printable invitation back: the text it draws, and the QR code decoded from the vector
// modules exactly as drawn, so a test proves the code on the page scans to the right link.
import jsQR from "jsqr";
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { PNG } from "pngjs";

async function pageStream(bytes: Uint8Array, index: number) {
    const document = await PDFDocument.load(bytes);
    const contents = document.getPage(index).node.Contents();
    const parts = contents instanceof PDFArray ? contents.asArray().map((ref) => document.context.lookup(ref)) : [contents];
    const streams = parts.filter((part): part is PDFRawStream => part instanceof PDFRawStream);
    return streams.map((stream) => new TextDecoder("latin1").decode(decodePDFRawStream(stream).decode())).join("\n");
}

/** The text a page draws. Standard-font text is written as hex strings in the content stream. */
export async function pdfText(bytes: Uint8Array, index = 0) {
    const raw = await pageStream(bytes, index);
    return [...raw.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)].map((match) => match[1].replace(/../g, (pair) => String.fromCharCode(parseInt(pair, 16)))).join("\n");
}

/** The invitation's QR panel (see printableInvitations): a 92pt white square at (102, 55) with a 4-module quiet zone. */
const BOX = { x: 102, y: 55, size: 92, quiet: 4 };

/** Decodes the QR code drawn on a page, or null when there isn't a readable one. */
export async function pdfQrCode(bytes: Uint8Array, index = 0) {
    const raw = await pageStream(bytes, index);
    // pdf-lib draws each module as a filled square: a translate to its corner, then a path of its size.
    const squares = [...raw.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) cm\n1 0 0 1 0 0 cm\n1 0 0 1 0 0 cm\n0 0 m\n0 ([\d.]+) l/g)]
        .map((match) => ({ x: Number(match[1]), y: Number(match[2]), size: Number(match[3]) }))
        .filter((s) => s.size < 5 && s.x >= BOX.x && s.x < BOX.x + BOX.size && s.y >= BOX.y && s.y < BOX.y + BOX.size);
    if (!squares.length) return null;
    const cell = squares[0].size - 0.02;
    const modules = Math.round(BOX.size / cell) - BOX.quiet * 2;
    const dark = new Set(
        squares.map((s) => {
            const column = Math.round((s.x - BOX.x) / cell) - BOX.quiet;
            const row = Math.round((BOX.y + BOX.size - s.y) / cell) - BOX.quiet - 1;
            return `${row}:${column}`;
        }),
    );
    const scale = 6;
    const width = (modules + BOX.quiet * 2) * scale;
    const png = new PNG({ width, height: width });
    for (let y = 0; y < width; y++)
        for (let x = 0; x < width; x++) {
            const row = Math.floor(y / scale) - BOX.quiet;
            const column = Math.floor(x / scale) - BOX.quiet;
            const offset = (y * width + x) * 4;
            png.data[offset] = png.data[offset + 1] = png.data[offset + 2] = dark.has(`${row}:${column}`) ? 0 : 255;
            png.data[offset + 3] = 255;
        }
    return jsQR(new Uint8ClampedArray(png.data), width, width)?.data ?? null;
}
