// Guest CSV import. Header names are matched loosely so exports from other tools (including
// Say I Do's guest list export) can be used without editing. Always run with dryRun first: the
// portal shows the plan, and only a second request with dryRun=false writes anything.
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { AgeGroup, Guest, RsvpStatus, Side } from "../../src/shared/portal/types";
import { parseCsv } from "./csv";
import { auditStatement, chunk, newId, newRsvpCode, nowIso } from "./db";
import { ValidationError, customFieldDef, eventDef, listEntities } from "./entities";
import { cleanCustom, listGuests } from "./guests";

export const MAX_IMPORT_ROWS = 2000;
export const MAX_IMPORT_BYTES = 1_000_000;

const ALIASES: Record<string, string[]> = {
    firstName: ["first name", "firstname", "first", "given name", "given"],
    lastName: ["last name", "lastname", "last", "surname", "family name"],
    fullName: ["name", "full name", "guest", "guest name"],
    email: ["email", "email address", "e-mail"],
    phone: ["phone", "mobile", "phone number", "mobile number"],
    household: ["household", "party", "invitation", "family", "household name", "group name"],
    side: ["side"],
    groupName: ["group", "category", "relationship"],
    ageGroup: ["age group", "age", "adult/child", "type"],
    dietary: ["dietary", "dietary requirements", "diet", "dietary restrictions", "meal"],
    notes: ["notes", "note", "comments"],
    tags: ["tags", "labels"],
    rsvp: ["rsvp", "rsvp status", "attending", "status", "response"],
    events: ["events", "invited to"],
};

const norm = (value: string) =>
    value
        .trim()
        .toLowerCase()
        .replace(/[_\s]+/g, " ");

export interface ImportRowResult {
    line: number;
    action: "create" | "update" | "skip" | "error";
    name: string;
    message: string | null;
}

export interface ImportResult {
    dryRun: boolean;
    columns: { header: string; field: string | null }[];
    rows: ImportRowResult[];
    summary: { create: number; update: number; skip: number; error: number; newHouseholds: number };
}

const parseSide = (value: string, partnerNames: [string, string]): Side | null => {
    const v = norm(value);
    if (!v) return null;
    if (["both", "shared", "mutual", "joint"].includes(v)) return "shared";
    if (["1", "one", "partner one", "bride", "a", norm(partnerNames[0])].includes(v)) return "partner_one";
    if (["2", "two", "partner two", "groom", "b", norm(partnerNames[1])].includes(v)) return "partner_two";
    return null;
};

const parseAge = (value: string): AgeGroup | null => {
    const v = norm(value);
    if (!v) return null;
    if (["adult", "a", "18+"].includes(v)) return "adult";
    if (["child", "kid", "c", "children", "teen"].includes(v)) return "child";
    if (["infant", "baby", "toddler"].includes(v)) return "infant";
    return null;
};

const parseRsvp = (value: string): RsvpStatus | null | "invalid" => {
    const v = norm(value);
    if (!v) return null;
    if (["yes", "y", "attending", "accepted", "accept", "going", "confirmed", "true"].includes(v)) return "attending";
    if (["no", "n", "declined", "decline", "regrets", "not attending", "not going", "false"].includes(v)) return "declined";
    if (["pending", "awaiting", "no response", "unknown", "maybe", "invited"].includes(v)) return "pending";
    return "invalid";
};

