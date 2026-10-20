// A minimal, read-only anonymous FTP client over Workers TCP sockets, for the Bureau of
// Meteorology's anonymous FTP service (the channel the Bureau directs automated users to; fetch()
// can't speak FTP). It supports exactly what is needed: log in anonymously, list one directory with
// a pattern, and retrieve one file, with a byte limit and a deadline.
//
// Safety: only hosts on the allow-list are contacted; the data connection uses EPSV, so it goes to
// the same host as the control connection on the port the server names (never to an address the
// server supplies, which PASV would allow); file names and patterns are restricted to safe
// characters so nothing can be injected into the command stream.
import { connect } from "cloudflare:sockets";
import { FetchFailure } from "./net";

export interface FtpEntry {
    name: string;
    /** ISO time, from the listing (minute precision) */
    modified: string;
    size: number;
}

export interface FtpClient {
    list(host: string, dir: string, pattern: string): Promise<FtpEntry[]>;
    retrieve(host: string, path: string, maxBytes: number): Promise<Uint8Array>;
    /** Several files over one connection. A missing file is left out of the result. */
    retrieveMany(host: string, paths: string[], maxBytes: number): Promise<Map<string, Uint8Array>>;
}

export const FTP_HOSTS = ["ftp.bom.gov.au"] as const;
const SAFE_PATH = /^\/[A-Za-z0-9_./-]{1,200}$/;
const SAFE_PATTERN = /^[A-Za-z0-9_.*-]{1,40}$/;
const DEADLINE_MS = 25_000;

type Socket = ReturnType<typeof connect>;

class Control {
    private buffer = "";
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
    private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
    private readonly decoder = new TextDecoder();

    constructor(readonly socket: Socket) {
        this.reader = socket.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>;
        this.writer = socket.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>;
    }

    /** One complete reply (multi-line replies end with "NNN " on their last line). */
    async reply(): Promise<{ code: number; text: string }> {
        for (;;) {
            // Complete lines only (the last element is whatever hasn't ended yet).
            const lines = this.buffer.split("\r\n");
            const first = /^(\d{3})([ -])/.exec(lines[0] ?? "");
            if (first && lines.length > 1) {
                const end = first[2] === " " ? 0 : lines.findIndex((l, i) => i > 0 && i < lines.length - 1 && l.startsWith(`${first[1]} `));
                if (end >= 0) {
                    const text = lines.slice(0, end + 1).join("\n");
                    this.buffer = lines.slice(end + 1).join("\r\n");
                    return { code: Number(first[1]), text };
                }
            } else if (lines.length > 1 && !first) throw new FetchFailure("parse_error", "Unexpected FTP reply", null, false);
            if (this.buffer.length > 64_000) throw new FetchFailure("parse_error", "Unexpected FTP reply", null, false);
            const { done, value } = await this.reader.read();
            if (done) throw new FetchFailure("network", "The FTP server closed the connection");
            this.buffer += this.decoder.decode(value, { stream: true });
        }
    }

    async command(line: string, expect: (code: number) => boolean): Promise<{ code: number; text: string }> {
        if (/[\r\n]/.test(line)) throw new FetchFailure("not_allowed", "Refused an unsafe FTP command", null, false);
        await this.writer.write(new TextEncoder().encode(`${line}\r\n`));
        const reply = await this.reply();
        if (!expect(reply.code))
            throw new FetchFailure("http_error", `FTP ${line.split(" ")[0]} refused (${reply.code})`, reply.code, reply.code >= 400 && reply.code < 500);
        return reply;
    }

    async close() {
        try {
            await this.writer.write(new TextEncoder().encode("QUIT\r\n"));
        } catch {
            // Already closed.
        }
        await this.socket.close().catch(() => undefined);
    }
}

async function readAll(socket: Socket, maxBytes: number): Promise<Uint8Array> {
    const reader = socket.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            await socket.close().catch(() => undefined);
            throw new FetchFailure("too_large", `The file is larger than this source's limit (${Math.round(maxBytes / 1024)} KB)`, null, false);
        }
        chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.byteLength;
    }
    return out;
}

