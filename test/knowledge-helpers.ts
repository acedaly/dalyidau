// Helpers for the Daly Knowledge tests. Every identity and every note is fictional.
import { expect } from "vitest";
import type { DocNode } from "../src/shared/knowledge/content";
import type { KnowledgeObjectDetail, KnowledgeSpace, KnowledgeType } from "../src/shared/knowledge/types";
import { OWNER, apiCall, db } from "./portal-helpers";

export const K = "/api/portal/knowledge";
export const ADMIN = "admin@example.com";

export const spaces = async (email = OWNER) => (await apiCall<{ spaces: KnowledgeSpace[] }>("GET", `${K}/spaces`, undefined, { email })).json.spaces;
export const personal = async (email = OWNER) => (await spaces(email)).find((s) => s.kind === "personal")!;
export const typesOf = async (spaceId: string, email = OWNER) =>
    (await apiCall<{ types: KnowledgeType[] }>("GET", `${K}/spaces/${spaceId}/types`, undefined, { email })).json.types;
export const typeId = async (spaceId: string, slug: string, email = OWNER) => (await typesOf(spaceId, email)).find((t) => t.slug === slug)!.id;

export const paragraph = (...content: DocNode[]): DocNode => ({ type: "paragraph", content });
export const text = (value: string, marks?: DocNode["marks"]): DocNode => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
export const objectLink = (id: string, label: string): DocNode => ({ type: "objectLink", attrs: { id, label } });
export const doc = (...blocks: (string | DocNode)[]): DocNode => ({ type: "doc", content: blocks.map((b) => (typeof b === "string" ? paragraph(text(b)) : b)) });

export const create = async (spaceId: string, body: Record<string, unknown>, email = OWNER) => {
    const result = await apiCall<KnowledgeObjectDetail>("POST", `${K}/spaces/${spaceId}/objects`, body, { email });
    expect(result.status, result.text).toBe(201);
    return result.json;
};

export const addPortalUser = (email: string, role: "admin" | "editor" | "viewer") => apiCall("POST", "/api/portal/users", { email, role });

/** A shared space owned by OWNER, with ADMIN as a member in the given role. */
export const sharedSpace = async (role: "owner" | "editor" | "viewer", name = "Household") => {
    await addPortalUser(ADMIN, "admin");
    const created = await apiCall<{ space: KnowledgeSpace }>("POST", `${K}/spaces`, { name });
    expect(created.status, created.text).toBe(201);
    const added = await apiCall("POST", `${K}/spaces/${created.json.space.id}/members`, { email: ADMIN, role });
    expect(added.status, added.text).toBe(201);
    return created.json.space;
};

export const auditRows = async () =>
    (await db().prepare("SELECT action, summary, changes FROM knowledge_audit ORDER BY id").all<{ action: string; summary: string; changes: string | null }>())
        .results;
