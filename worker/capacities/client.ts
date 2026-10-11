import type { CapacitiesObject, ObjectSummary, Structure } from "./types";

export class CapacitiesError extends Error {
    constructor(
        message: string,
        readonly status: number | null,
        readonly code: string | null = null,
    ) {
        super(message);
        this.name = "CapacitiesError";
    }

    get isNotFound() {
        return this.status === 404;
    }
}

export class BudgetExhaustedError extends Error {
    constructor() {
        super("Request budget for this sync run is exhausted");
        this.name = "BudgetExhaustedError";
    }
}

export interface ClientOptions {
    token: string;
    baseUrl: string;
    /** Maximum API requests (and media downloads) for one sync run. Keeps us under the Workers subrequest limit. */
    maxRequests: number;
    /** Minimum gap between API calls. The object endpoints allow 30 requests per 60 seconds. */
    spacingMs: number;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
}

const API_VERSION = "1.0.0";

/**
 * Minimal client for the Capacities API v1. Every call counts against a per-run budget and is
 * spaced to respect the documented rate limits. The token is only ever sent to the API host.
 */
export class CapacitiesClient {
    private used = 0;
    private lastCallAt = 0;
    private readonly fetchImpl: typeof fetch;
    private readonly sleep: (ms: number) => Promise<void>;

    constructor(private readonly opts: ClientOptions) {
        this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
        this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    }

    get requestsUsed() {
        return this.used;
    }

    get remaining() {
        return Math.max(0, this.opts.maxRequests - this.used);
    }

    /** Reserve budget for a non-API request, such as downloading a signed media URL. */
    take() {
        if (this.used >= this.opts.maxRequests) throw new BudgetExhaustedError();
        this.used++;
    }

    async structures(): Promise<Structure[]> {
        const body = await this.get<{ structures: Structure[] }>("/space/structures");
        if (!Array.isArray(body.structures)) throw new CapacitiesError("Malformed structures response", null);
        return body.structures;
    }

    /**
     * Lists every object of a structure. Throws if any page fails, so callers never mistake a
     * partial listing for a complete one.
     */
    async listAll(structureId: string): Promise<ObjectSummary[]> {
        const results: ObjectSummary[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < 50; page++) {
            const params = new URLSearchParams({ id: structureId, pageSize: "100" });
            if (cursor) params.set("cursor", cursor);
            const body = await this.get<{ results: ObjectSummary[]; nextCursor: string | null; hasMore: boolean }>(`/objects/structure?${params}`);
            if (!Array.isArray(body.results) || typeof body.hasMore !== "boolean") {
                throw new CapacitiesError("Malformed listing response", null);
            }
            results.push(...body.results);
            if (!body.hasMore) return results;
            if (!body.nextCursor) throw new CapacitiesError("Listing reported more pages without a cursor", null);
            cursor = body.nextCursor;
        }
        throw new CapacitiesError("Listing exceeded 50 pages", null);
    }

    async object(id: string): Promise<CapacitiesObject> {
        const body = await this.get<CapacitiesObject>(`/object?id=${encodeURIComponent(id)}`);
        if (!body || typeof body.id !== "string" || typeof body.properties !== "object") {
            throw new CapacitiesError("Malformed object response", null);
        }
        return body;
    }

    async markdown(id: string): Promise<string> {
        const body = await this.get<{ markdown: string }>(`/object/markdown?id=${encodeURIComponent(id)}`);
        return typeof body.markdown === "string" ? body.markdown : "";
    }

    private async get<T>(path: string, retried = false): Promise<T> {
        this.take();

        const wait = this.lastCallAt + this.opts.spacingMs - Date.now();
        if (wait > 0) await this.sleep(wait);
        this.lastCallAt = Date.now();

        let response: Response;
        try {
            response = await this.fetchImpl(this.opts.baseUrl.replace(/\/$/, "") + path, {
                headers: {
                    Authorization: `Bearer ${this.opts.token}`,
                    Accept: "application/json",
                    "X-Capacities-Api-Version": API_VERSION,
                },
                signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
            });
        } catch (error) {
            throw new CapacitiesError(`Network error calling ${pathOnly(path)}: ${(error as Error).message}`, null);
        }

        if (response.status === 429 && !retried) {
            const retryAfter = Number(response.headers.get("Retry-After")) || 30;
            await response.body?.cancel();
            if (retryAfter > 65) throw new CapacitiesError(`Rate limited on ${pathOnly(path)} (retry after ${retryAfter}s)`, 429);
            await this.sleep(retryAfter * 1000);
            return this.get<T>(path, true);
        }

        if (!response.ok) {
            let code: string | null = null;
            try {
                const body = (await response.json()) as { code?: string; error?: { code?: string } };
                code = body.code ?? body.error?.code ?? null;
            } catch {
                // Non-JSON error bodies are fine to ignore.
            }
            throw new CapacitiesError(`Capacities ${pathOnly(path)} returned ${response.status}${code ? ` (${code})` : ""}`, response.status, code);
        }

        try {
            return (await response.json()) as T;
        } catch {
            throw new CapacitiesError(`Invalid JSON from ${pathOnly(path)}`, response.status);
        }
    }
}

// Logs never include query strings, which may contain object ids for private notes.
const pathOnly = (path: string) => path.split("?")[0];
