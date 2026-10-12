import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";

let lastTimestamp = 0;
/**
 * The current time as ISO 8601, strictly increasing within an isolate. updated_at doubles as a
 * record version for compare-and-set saves, so two writes in the same millisecond must differ.
 */
export const nowIso = () => {
    lastTimestamp = Math.max(Date.now(), lastTimestamp + 1);
    return new Date(lastTimestamp).toISOString();
};

const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
/** Unambiguous for people reading codes off paper: no 0/O, 1/I/L, 5/S, 2/Z, U/V. */
const CODE_ALPHABET = "346789ABCDEFGHJKMNPQRTWXY";

const randomString = (alphabet: string, length: number) => {
    // Rejection sampling keeps every character equally likely.
    const out: string[] = [];
    const limit = 256 - (256 % alphabet.length);
    while (out.length < length) {
        const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
        for (const byte of bytes) {
            if (byte < limit && out.length < length) out.push(alphabet[byte % alphabet.length]);
        }
    }
    return out.join("");
};

/** Short, URL-safe, prefixed ids: "gst_9k2m4p7r1x3c". */
export const newId = (prefix: string) => `${prefix}_${randomString(ID_ALPHABET, 14)}`;

/** Eight characters from a 25-letter alphabet: about 37 bits, entered by hand, rate-limited server-side. */
export const newRsvpCode = () => randomString(CODE_ALPHABET, 8);

export const normaliseRsvpCode = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "");

export const parseJson = <T>(value: unknown, fallback: T): T => {
    if (typeof value !== "string" || !value) return fallback;
    try {
        return JSON.parse(value) as T;
    } catch {
        return fallback;
    }
};

export type Actor = string;

export interface AuditInput {
    actor: Actor;
    action: string;
    entityType: string;
    entityId?: string | null;
    summary: string;
    changes?: unknown;
}

/** Builds the audit insert so callers can put it in the same batch as the change it records. */
export const auditStatement = (db: D1Database, entry: AuditInput): D1PreparedStatement =>
    db
        .prepare("INSERT INTO audit_log (at, actor, action, entity_type, entity_id, summary, changes) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(
            nowIso(),
            entry.actor,
            entry.action,
            entry.entityType,
            entry.entityId ?? null,
            entry.summary.slice(0, 500),
            entry.changes === undefined ? null : JSON.stringify(entry.changes),
        );

/** Like auditStatement, but only records anything if the previous statement in the batch changed a row. */
export const auditIfChanged = (db: D1Database, entry: AuditInput): D1PreparedStatement =>
    db
        .prepare("INSERT INTO audit_log (at, actor, action, entity_type, entity_id, summary, changes) SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0")
        .bind(
            nowIso(),
            entry.actor,
            entry.action,
            entry.entityType,
            entry.entityId ?? null,
            entry.summary.slice(0, 500),
            entry.changes === undefined ? null : JSON.stringify(entry.changes),
        );

/** Aborts (and rolls back) the batch if the previous statement changed no rows. */
export const requireChange = (db: D1Database): D1PreparedStatement => db.prepare("INSERT INTO batch_guard (ok) SELECT 0 WHERE changes() = 0");

export const isGuardFailure = (error: unknown) => /batch_guard|CHECK constraint failed: ok = 1/.test(String((error as Error)?.message ?? error));

export const audit = async (db: D1Database, entry: AuditInput) => {
    await auditStatement(db, entry).run();
};

/** Field-level diff for the audit log: { field: [before, after] } for every changed field. */
export const diff = (before: Record<string, unknown>, after: Record<string, unknown>) => {
    const changes: Record<string, [unknown, unknown]> = {};
    for (const key of Object.keys(after)) {
        if (JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)) changes[key] = [before[key] ?? null, after[key] ?? null];
    }
    return changes;
};

/** SQLite LIKE pattern with the user's text escaped. Use with ESCAPE '\'. */
export const likePattern = (value: string) => `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** D1 caps bound parameters per statement; split long id lists. */
export const chunk = <T>(items: T[], size = 50): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
};

export const placeholders = (count: number) => Array.from({ length: count }, () => "?").join(", ");
