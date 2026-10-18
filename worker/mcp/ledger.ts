// The MCP write ledger (mcp_writes, migration 0018).
//
// Every write an AI client makes through the gateway is claimed here before anything changes and
// settled afterwards, so there is always an audit row naming the person, the tool and the record,
// and never any of its content. A write that carries a request id the same person already used
// gets the first write's record back instead of writing again, which makes retries after a
// dropped connection safe. Two requests racing with one id: the unique index lets one claim win
// and the other is told to try again.
import type { D1Database } from "@cloudflare/workers-types";
import { newId, nowIso } from "../portal/db";
import { HttpError } from "../portal/http";

export type EntityType = "task" | "task_knowledge_link" | "knowledge_object";

export interface WriteOutcome {
    entityType: EntityType;
    entityId: string;
}

export type Claim = { kind: "new"; id: string } | { kind: "replay"; outcome: WriteOutcome };

/** A claim still pending after this long belongs to a request that died part-way; a retry may take it over. */
const STALE_MS = 2 * 60_000;

interface LedgerRow {
    id: string;
    tool: string;
    status: "pending" | "done" | "failed";
    entity_type: EntityType | null;
    entity_id: string | null;
    created_at: string;
}

export async function claimWrite(db: D1Database, email: string, tool: string, requestKey: string | null): Promise<Claim> {
    const id = newId("mcw");
    const now = nowIso();
    const inserted = await db
        .prepare("INSERT INTO mcp_writes (id, email, tool, request_key, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?) ON CONFLICT DO NOTHING")
        .bind(id, email, tool, requestKey, now)
        .run();
    if (inserted.meta.changes) return { kind: "new", id };

    const existing = await db
        .prepare("SELECT id, tool, status, entity_type, entity_id, created_at FROM mcp_writes WHERE email = ? AND request_key = ?")
        .bind(email, requestKey)
        .first<LedgerRow>();
    // Cleared by a failure between our insert and this read: the caller can simply try again.
    if (!existing) throw new HttpError(409, "in_progress", "That request is being processed. Try again in a moment.");
    if (existing.tool !== tool) throw new HttpError(409, "request_id_reused", "That request id was already used for a different action. Use a new one.");
    if (existing.status === "done" && existing.entity_type && existing.entity_id) {
        return { kind: "replay", outcome: { entityType: existing.entity_type, entityId: existing.entity_id } };
    }
    if (Date.parse(existing.created_at) > Date.now() - STALE_MS) {
        throw new HttpError(409, "in_progress", "That request is being processed. Try again in a moment.");
    }
    const taken = await db
        .prepare("UPDATE mcp_writes SET created_at = ?, status = 'pending' WHERE id = ? AND created_at = ?")
        .bind(now, existing.id, existing.created_at)
        .run();
    if (!taken.meta.changes) throw new HttpError(409, "in_progress", "That request is being processed. Try again in a moment.");
    return { kind: "new", id: existing.id };
}

export const settleWrite = (db: D1Database, id: string, outcome: WriteOutcome) =>
    db
        .prepare("UPDATE mcp_writes SET status = 'done', entity_type = ?, entity_id = ?, completed_at = ? WHERE id = ?")
        .bind(outcome.entityType, outcome.entityId, nowIso(), id)
        .run();

/** Records the failure and frees the request id, so a corrected retry with the same id can run. */
export const failWrite = (db: D1Database, id: string, code: string) =>
    db
        .prepare("UPDATE mcp_writes SET status = 'failed', request_key = NULL, error_code = ?, completed_at = ? WHERE id = ?")
        .bind(code.slice(0, 40), nowIso(), id)
        .run();
