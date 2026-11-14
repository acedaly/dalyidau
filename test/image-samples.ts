// Real 4×3 images (made with sips and cwebp from a generated PNG): one of each type the site publishes.
export const SAMPLE_IMAGES = {
    png: "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAYAAAC09K7GAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAABKADAAQAAAABAAAAAwAAAAB3TCISAAAAFklEQVQIHWNk+M9Qz4AEmJDYYCaGAABI7AGEEuUmbAAAAABJRU5ErkJggg==",
    jpeg: "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAABKADAAQAAAABAAAAAwAAAAD/wAARCAADAAQDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/9sAQwECAgIEBAQHBAQHEAsJCxAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ/90ABAAB/9oADAMBAAIRAxEAPwD9LKKKK/lc/is//9k=",
    gif: "R0lGODdhBAADAJEAAAAAAAD/AP///wAAACH5BAkAAAMAIf8LWE1QIERhdGFYTVD/PHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXB0az0iWE1QIENvcmUgNi4wLjAiPgogICA8cmRmOlJERiB4bWxuczpyZGY9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5bnRheC1ucyMiPgogICAgICA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIgogICAgICAgICAgICB4bWxuczpleGlmPSJodHRwOi8vbnMuYWRvYmUuY29tL2V4aWYvMS4wLyI+CiAgICAgICAgIDxleGlmOkNvbG9yU3BhY2U+MTwvZXhpsmY6Q29sb3JTcGFjZT4KICAgICAgICAgPGV4aWY6UGl4ZWxYRGltZW5zaW9uPjQ8L2V4aWY6UGl4ZWxYRGltZW5zaW9uPgogICAgICAgICA8ZXhpZjpQaXhlbFlEaW1lbnNpb24+MzwvZXhpZjpQaXhlbFlEaW1lbnNpb24+CiAgICAgIDwvcmRmOkRlc2NyaXB0aW9uPgogICA8L3JkZjpSREY+CjwveDp4bXBtZXRhPgoALAAAAAAEAAMAAAIDjI9WADs=",
    webp: "UklGRmAAAABXRUJQVlA4WAoAAAAQAAAAAwAAAgAAQUxQSAoAAAABB9C/iAhERP8DVlA4IDAAAAAQAgCdASoEAAMAAgA0JaACdLoB+AH4AAPIAP7mad/7WgODVf5n//vvhRHbr/MUAAA=",
    webpLossless: "UklGRhwAAABXRUJQVlA4TA8AAAAvA4AAEAfQ/4j+BSKi/wEA",
    avif: "AAAAGGZ0eXBhdmlmAAAAAGF2aWZtaWYxAAACEm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAADnBpdG0AAAAAAAEAAABNaWluZgAAAAAAAwAAABVpbmZlAgAAAAABAABhdjAxAAAAABVpbmZlAgAAAQACAABhdjAxAAAAABVpbmZlAgAAAQADAABFeGlmAAAAAChpcmVmAAAAAAAAAA5hdXhsAAIAAQABAAAADmNkc2MAAwABAAEAAAEEaXBycAAAANlpcGNvAAAAE2NvbHJuY2x4AAIAAgAGgAAAAAxjbGxpAMsAQAAAABRpc3BlAAAAAAAAAAQAAAAEAAAAKGNsYXAAAAAEAAAAAQAAAAMAAAABAAAAAAAAAAH/wAAAAIAAAAAAAAlpcm90AAAAABBwaXhpAAAAAAMICAgAAAAOcGl4aQAAAAABCAAAADdhdXhDAAAAAHVybjptcGVnOmhldmM6MjAxNTphdXhpZDoxAAAAAAwAAAAITgGlBAAB/kAAAAAMYXYxQ4EADAAAAAAMYXYxQ4EAHAAAAAAjaXBtYQAAAAAAAAACAAEHgQIDBomEhQACBgMHiIqEhQAAADppbG9jAAAAAEQAAAMAAQAAAAEAAAKIAAAAMAACAAAAAQAAArgAAAAjAAMAAAABAAACOgAAAE4AAAABbWRhdAAAAAAAAACxAAAABkV4aWYAAE1NACoAAAAIAAGHaQAEAAAAAQAAABoAAAAAAAOgAQADAAAAAQABAACgAgAEAAAAAQAAAASgAwAEAAAAAQAAAAMAAAAAEgAKDAAAAACPn/8CBAQNCDIeEAGSAAgggigDWRP4pXv1MyXnELFy6tdtdqwe7UiAEgAKCQAAAACPn/8FQDIUEAGOACCKCr0aM7SGI26/tQwmkRA=",
} as const;

export const sampleImage = (name: keyof typeof SAMPLE_IMAGES) => Uint8Array.from(atob(SAMPLE_IMAGES[name]), (c) => c.charCodeAt(0));

const crc32 = (bytes: Uint8Array) => {
    let crc = ~0;
    for (const byte of bytes) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return ~crc >>> 0;
};
const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(
        [...type].map((c) => c.charCodeAt(0)),
        4,
    );
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
};

/** A real, whole PNG of any size (plain grey), for tests that need an image wider than the 4×3 samples. */
export async function pngOfSize(width: number, height: number): Promise<Uint8Array> {
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    header.set([8, 0, 0, 0, 0], 8); // 8-bit greyscale
    // Each row: a filter byte (none) and one grey byte per pixel.
    const raw = new Uint8Array(height * (width + 1)).fill(0x80);
    for (let y = 0; y < height; y++) raw[y * (width + 1)] = 0;
    const deflated = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
    const parts = [
        Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", header),
        chunk("IDAT", deflated),
        chunk("IEND", new Uint8Array(0)),
    ];
    const png = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
    let at = 0;
    for (const part of parts) {
        png.set(part, at);
        at += part.length;
    }
    return png;
}
