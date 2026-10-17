// Knowledge's own audit trail (knowledge_audit), readable only by each space's owners. Entries name
// the action and the record id and, for changes, which fields changed: never titles, text or values,
// so the trail reveals nothing a permanently deleted note contained.
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { KnowledgeAuditEntry } from "../../src/shared/knowledge/types";
import { nowIso } from "../portal/db";

export interface KnowledgeAuditInput {
    spaceId: string;
    actor: string;
    action: string;
    entityType: "space" | "member" | "type" | "object" | "relation" | "revision";
    entityId?: string | null;
    summary: string;
    changes?: unknown;
}

/**
 * Builds the audit insert so it can go in the same batch as the change it records. `condition`
 * (e.g. "WHERE changes() > 0") makes the entry conditional on the batch's previous statement.
 */
export const knowledgeAudit = (db: D1Database, entry: KnowledgeAuditInput, condition = "", conditionBinds: unknown[] = []): D1PreparedStatement =>
    db
        .prepare(
            `INSERT INTO knowledge_audit (space_id, at, actor, action, entity_type, entity_id, summary, changes) SELECT ?, ?, ?, ?, ?, ?, ?, ? ${condition}`,
        )
        .bind(
            entry.spaceId,
            nowIso(),
            entry.actor,
            entry.action,
            entry.entityType,
            entry.entityId ?? null,
            entry.summary.slice(0, 300),
            entry.changes === undefined ? null : JSON.stringify(entry.changes),
            ...conditionBinds,
        );

export async function listKnowledgeAudit(db: D1Database, spaceId: string, limit = 100): Promise<KnowledgeAuditEntry[]> {
    const rows = await db
        .prepare("SELECT id, at, actor, action, entity_type, entity_id, summary FROM knowledge_audit WHERE space_id = ? ORDER BY id DESC LIMIT ?")
        .bind(spaceId, limit)
        .all<{ id: number; at: string; actor: string; action: string; entity_type: string; entity_id: string | null; summary: string }>();
    return rows.results.map((r) => ({
        id: r.id,
        at: r.at,
        actor: r.actor,
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        summary: r.summary,
    }));
}