async function session<T>(host: string, work: (control: Control, openData: () => Promise<Socket>) => Promise<T>): Promise<T> {
    if (!(FTP_HOSTS as readonly string[]).includes(host)) throw new FetchFailure("not_allowed", "That FTP host isn't allowed", null, false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sockets: Socket[] = [];
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            for (const s of sockets) s.close().catch(() => undefined);
            reject(new FetchFailure("timeout", `No complete answer within ${DEADLINE_MS / 1000} s`));
        }, DEADLINE_MS);
    });
    const run = async () => {
        const socket = connect({ hostname: host, port: 21 });
        sockets.push(socket);
        const control = new Control(socket);
        try {
            const welcome = await control.reply();
            if (welcome.code !== 220) throw new FetchFailure("network", "The FTP server isn't accepting connections");
            await control.command("USER anonymous", (c) => c === 331 || c === 230);
            await control.command("PASS daly-portal@daly.id.au", (c) => c === 230 || c === 202);
            await control.command("TYPE I", (c) => c === 200);
            const openData = async () => {
                const epsv = await control.command("EPSV", (c) => c === 229);
                const port = Number(/\(\|\|\|(\d{1,5})\|\)/.exec(epsv.text)?.[1]);
                if (!port || port < 1024 || port > 65535) throw new FetchFailure("parse_error", "Unexpected passive port", null, false);
                const data = connect({ hostname: host, port });
                sockets.push(data);
                return data;
            };
            return await work(control, openData);
        } finally {
            await control.close();
        }
    };
    try {
        return await Promise.race([run(), deadline]);
    } catch (error) {
        if (error instanceof FetchFailure) throw error;
        throw new FetchFailure("network", "The FTP service couldn't be reached");
    } finally {
        clearTimeout(timer);
    }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Parses a Unix-style LIST line ("-rw-rw-r-- 1 1050 1502 6348 Oct 19 04:00 IDN10008.xml"). Times are UTC. */
export function parseListLine(line: string, now = new Date()): FtpEntry | null {
    const m = /^-\S{9}\s+\d+\s+\S+\s+\S+\s+(\d+)\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}:\d{2}|\d{4})\s+([A-Za-z0-9_.-]+)$/.exec(line.trim());
    if (!m) return null;
    const month = MONTHS.indexOf(m[2]);
    if (month < 0) return null;
    let year = now.getUTCFullYear();
    let time = "00:00";
    if (m[4].includes(":")) {
        time = m[4];
        // A listing shows the time only for the last six months; a "future" date belongs to last year.
        if (Date.UTC(year, month, Number(m[3])) > now.getTime() + 86_400_000) year--;
    } else year = Number(m[4]);
    const iso = `${year}-${String(month + 1).padStart(2, "0")}-${m[3].padStart(2, "0")}T${time}:00Z`;
    return { name: m[5], modified: iso, size: Number(m[1]) };
}

export const socketFtp: FtpClient = {
    list(host, dir, pattern) {
        if (!SAFE_PATH.test(dir) || !SAFE_PATTERN.test(pattern)) return Promise.reject(new FetchFailure("not_allowed", "Unsafe FTP path", null, false));
        return session(host, async (control, openData) => {
            await control.command(`CWD ${dir}`, (c) => c === 250);
            const data = await openData();
            await control.command(`LIST ${pattern}`, (c) => c === 150 || c === 125);
            const bytes = await readAll(data, 2_000_000);
            await control.reply();
            return new TextDecoder()
                .decode(bytes)
                .split(/\r?\n/)
                .map((l) => parseListLine(l))
                .filter((e): e is FtpEntry => !!e);
        });
    },
    async retrieve(host, path, maxBytes) {
        const found = (await this.retrieveMany(host, [path], maxBytes)).get(path);
        if (!found) throw new FetchFailure("http_error", "Not found", 404, false);
        return found;
    },
    retrieveMany(host, paths, maxBytes) {
        if (paths.length > 100 || paths.some((p) => !SAFE_PATH.test(p) || p.includes("..")))
            return Promise.reject(new FetchFailure("not_allowed", "Unsafe FTP path", null, false));
        return session(host, async (control, openData) => {
            const out = new Map<string, Uint8Array>();
            for (const path of paths) {
                const data = await openData();
                const start = await control.command(`RETR ${path}`, (c) => c === 150 || c === 125 || c === 550);
                if (start.code === 550) {
                    await data.close().catch(() => undefined);
                    continue;
                }
                out.set(path, await readAll(data, maxBytes));
                await control.reply();
            }
            return out;
        });
    },
};
