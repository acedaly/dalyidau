import { ZodError } from "zod";
import type { Env } from "../env";
import { RsvpError } from "../wedding/rsvp";
import { NotFoundError, ValidationError } from "./entities";

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

export const readJson = async (request: Request, maxBytes = 1_500_000): Promise<unknown> => {
    const length = Number(request.headers.get("Content-Length") ?? "0");
    if (length > maxBytes) throw new HttpError(413, "too_large", "Request is too large");
    const text = await request.text();
    if (text.length > maxBytes) throw new HttpError(413, "too_large", "Request is too large");
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
    if (error instanceof RsvpError) return json({ error: error.code, message: error.message }, error.status);
    // A reference to a record that was deleted in the meantime (e.g. a budget item's supplier).
    if (/FOREIGN KEY constraint failed/.test((error as Error)?.message ?? "")) {
        return json({ error: "validation", message: "A linked record no longer exists. Reload the page and try again.", issues: [] }, 422);
    }
    console.error(JSON.stringify({ event: "api_error", path, message: (error as Error).message, stack: (error as Error).stack?.split("\n").slice(0, 4) }));
    return json({ error: "server_error", message: "Something went wrong. Please try again." }, 500);
};