export async function importGuests(
    db: D1Database,
    csv: string,
    options: { dryRun: boolean; actor: string; partnerNames: [string, string]; rsvpSource: "import" | "sayido" },
): Promise<ImportResult> {
    if (csv.length > MAX_IMPORT_BYTES) throw new ValidationError("The file is larger than 1 MB", "file");
    const table = parseCsv(csv);
    if (table.length < 2) throw new ValidationError("The file needs a header row and at least one guest", "file");
    if (table.length - 1 > MAX_IMPORT_ROWS) throw new ValidationError(`At most ${MAX_IMPORT_ROWS} guests per import`, "file");

    const [customFields, events, guests, householdRows] = await Promise.all([
        listEntities(db, customFieldDef),
        listEntities(db, eventDef),
        listGuests(db),
        db.prepare("SELECT id, name FROM households WHERE deleted_at IS NULL").all<{ id: string; name: string }>(),
    ]);
    const activeCustom = customFields.filter((f) => !f.archived);

    const header = table[0];
    const columns = header.map((raw) => {
        const h = norm(raw);
        const field = Object.entries(ALIASES).find(([, aliases]) => aliases.includes(h))?.[0];
        if (field) return { header: raw, field };
        const custom = activeCustom.find((f) => norm(f.label) === h || f.key === h.replace(/ /g, "_"));
        return { header: raw, field: custom ? `custom:${custom.key}` : null };
    });
    // The first matching column wins, so a later duplicate header is ignored rather than merged.
    const indexOf = (field: string) => columns.findIndex((c) => c.field === field);
    if (indexOf("firstName") < 0 && indexOf("fullName") < 0) {
        throw new ValidationError("Couldn't find a name column. Use “First name” and “Last name”, or “Name”.", "file");
    }

    const byEmail = new Map(guests.filter((g) => g.email).map((g) => [g.email!.toLowerCase(), g]));
    const byName = new Map(guests.map((g) => [`${norm(g.firstName)}|${norm(g.lastName)}`, g]));
    const households = new Map(householdRows.results.map((h) => [norm(h.name), h.id]));
    const newHouseholds = new Map<string, { id: string; name: string }>();
    const eventByName = new Map(events.map((e) => [norm(e.name), e]));

    const results: ImportRowResult[] = [];
    const statements: D1PreparedStatement[] = [];
    const seen = new Set<string>();
    const now = nowIso();

    for (let r = 1; r < table.length; r++) {
        const cells = table[r];
        const get = (field: string) => {
            const i = indexOf(field);
            return i >= 0 ? (cells[i] ?? "").trim() : "";
        };
        let firstName = get("firstName");
        let lastName = get("lastName");
        if (!firstName && get("fullName")) {
            const parts = get("fullName").split(/\s+/);
            firstName = parts.shift() ?? "";
            lastName = lastName || parts.join(" ");
        }
        const name = `${firstName} ${lastName}`.trim();
        const line = r + 1;
        const error = (message: string) => results.push({ line, action: "error", name: name || "(no name)", message });

        if (!firstName) {
            error("No first name");
            continue;
        }
        if (firstName.length > 80 || lastName.length > 80) {
            error("Name is longer than 80 characters");
            continue;
        }
        const email = get("email").toLowerCase() || null;
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            error(`“${email}” isn't a valid email address`);
            continue;
        }
        const key = email ?? `${norm(firstName)}|${norm(lastName)}`;
        if (seen.has(key)) {
            results.push({ line, action: "skip", name, message: "Duplicate of an earlier row in this file" });
            continue;
        }
        seen.add(key);

        const sideRaw = get("side");
        const side = parseSide(sideRaw, options.partnerNames);
        if (sideRaw && !side) {
            error(`Unknown side “${sideRaw}”`);
            continue;
        }
        const ageRaw = get("ageGroup");
        const ageGroup = parseAge(ageRaw);
        if (ageRaw && !ageGroup) {
            error(`Unknown age group “${ageRaw}”`);
            continue;
        }
        const rsvp = parseRsvp(get("rsvp"));
        if (rsvp === "invalid") {
            error(`Unknown RSVP “${get("rsvp")}”`);
            continue;
        }
        const eventNames = get("events")
            .split(/[;|]/)
            .map((e) => e.trim())
            .filter(Boolean);
        const missingEvent = eventNames.find((e) => !eventByName.has(norm(e)));
        if (missingEvent) {
            error(`No event called “${missingEvent}”`);
            continue;
        }
        const eventIds = eventNames.map((e) => eventByName.get(norm(e))!.id);

        let custom: Guest["custom"] = {};
        try {
            const raw: Record<string, unknown> = {};
            columns.forEach((c, i) => {
                if (c.field?.startsWith("custom:") && (cells[i] ?? "").trim() !== "") raw[c.field.slice(7)] = (cells[i] ?? "").trim();
            });
            custom = cleanCustom(raw, activeCustom);
        } catch (e) {
            error((e as Error).message);
            continue;
        }

        let householdId: string | null | undefined;
        const householdName = get("household");
        if (householdName) {
            householdId = households.get(norm(householdName)) ?? newHouseholds.get(norm(householdName))?.id;
            if (!householdId) {
                const created = { id: newId("hh"), name: householdName.slice(0, 120) };
                newHouseholds.set(norm(householdName), created);
                householdId = created.id;
                statements.push(
                    db
                        .prepare("INSERT INTO households (id, name, rsvp_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
                        .bind(created.id, created.name, newRsvpCode(), now, now),
                );
            }
        }

        const tags = get("tags")
            .split(/[;,]/)
            .map((t) => t.trim().slice(0, 40))
            .filter(Boolean);
        const existing = (email && byEmail.get(email)) || byName.get(`${norm(firstName)}|${norm(lastName)}`);
        const fieldsToSet: Record<string, unknown> = {
            first_name: firstName,
            last_name: lastName,
            ...(email ? { email } : {}),
            ...(get("phone") ? { phone: get("phone").slice(0, 40) } : {}),
            ...(householdId ? { household_id: householdId } : {}),
            ...(side ? { side } : {}),
            ...(get("groupName") ? { group_name: get("groupName").slice(0, 80) } : {}),
            ...(ageGroup ? { age_group: ageGroup } : {}),
            ...(get("dietary") ? { dietary: get("dietary").slice(0, 500) } : {}),
            ...(get("notes") ? { notes: get("notes").slice(0, 4000) } : {}),
        };

        const guestId = existing?.id ?? newId("gst");
        if (existing) {
            const mergedTags = [...new Set([...existing.tags, ...tags])];
            const mergedCustom = { ...existing.custom, ...custom };
            const sets = Object.keys(fieldsToSet).map((c) => `${c} = ?`);
            statements.push(
                db
                    .prepare(`UPDATE guests SET ${[...sets, "tags = ?", "custom = ?", "updated_at = ?"].join(", ")} WHERE id = ?`)
                    .bind(...Object.values(fieldsToSet), JSON.stringify(mergedTags), JSON.stringify(mergedCustom), now, guestId),
            );
            results.push({ line, action: "update", name, message: email && byEmail.has(email) ? "Matched by email" : "Matched by name" });
        } else {
            const cols = ["id", "created_at", "updated_at", "tags", "custom", ...Object.keys(fieldsToSet)];
            statements.push(
                db
                    .prepare(`INSERT INTO guests (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
                    .bind(guestId, now, now, JSON.stringify(tags), JSON.stringify(custom), ...Object.values(fieldsToSet)),
            );
            results.push({ line, action: "create", name, message: null });
        }

        for (const eventId of eventIds) {
            statements.push(db.prepare("INSERT OR IGNORE INTO guest_events (guest_id, event_id, status) VALUES (?, ?, 'pending')").bind(guestId, eventId));
        }
        if (rsvp) {
            // An RSVP applies to every event the guest is invited to, including ones added above.
            statements.push(
                db
                    .prepare("UPDATE guest_events SET status = ?, source = ?, responded_at = ? WHERE guest_id = ?")
                    .bind(rsvp, rsvp === "pending" ? null : options.rsvpSource, rsvp === "pending" ? null : now, guestId),
            );
        }
    }

    const summary = {
        create: results.filter((r) => r.action === "create").length,
        update: results.filter((r) => r.action === "update").length,
        skip: results.filter((r) => r.action === "skip").length,
        error: results.filter((r) => r.action === "error").length,
        newHouseholds: newHouseholds.size,
    };

    if (!options.dryRun && summary.create + summary.update > 0) {
        statements.push(
            auditStatement(db, {
                actor: options.actor,
                action: "guest.import",
                entityType: "guest",
                summary: `Imported guests: ${summary.create} added, ${summary.update} updated, ${summary.newHouseholds} new households`,
                changes: {
                    rows: results.filter((r) => r.action === "create" || r.action === "update").map((r) => ({ line: r.line, action: r.action, name: r.name })),
                },
            }),
        );
        // D1 batches are transactional; large imports are split, so each part is atomic on its own.
        for (const part of chunk(statements, 400)) await db.batch(part);
    }

    return { dryRun: options.dryRun, columns: columns.map((c) => ({ header: c.header, field: c.field })), rows: results, summary };
}
