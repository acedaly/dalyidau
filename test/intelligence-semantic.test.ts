// Semantic Knowledge: chunking, the incremental index, hybrid search, related knowledge, isolation
// between people and spaces (including a vector index that returns things it shouldn't), the
// keyword fallback, and a small repeatable retrieval evaluation on invented notes.
//
// The "meaning" here comes from the deterministic stand-in embedder (hashed words plus a few
// synonyms), so the evaluation measures the pipeline (fusion, filtering, access checks, exact-record
// recall, latency), not a real model's relevance. scripts/intelligence-eval.mjs runs the same corpus
// against Workers AI when the owner chooses to.
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/shared/intelligence/config";
import type { HybridSearchResult } from "../src/shared/intelligence/types";
import { MemoryVectorIndex, mockEmbedding } from "../worker/intelligence/bindings";
import { MAX_CHUNKS, chunkText, syncSemanticIndex } from "../worker/intelligence/semantic";
import { loadConfig } from "../worker/intelligence/settings";
import { aiEnv, configure, iCall } from "./intelligence-helpers";
import { K, create as createObject, doc, personal, sharedSpace } from "./knowledge-helpers";
import { OWNER, SECOND_OWNER, apiCall, db, resetPortal } from "./portal-helpers";

const A = OWNER;
const B = SECOND_OWNER;

beforeEach(resetPortal);

type Env = Awaited<ReturnType<typeof aiEnv>>["env"];
const sync = async (env: Env) => syncSemanticIndex(env, (await loadConfig(env.DB)).config);
const search = async (env: Env, q: string, email = A, extra = "") =>
    (await iCall<HybridSearchResult>(env, "GET", `/search?q=${encodeURIComponent(q)}${extra}`, undefined, email)).json;

describe("chunking", () => {
    it("is deterministic, keeps blocks together, splits long ones and prefixes the title", () => {
        const body = ["Short paragraph.", "x".repeat(900), "Another. ".repeat(300)].join("\n");
        const a = chunkText("Title", body);
        expect(a).toEqual(chunkText("Title", body));
        expect(a.every((c) => c.startsWith("Title\n") && c.length <= 1_700 + 10)).toBe(true);
        expect(a.length).toBeGreaterThan(2);
        expect(chunkText("Only a title", "")).toEqual(["Only a title"]);
        expect(chunkText("", "")).toEqual([]);
        expect(chunkText("T", "word ".repeat(200_000)).length).toBe(MAX_CHUNKS);
    });
});

describe("the semantic index", () => {
    it("embeds new objects, skips unchanged text, re-embeds edits and model changes, and removes trashed and excluded ones", async () => {
        const { env, ai, vectors } = await aiEnv();
        await configure(env);
        const space = await personal();
        const one = await createObject(space.id, { title: "Car service", content: doc("The car needs new tyres and an oil change.") });
        const two = await createObject(space.id, { title: "Holiday", content: doc("Book the beach house.") });
        expect(await sync(env)).toMatchObject({ embedded: 2, removed: 0 });
        expect(vectors.namespaces.get(space.id)?.size).toBe(2);
        // Metadata holds ids only: no title, no text.
        const stored = [...vectors.namespaces.get(space.id)!.values()];
        expect(JSON.stringify(stored.map((v) => v.metadata))).not.toMatch(/Car|tyres|Holiday/);
        expect(await sync(env)).toMatchObject({ embedded: 0, unchanged: 0 });

        // A tag change bumps the version but not the text: no embedding is paid for.
        await apiCall("PATCH", `${K}/objects/${one.object.id}`, { version: one.object.version, tags: ["vehicles"] });
        const embeds = ai.calls.filter((c) => c.kind === "embed").length;
        expect(await sync(env)).toMatchObject({ embedded: 0, unchanged: 1 });
        expect(ai.calls.filter((c) => c.kind === "embed").length).toBe(embeds);

        // Trashed: its vectors go.
        await apiCall("POST", `${K}/objects/${two.object.id}/status/trash`, {});
        expect(await sync(env)).toMatchObject({ removed: 1 });
        expect(vectors.namespaces.get(space.id)?.size).toBe(1);

        // Excluding the space removes everything in it and stops it being embedded again.
        await iCall(env, "POST", "/exclusions", { spaceId: space.id, excluded: true });
        expect(await sync(env)).toMatchObject({ removed: 1 });
        expect(vectors.size()).toBe(0);
        await iCall(env, "POST", "/exclusions", { spaceId: space.id, excluded: false });
        expect(await sync(env)).toMatchObject({ embedded: 1 });

        // A new embedding model (same dimensions) re-embeds everything.
        const { version } = await loadConfig(env.DB);
        await iCall(env, "PUT", "/settings", {
            version,
            config: { ...(await loadConfig(env.DB)).config, models: { ...DEFAULT_CONFIG.models, embed: "@cf/qwen/qwen3-embedding-0.6b" } },
        });
        expect(await sync(env)).toMatchObject({ embedded: 1 });
    });

    it("stops at the budget and resumes later, and records failures for retry", async () => {
        let fail = true;
        const { env } = await aiEnv({
            embed: (texts) => {
                if (fail) throw new Error("internal server error 500");
                return texts.map((t) => mockEmbedding(t));
            },
        });
        await configure(env);
        const space = await personal();
        await createObject(space.id, { title: "One", content: doc("First") });
        expect(await sync(env)).toMatchObject({ failed: 1, stoppedFor: "unavailable" });
        fail = false;
        expect(await sync(env)).toMatchObject({ embedded: 1 });
        await configure(env, { budgets: { ...DEFAULT_CONFIG.budgets, features: { ...DEFAULT_CONFIG.budgets.features, semantic: 0 } } });
        await createObject(space.id, { title: "Two", content: doc("Second") });
        expect(await sync(env)).toMatchObject({ embedded: 0, stoppedFor: "budget" });
    });
});

