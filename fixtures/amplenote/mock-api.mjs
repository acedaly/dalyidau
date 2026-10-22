// A stand-in for Amplenote, for tests only (never the real service): the REST API's OAuth token
// endpoint, GET /v4/notes, POST /v4/notes and POST /v4/notes/{uuid}/actions (each checking the
// token's scopes), the login page (which consents straight away), public note pages
// (status only) and the image host. It also plays the plugin's side: `app()` returns a fake
// Amplenote plugin `app` over the same notes, so tests run the real amplenote/plugin.js.
//
// Every note, title and token here is invented.

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

export const NOTE_IDS = {
    garden: "0b6e6f2a-1c1d-4e2f-9a3b-5c6d7e8f9a01",
    draft: "1c7f7a3b-2d2e-4f30-8b4c-6d7e8f9a0b12",
    private: "2d808b4c-3e3f-4041-9c5d-7e8f9a0b1c23",
    second: "3e919c5d-4f40-4152-8d6e-8f9a0b1c2d34",
};

export const fixtureNotes = (imageBase) => [
    {
        uuid: NOTE_IDS.garden,
        name: "Notes from a small vegetable garden",
        tags: ["website/blog", "website/category/making-things", "website/tag/gardening", "website/featured", "personal/home"],
        public: true,
        deleted: false,
        token: "InventedGardenToken01",
        created: "2026-10-01T09:00:00.000Z",
        updated: "2026-10-02T09:00:00.000Z",
        markdown: [
            "# Notes from a small vegetable garden",
            "",
            "Growing **tomatoes** taught me more about _patience_ than any book. Here's what [the seed catalogue](https://example.com/seeds) left out.",
            "",
            `![Seedlings on a sill](${imageBase}/garden/seedlings.png)`,
            "",
            "## What worked",
            "",
            "- Watering in the morning",
            "- Mulch, lots of it",
            "  - straw, not wood chips",
            '- [x] Raised beds <!-- {"uuid":"task-1"} -->',
            "",
            "## What didn't",
            "",
            "<script>alert('never rendered')</script>",
            "> Slugs. Always the slugs.",
            "",
            "| Crop | Verdict |",
            "|-|-|",
            "| Tomato | Yes |",
            "| Zucchini | Too many |",
            "",
            "# Website",
            "summary: What a season of tomatoes taught me about patience.",
            "subtitle: A first season, honestly reported",
        ].join("\n"),
    },
    {
        uuid: NOTE_IDS.draft,
        name: "A draft that isn't finished",
        tags: ["website/blog"],
        public: false,
        deleted: false,
        token: null,
        created: "2026-10-05T09:00:00.000Z",
        updated: "2026-10-05T09:00:00.000Z",
        markdown: "Secret draft text that must never reach the website.",
    },
    {
        uuid: NOTE_IDS.private,
        name: "Private journal",
        tags: ["personal/journal"],
        public: true,
        deleted: false,
        token: "InventedPrivateToken02",
        created: "2026-10-03T09:00:00.000Z",
        updated: "2026-10-03T09:00:00.000Z",
        markdown: "Published to one friend, but never tagged for the blog.",
    },
];

export const secondNote = {
    uuid: NOTE_IDS.second,
    name: "Why I write things down",
    tags: ["website/blog", "website/category/writing"],
    public: true,
    deleted: false,
    token: "InventedSecondToken03",
    created: "2026-10-10T09:00:00.000Z",
    updated: "2026-10-10T09:00:00.000Z",
    markdown: `Short and sweet. See also [my garden notes](https://www.amplenote.com/notes/${NOTE_IDS.garden}) and [my journal](https://www.amplenote.com/notes/${NOTE_IDS.private}).`,
};

