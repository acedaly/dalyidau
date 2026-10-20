// Search across Home & Assets (assets, maintenance, documents and places) and, for people who can
// open it, Daly Knowledge (through Knowledge's own search and space membership). Everything is
// filtered by the same access rules as the pages: nothing is found that couldn't be opened.
import type { D1Database } from "@cloudflare/workers-types";
import { matchesQuery } from "../../src/shared/assets/filters";
import { type AssetSearchResults, FILE_KIND_LABELS } from "../../src/shared/assets/types";
import type { PortalUser } from "../../src/shared/portal/types";
import { listSpaces } from "../knowledge/access";
import { searchObjects } from "../knowledge/search";
import { can } from "../portal/auth";
import { listAssets, viewContext } from "./assets";
import { listFiles } from "./files";
import { listLocations } from "./locations";
import { listMaintenance } from "./maintenance";

const has = (q: string, ...values: (string | null | undefined)[]) => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const text = values.filter(Boolean).join(" ").toLowerCase();
    return words.every((w) => text.includes(w));
};

const plain = (snippet: string) => snippet.replace(/<[^>]*>|[\u0002\u0003]/g, "").slice(0, 200);

export async function searchAll(db: D1Database, user: PortalUser, query: string): Promise<AssetSearchResults> {
    const q = query.trim().slice(0, 100);
    if (q.length < 2) return { assets: [], maintenance: [], files: [], locations: [], knowledge: can(user, "knowledge.use") ? [] : null };
    const ctx = await viewContext(db, user);
    const [{ assets }, maintenance, { files }, locations] = await Promise.all([
        listAssets(db, user, ctx),
        listMaintenance(db, user, { scope: "all", limit: 2000 }),
        listFiles(db, user, 2000),
        listLocations(db, user, { includeArchived: true }),
    ]);
    let knowledge: AssetSearchResults["knowledge"] = null;
    if (can(user, "knowledge.use")) {
        const spaces = await listSpaces(db, user.email);
        const names = new Map(spaces.map((s) => [s.id, s.name]));
        const hits = await searchObjects(db, q, { spaceIds: spaces.map((s) => s.id), limit: 10 }).catch(() => []);
        knowledge = hits.map((h) => ({
            id: h.object.id,
            title: h.object.title || "Untitled",
            spaceName: names.get(h.object.spaceId) ?? "",
            snippet: h.bodySnippet ? plain(h.bodySnippet) : null,
        }));
    }
    return {
        assets: assets.filter((a) => matchesQuery(a, q)).slice(0, 50),
        maintenance: maintenance.filter((m) => has(q, m.title, m.description, m.provider, m.notes, m.targetName)).slice(0, 30),
        files: files.filter((f) => has(q, f.filename, f.caption, FILE_KIND_LABELS[f.kind], f.assetName)).slice(0, 30),
        locations: locations.filter((l) => has(q, l.name, l.address, l.managerName, l.notes)).slice(0, 20),
        knowledge,
    };
}