describe("hybrid search and isolation", () => {
    it("finds by meaning what keyword search can't, and says which signal matched", async () => {
        const { env } = await aiEnv();
        await configure(env);
        const space = await personal();
        const note = await createObject(space.id, { title: "Ute rego", content: doc("The ute registration is due in March.") });
        await sync(env);
        const keywordOnly = await apiCall<{ hits: unknown[] }>("GET", `${K}/search?q=vehicle`, undefined, { env });
        expect(keywordOnly.json.hits).toHaveLength(0);
        const result = await search(env, "vehicle registration");
        expect(result.mode).toBe("hybrid");
        expect(result.hits[0].object.id).toBe(note.object.id);
        expect(result.hits[0].matchedBy).toContain("meaning");
        expect(result.hits[0].excerpt).toContain("registration");
    });

    it("never returns another person's or another space's objects, even if the index does", async () => {
        const { env, vectors } = await aiEnv();
        await configure(env);
        const mine = await personal(A);
        const theirs = await personal(B);
        await createObject(mine.id, { title: "My budget", content: doc("Household budget for groceries.") });
        const secret = await createObject(theirs.id, { title: "B's budget", content: doc("Household budget, private to B.") }, B);
        await sync(env);
        // A misbehaving index: puts B's vector into A's namespace.
        const leaked = vectors.namespaces.get(theirs.id)!.get(`${secret.object.id}:0`)!;
        await vectors.upsert([{ ...leaked, namespace: mine.id }]);
        const result = await search(env, "household budget");
        expect(result.hits.map((h) => h.object.id)).not.toContain(secret.object.id);
        expect(JSON.stringify(result)).not.toContain("private to B");
        // Naming B's space is "not found".
        expect((await iCall(env, "GET", `/search?q=budget&space=${theirs.id}`)).status).toBe(404);
    });

    it("removes access on the next search when a member leaves a shared space", async () => {
        const { env } = await aiEnv();
        await configure(env);
        const space = await sharedSpace("editor");
        await createObject(space.id, { title: "Shared plan", content: doc("Renovation plan for the kitchen.") });
        await sync(env);
        expect((await search(env, "kitchen renovation", "admin@example.com")).hits).toHaveLength(1);
        await apiCall("DELETE", `${K}/spaces/${space.id}/members/admin@example.com`);
        expect((await search(env, "kitchen renovation", "admin@example.com")).hits).toHaveLength(0);
    });

    it("drops deleted objects from results immediately, before the index catches up", async () => {
        const { env } = await aiEnv();
        await configure(env);
        const space = await personal();
        const note = await createObject(space.id, { title: "Old idea", content: doc("A treehouse in the back yard.") });
        await sync(env);
        await apiCall("POST", `${K}/objects/${note.object.id}/status/trash`, {});
        expect((await search(env, "treehouse")).hits).toHaveLength(0);
    });

    it("falls back to keyword search when Vectorize fails, and says so", async () => {
        const { env, vectors } = await aiEnv();
        await configure(env);
        const space = await personal();
        await createObject(space.id, { title: "Gutters", content: doc("Clean the gutters before winter.") });
        vectors.query = async () => {
            throw new Error("Vectorize unavailable 503");
        };
        const result = await search(env, "gutters");
        expect(result.mode).toBe("keyword");
        expect(result.fallbackReason).toBeTruthy();
        expect(result.hits).toHaveLength(1);
    });

    it("suggests related notes by meaning and flags possible duplicates without linking anything", async () => {
        const { env } = await aiEnv();
        await configure(env);
        const space = await personal();
        const a = await createObject(space.id, { title: "Trailer brakes", content: doc("Adjust the trailer brakes and check the bearings.") });
        const b = await createObject(space.id, { title: "Trailer brakes", content: doc("Adjust the trailer brakes and check the bearings.") });
        await sync(env);
        const related = (
            await iCall<{ related: { object: { id: string }; possibleDuplicate: boolean }[]; semantic: boolean }>(env, "GET", `/objects/${a.object.id}/related`)
        ).json;
        expect(related.semantic).toBe(true);
        expect(related.related.find((r) => r.object.id === b.object.id)?.possibleDuplicate).toBe(true);
        expect((await db().prepare("SELECT COUNT(*) AS n FROM knowledge_relations").first<{ n: number }>())!.n).toBe(0);
        expect((await iCall(env, "GET", `/objects/${a.object.id}/related`, undefined, B)).status).toBe(404);
    });
});