export function createAmplenoteMock({
    apiBase = "https://api.amplenote.com",
    loginBase = "https://login.amplenote.com/login",
    publicBase = "https://public.amplenote.com",
    imageBase = "https://images.amplenote.com",
} = {}) {
    let notes = new Map();
    let access = new Map(); // token → expiry (ms)
    let refresh = new Set();
    let calls = [];
    let failures = { listing: 0, token: 0, links: false };
    let rotate = false;
    let refreshesUsed = [];
    let counter = 0;
    let grantedScope = "notes:list";
    let actions = []; // { uuid, body }
    let writeFailure = null; // null | "timeout" | <HTTP status>

    const reset = () => {
        notes = new Map(fixtureNotes(imageBase).map((n) => [n.uuid, structuredClone(n)]));
        access = new Map();
        refresh = new Set();
        calls = [];
        failures = { listing: 0, token: 0, links: false };
        rotate = false;
        refreshesUsed = [];
        grantedScope = "notes:list";
        actions = [];
        writeFailure = null;
        tokenScopes = new Map();
    };
    let tokenScopes = new Map(); // access token → scope string
    reset();

    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const issue = (keep) => {
        counter++;
        const a = `access-${counter}`;
        const r = keep ?? `refresh-${counter}`;
        access.set(a, Date.now() + 7200_000);
        tokenScopes.set(a, grantedScope);
        refresh.add(r);
        return { access_token: a, refresh_token: r, expires_in: 7200, token_type: "Bearer", scope: grantedScope };
    };
    const touch = (note) => {
        note.updated = new Date(Math.max(Date.now(), Date.parse(note.updated) + 1000)).toISOString();
    };

    async function handle(request) {
        const url = new URL(request.url);
        const href = `${url.origin}${url.pathname}`;
        calls.push(`${request.method} ${href}`);

        if (href === `${apiBase}/oauth/token` && request.method === "POST") {
            const form = new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer()));
            if (failures.token > 0) {
                failures.token--;
                return json({ error: "server_error" }, 503);
            }
            if (form.get("grant_type") === "authorization_code") {
                if (form.get("code") !== "good-code" || !form.get("code_verifier") || !form.get("client_id")) return json({ error: "invalid_grant" }, 400);
                return json(issue());
            }
            if (form.get("grant_type") === "refresh_token") {
                const old = form.get("refresh_token");
                if (!refresh.has(old)) return json({ error: "invalid_grant" }, 400);
                refreshesUsed.push(old);
                // The real service kept the same refresh token in the owner's live check; rotation can be switched on.
                if (!rotate) return json(issue(old));
                refresh.delete(old);
                return json(issue());
            }
            return json({ error: "unsupported_grant_type" }, 400);
        }

        const bearer = () => {
            const token = (request.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
            return access.has(token) && access.get(token) >= Date.now() ? token : null;
        };
        const allowed = (token, scope) => (tokenScopes.get(token) ?? "").split(/\s+/).includes(scope);
        const writeFailed = () => {
            if (writeFailure === "timeout") throw new TypeError("network connection lost");
            return writeFailure ? json({ error: "failed" }, writeFailure) : null;
        };

        if (href === `${apiBase}/v4/notes` && request.method === "POST") {
            const token = bearer();
            if (!token) return json({ error: "unauthorized" }, 401);
            if (!allowed(token, "notes:create")) return json({ error: "insufficient_scope" }, 403);
            const failed = writeFailed();
            if (failed) return failed;
            const body = await request.json().catch(() => null);
            if (typeof body?.name !== "string") return json({ error: "name required" }, 422);
            counter++;
            const uuid = `9f${String(counter).padStart(6, "0")}-0000-4000-8000-${String(counter).padStart(12, "0")}`;
            const now = new Date().toISOString();
            notes.set(uuid, {
                uuid,
                name: body.name,
                tags: (body.tags ?? []).map((t) => (typeof t === "string" ? t : t.text)),
                public: false,
                deleted: false,
                token: null,
                created: now,
                updated: now,
                markdown: "",
            });
            // Assumed shape: the created note's uuid at the top level (to be confirmed live).
            return json({ uuid });
        }

        const actionPath =
            href.startsWith(`${apiBase}/v4/notes/`) && href.endsWith("/actions") ? href.slice(`${apiBase}/v4/notes/`.length, -"/actions".length) : null;
        if (actionPath && request.method === "POST") {
            const token = bearer();
            if (!token) return json({ error: "unauthorized" }, 401);
            if (!allowed(token, "notes:create-content-action")) return json({ error: "insufficient_scope" }, 403);
            const failed = writeFailed();
            if (failed) return failed;
            const note = notes.get(actionPath);
            if (!note || note.deleted) return json({ error: "not found" }, 404);
            const body = await request.json().catch(() => null);
            if (body?.type !== "INSERT_NODES" || !Array.isArray(body.nodes)) return json({ error: "invalid action" }, 422);
            actions.push({ uuid: actionPath, body });
            touch(note);
            return new Response(null, { status: 204 });
        }

        if (href === `${apiBase}/v4/notes` && request.method === "GET") {
            const token = (request.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
            if (!access.has(token) || access.get(token) < Date.now()) return json({ error: "unauthorized" }, 401);
            if (failures.listing > 0) {
                failures.listing--;
                return json({ error: "unavailable" }, 503);
            }
            const since = Number(url.searchParams.get("since") ?? "0");
            const list = [...notes.values()]
                .filter((n) => !since || Date.parse(n.updated) / 1000 >= since)
                .filter((n) => since || !n.deleted)
                .map((n) => ({
                    uuid: n.uuid,
                    name: n.name,
                    tags: n.tags,
                    public: n.public,
                    deleted: n.deleted,
                    timestamps: { created: Math.floor(Date.parse(n.created) / 1000), updated: Math.floor(Date.parse(n.updated) / 1000) },
                }));
            // Like the real service: an object holding the notes (and the account's tags), not a bare array.
            return json({ notes: list, tags: [...new Set(list.flatMap((n) => n.tags))] });
        }

        if (href === loginBase) {
            // The owner consents straight away, to whatever scopes were asked for.
            grantedScope = url.searchParams.get("scope") || "notes:list";
            const target = new URL(url.searchParams.get("redirect_uri"));
            target.searchParams.set("code", "good-code");
            target.searchParams.set("state", url.searchParams.get("state") ?? "");
            return new Response(null, { status: 302, headers: { Location: target.toString() } });
        }

        if (href.startsWith(`${publicBase}/`)) {
            if (failures.links) return new Response("unavailable", { status: 503 });
            const token = url.pathname.split("/").pop();
            const note = [...notes.values()].find((n) => n.token === token && n.public && !n.deleted);
            return new Response(note ? "<html><title>Amplenote</title></html>" : "Not found", {
                status: note ? 200 : 404,
                headers: { "Content-Type": "text/html" },
            });
        }

        if (href.startsWith(`${imageBase}/`)) return new Response(PNG, { headers: { "Content-Type": "image/png" } });

        return new Response("not found", { status: 404 });
    }

    /** A fake Amplenote plugin `app` over the same notes (the parts the plugin uses). */
    function app(settings) {
        const alerts = [];
        return {
            settings,
            alerts,
            alert: async (message) => alerts.push(message),
            filterNotes: async ({ tag }) =>
                [...notes.values()]
                    .filter((n) => !n.deleted && n.tags.includes(tag))
                    .map((n) => ({
                        uuid: n.uuid,
                        name: n.name,
                        tags: n.tags,
                        created: n.created,
                        updated: n.updated,
                        ...(n.public ? { published: true } : {}),
                    })),
            getNotePublicURL: async ({ uuid }) => {
                const n = notes.get(uuid);
                return n?.public && n.token ? `${publicBase}/${n.token}` : null;
            },
            getNoteContent: async ({ uuid }) => notes.get(uuid)?.markdown ?? "",
        };
    }

    const control = {
        reset,
        note: (uuid) => notes.get(uuid),
        add: (note) => notes.set(note.uuid, structuredClone(note)),
        edit: (uuid, changes) => {
            const note = notes.get(uuid);
            Object.assign(note, changes);
            touch(note);
        },
        unpublish: (uuid) => {
            const note = notes.get(uuid);
            note.public = false;
            note.token = null;
            touch(note);
        },
        failListing: (times = 1) => (failures.listing = times),
        failToken: (times = 1) => (failures.token = times),
        linksDown: (down = true) => (failures.links = down),
        expireAccess: () => {
            for (const key of access.keys()) access.set(key, 0);
        },
        revokeRefresh: () => refresh.clear(),
        rotateRefresh: (on = true) => (rotate = on),
        refreshesUsed: () => [...refreshesUsed],
        calls: () => [...calls],
        /** Every INSERT_NODES action received, in order. */
        actions: () => structuredClone(actions),
        /** Make the next writes fail: "timeout" (no answer), an HTTP status, or null to stop. */
        failWrites: (mode) => (writeFailure = mode),
    };

    return { handle, app, control };
}
