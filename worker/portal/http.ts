import { ZodError } from "zod";
import { ProviderError } from "../comms/providers";
import type { Env } from "../env";
import { loggablePath } from "../lib/log";
import { RsvpError } from "../wedding/rsvp";
import { ConflictError, NotFoundError, ValidationError } from "./entities";

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex", ...headers },
    });

export class HttpError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
    ) {
        super(message);
    }
}

/**
 * Cross-site request protection for state-changing calls. Access cookies are sent with cross-site
 * requests, so every non-GET must come from this origin with a JSON body.
 */
export const checkMutation = (request: Request, env: Env) => {
    if (request.method === "GET" || request.method === "HEAD") return;
    const origin = request.headers.get("Origin");
    const allowed = new Set([new URL(request.url).origin, new URL(env.SITE_URL).origin]);
    if (!origin || !allowed.has(origin)) throw new HttpError(403, "bad_origin", "Cross-site request refused");
    const type = request.headers.get("Content-Type") ?? "";
    if (request.method !== "DELETE" && !type.toLowerCase().startsWith("application/json")) {
        throw new HttpError(415, "unsupported_media_type", "Send JSON");
    }
};

/**
 * The portal API is only ever called by the portal's own pages. Browsers label every request with
 * Sec-Fetch-Site; anything a different site triggers (a link, an <img>, a form) is refused, even a
 * GET, so exports and other side-effecting reads can't be triggered from elsewhere.
 */
export const checkCrossSite = (request: Request) => {
    const site = request.headers.get("Sec-Fetch-Site");
    if (site === "cross-site" || site === "same-site") throw new HttpError(403, "cross_site", "Cross-site request refused");
};

/**
 * Reads a request body as text, refusing anything over maxBytes. The limit is enforced while the
 * body streams in, so a body sent without a Content-Length (chunked) can't make the Worker buffer
 * more than the limit before it's refused.
 */
export async function readText(request: Request, maxBytes: number): Promise<string> {
    const length = Number(request.headers.get("Content-Length") ?? "0");
    if (length > maxBytes) throw new HttpError(413, "too_large", "Request is too large");
    if (!request.body) return "";
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new HttpError(413, "too_large", "Request is too large");
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
}

export const readJson = async (request: Request, maxBytes = 1_500_000): Promise<unknown> => {
    const text = await readText(request, maxBytes);
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch {
        throw new HttpError(400, "bad_json", "Request body is not valid JSON");
    }
};

/** Maps thrown errors to consistent JSON. Unexpected errors are logged and hidden. */
export const errorResponse = (error: unknown, path: string) => {
    if (error instanceof HttpError) return json({ error: error.code, message: error.message }, error.status);
    if (error instanceof ZodError) {
        return json(
            {
                error: "validation",
                message: error.issues[0]?.message ?? "Some fields are invalid",
                issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
            },
            422,
        );
    }
    if (error instanceof ValidationError)
        return json({ error: "validation", message: error.message, issues: [{ path: error.path, message: error.message }] }, 422);
    if (error instanceof NotFoundError) return json({ error: "not_found", message: error.message }, 404);
    if (error instanceof ConflictError) return json({ error: "conflict", message: error.message }, 409);
    if (error instanceof RsvpError) return json({ error: error.code, message: error.message }, error.status);
    if (error instanceof ProviderError)
        return json({ error: "provider_error", message: error.message, provider: error.provider, retryable: error.retryable }, error.retryable ? 503 : 422);
    // A reference to a record that was deleted in the meantime (e.g. a budget item's supplier).
    if (/FOREIGN KEY constraint failed/.test((error as Error)?.message ?? "")) {
        return json({ error: "validation", message: "A linked record no longer exists. Reload the page and try again.", issues: [] }, 422);
    }
    console.error(
        JSON.stringify({
            event: "api_error",
            path: loggablePath(path),
            message: (error as Error).message,
            stack: (error as Error).stack?.split("\n").slice(0, 4),
        }),
    );
    return json({ error: "server_error", message: "Something went wrong. Please try again." }, 500);
};