describe("retrieval evaluation (synthetic corpus, stand-in embeddings)", () => {
    const CORPUS = [
        { title: "Household budget decision", text: "We decided to cap grocery spending at $250 a week and review it monthly." },
        { title: "Trailer brake maintenance", text: "Electric brakes on the trailer need adjusting every 5,000 km. Check the controller gain." },
        { title: "Car insurance renewal", text: "The vehicle insurance renews in June. Compare quotes in May." },
        { title: "Garden plan", text: "Plant tomatoes in October and basil in November." },
        { title: "Meeting with the builder", text: "Action: confirm the deck timber. Decision: start on the 3rd." },
        { title: "Smoke alarms", text: "Replace smoke alarm batteries every April." },
        { title: "Holiday ideas", text: "Coastal drive, three nights, pet-friendly cabin." },
        { title: "Electricity costs", text: "Our power bill went up; money spent on heating doubled in winter." },
        { title: "Bike service", text: "Chain, brake pads and gears serviced at the local shop." },
        { title: "Recipes to try", text: "Lamb shoulder, slow cooked, with rosemary." },
    ];
    const QUERIES: { q: string; expected: string }[] = [
        { q: "what did we decide about the household budget", expected: "Household budget decision" },
        { q: "trailer brake maintenance", expected: "Trailer brake maintenance" },
        { q: "automobile insurance", expected: "Car insurance renewal" },
        { q: "money spent on power", expected: "Electricity costs" },
        { q: "builder meeting actions", expected: "Meeting with the builder" },
        { q: "smoke alarm", expected: "Smoke alarms" },
    ];

    it("finds the expected record in the top three for every query, with no cross-space leaks", async () => {
        const { env } = await aiEnv();
        await configure(env);
        const space = await personal();
        const other = await personal(B);
        const ids = new Map<string, string>();
        for (const n of CORPUS) ids.set(n.title, (await createObject(space.id, { title: n.title, content: doc(n.text) })).object.id);
        for (const n of CORPUS.slice(0, 4)) await createObject(other.id, { title: n.title, content: doc(n.text) }, B);
        await sync(env);
        let hybridHits = 0;
        let keywordHits = 0;
        let leaks = 0;
        const timings: number[] = [];
        for (const { q, expected } of QUERIES) {
            const started = performance.now();
            const result = await search(env, q);
            timings.push(performance.now() - started);
            if (result.hits.slice(0, 3).some((h) => h.object.id === ids.get(expected))) hybridHits++;
            leaks += result.hits.filter((h) => h.object.spaceId !== space.id).length;
            const keyword = await apiCall<{ hits: { object: { id: string } }[] }>("GET", `${K}/search?q=${encodeURIComponent(q)}`, undefined, { env });
            if (keyword.json.hits.slice(0, 3).some((h) => h.object.id === ids.get(expected))) keywordHits++;
        }
        // Exact-record recall: each title finds itself first.
        let exact = 0;
        for (const n of CORPUS) if ((await search(env, n.title)).hits[0]?.object.id === ids.get(n.title)) exact++;
        const report = {
            queries: QUERIES.length,
            hybridRecallAt3: hybridHits / QUERIES.length,
            keywordRecallAt3: keywordHits / QUERIES.length,
            exactRecordRecall: exact / CORPUS.length,
            crossSpaceLeaks: leaks,
            medianMs: Math.round(timings.sort((a, b) => a - b)[Math.floor(timings.length / 2)]),
        };
        console.info(`intelligence-eval ${JSON.stringify(report)}`);
        expect(report.crossSpaceLeaks).toBe(0);
        expect(report.hybridRecallAt3).toBe(1);
        expect(report.hybridRecallAt3).toBeGreaterThanOrEqual(report.keywordRecallAt3);
        expect(report.exactRecordRecall).toBe(1);
    });

    it("works with an index that starts empty (a rebuild after a restore)", async () => {
        const { env, vectors } = await aiEnv();
        await configure(env);
        const space = await personal();
        await createObject(space.id, { title: "Rebuild me", content: doc("Restored notes are reindexed.") });
        await sync(env);
        // Vectorize is derived: wipe it and the index table, as after restoring D1 elsewhere.
        vectors.namespaces.clear();
        await db().prepare("DELETE FROM ai_semantic_index").run();
        expect(await sync(env)).toMatchObject({ embedded: 1 });
        expect(vectors.size()).toBe(1);
        expect(new MemoryVectorIndex().size()).toBe(0);
    });
});
