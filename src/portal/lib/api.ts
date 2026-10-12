// Thin JSON client for /api/portal. Errors carry the server's message and field issues so forms
// can show them next to the right input.

export interface FieldIssue {
    path: string;
    message: string;
}

export class ApiError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
        readonly issues: FieldIssue[] = [],
    ) {
        super(message);
    }

    /** First issue for a field (or any nested path under it). */
    issueFor(field: string) {
        return this.issues.find((i) => i.path === field || i.path.startsWith(`${field}.`))?.message;
    }
}

export async function api<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
        response = await fetch(path, {
            method,
            credentials: "same-origin",
            headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
    } catch {
        throw new ApiError(0, "network", "Couldn't reach the server. Check your connection and try again.");
    }

    // An expired Access session answers with a redirect to the login page (opaque to fetch) or 401.
    if (response.type === "opaqueredirect" || response.status === 401) {
        throw new ApiError(401, "unauthenticated", "Your session has expired. Reload the page to sign in again.");
    }

    const text = await response.text();
    let data: unknown = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        // Access's login page is HTML; treat any non-JSON reply as a lost session.
        throw new ApiError(
            response.status,
            "unexpected",
            response.ok ? "Your session has expired. Reload the page to sign in again." : "Something went wrong.",
        );
    }
    if (!response.ok) {
        const error = (data ?? {}) as { error?: string; message?: string; issues?: FieldIssue[] };
        throw new ApiError(response.status, error.error ?? "error", error.message ?? "Something went wrong.", error.issues ?? []);
    }
    return data as T;
}

export const errorMessage = (error: unknown) => (error instanceof ApiError ? error.message : "Something went wrong. Please try again.");
