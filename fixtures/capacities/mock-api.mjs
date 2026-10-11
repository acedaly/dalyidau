// A small in-memory imitation of the Capacities API v1, driven by fixtures.mjs.
// Used by `npm run mock:capacities` for local development and by the test suite.
import { STRUCTURE_ID, createSpace, structures } from "./fixtures.mjs";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export const createMockApi = ({ baseUrl, token = "cap-api-local-mock", readFile }) => {
    const state = { ...createSpace(baseUrl), fail: new Set(), requests: [] };

    const handle = async (request) => {
        const url = new URL(request.url);
        state.requests.push(`${request.method} ${url.pathname}${url.search}`);

        if (url.pathname.startsWith("/__files/")) {
            // Signed media URLs must never receive the API token.
            if (request.headers.get("Authorization")) return new Response("token leaked to file host", { status: 400 });
            const bytes = await readFile(url.pathname.slice(9));
            if (!bytes) return new Response("not found", { status: 404 });
            const type = url.pathname.endsWith(".png") ? "image/png" : "image/jpeg";
            return new Response(bytes, { headers: { "Content-Type": type } });
        }

        if (request.headers.get("Authorization") !== `Bearer ${token}`) return json({ code: "cap_unauthorized", message: "Invalid token" }, 401);
        if (state.fail.has("all")) return json({ code: "cap_internal", message: "Simulated outage" }, 503);

        if (url.pathname === "/space/structures") {
            if (state.fail.has("structures")) return json({ code: "cap_internal" }, 500);
            return json(structures());
        }

        if (url.pathname === "/objects/structure") {
            if (state.fail.has("listing")) return json({ code: "cap_internal" }, 500);
            const ids = [...state.objects.values()].filter((o) => o.structureId === url.searchParams.get("id"));
            const size = Number(url.searchParams.get("pageSize") ?? 100);
            const cursor = url.searchParams.get("cursor");
            const start = cursor ? ids.findIndex((o) => o.id === cursor) : 0;
            const page = ids.slice(start, start + size);
            const next = ids[start + size];
            return json({
                results: page.map((o) => ({ id: o.id, structureId: o.structureId, title: o.properties.title.title.value })),
                nextCursor: next?.id ?? null,
                hasMore: !!next,
            });
        }

        if (url.pathname === "/object") {
            const id = url.searchParams.get("id");
            if (state.fail.has("object") || state.fail.has(`object:${id}`)) return json({ code: "cap_internal" }, 500);
            const object = state.objects.get(id);
            return object ? json(structuredClone(object)) : json({ code: "cap_not_found" }, 404);
        }

        if (url.pathname === "/object/markdown") {
            const id = url.searchParams.get("id");
            const object = state.objects.get(id);
            if (!object) return json({ code: "cap_not_found" }, 404);
            return json({ id, structureId: object.structureId, markdown: state.markdown.get(id) ?? "" });
        }

        return json({ code: "cap_not_found" }, 404);
    };

    const control = {
        state,
        reset: () => {
            Object.assign(state, createSpace(baseUrl));
            state.fail.clear();
            state.requests.length = 0;
        },
        setStatus: (id, name) => {
            const object = state.objects.get(id);
            const def = structures().structures[0].propertyDefinitions.find((d) => d.name === "Status");
            const option = def.labelSet.find((o) => o.name.toLowerCase() === String(name).toLowerCase());
            object.properties[def.id] = { type: "label", label: option ? [option] : [] };
            touch(object);
        },
        setTitle: (id, title) => {
            const object = state.objects.get(id);
            object.properties.title.title.value = title;
            touch(object);
        },
        setSlug: (id, slug) => {
            const object = state.objects.get(id);
            const def = structures().structures[0].propertyDefinitions.find((d) => d.name === "Slug");
            object.properties[def.id] = { type: "text", text: { value: slug } };
            touch(object);
        },
        appendParagraph: (id, text) => {
            const object = state.objects.get(id);
            const key = Object.keys(object.blocks)[0];
            object.blocks[key].push({
                id: crypto.randomUUID(),
                type: "TextBlock",
                tokens: [{ type: "TextToken", text, style: {} }],
                blocks: [],
                hierarchy: { key: "Base", val: 0 },
            });
            touch(object);
        },
        remove: (id) => state.objects.delete(id),
        fail: (mode) => state.fail.add(mode),
        recover: () => state.fail.clear(),
        structureId: STRUCTURE_ID,
    };

    const touch = (object) => {
        object.properties.lastUpdated = {
            type: "lastUpdatedAt",
            lastUpdatedAt: { value: new Date(Date.now() + Math.floor(Math.random() * 1000)).toISOString() },
        };
    };

    return { handle, control };
};
