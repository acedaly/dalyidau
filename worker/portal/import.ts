// Guest CSV import, including Say I Do's guest list export.
//
// Two steps, both computed from the same function so the preview is exactly what gets applied:
//   planImport   reads the file, groups guests into households (Say I Do: Party Name, checked
//                against Unique link), splits names, reconciles addresses, matches existing guests
//                and households, and describes every change. Nothing is written.
//   commitImport re-plans with the person's edits, checks nothing changed since the preview, then
//                applies everything in one D1 batch (all or nothing) with an audit entry and a
//                stored, exportable report.
//
// Rules that keep re-imports safe: households are found again by their Say I Do link, guests by
// name within that household; filling an empty field is an addition, but replacing a recorded
// value (a name, an address, an RSVP, a household) only happens when explicitly confirmed. An
// empty Attending cell is "no response", and "Plus One Allowed = No" never removes a named guest.
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { z } from "zod";
import {
    ADDRESS_FIELDS,
    type ImportDecisions,
    type ImportFieldChange,
    type ImportGuestPlan,
    type ImportHistoryEntry,
    type ImportHouseholdPlan,
    type ImportIssue,
    type ImportPlan,
    type ImportReport,
    type ImportReportRow,
    type ImportSuggestion,
    type ImportSummary,
    type PostalAddress,
    type SplitName,
    addressLooksIncomplete,
    formatAddress,
    groupAddresses,
    isBlankAddress,
    levenshtein,
    matchKey,
    parseAddress,
    properCase,
    sayIDoLinkId,
    splitGuestName,
    suggestPartyName,
} from "../../src/shared/portal/guest-import";
import { normaliseMobile, parseMobile } from "../../src/shared/portal/phone";
import type { AgeGroup, Guest, RsvpStatus, Side } from "../../src/shared/portal/types";
import { parseCsvRows, toCsv } from "./csv";
import { auditStatement, isGuardFailure, newId, newRsvpCode, nowIso, parseJson, requireChange } from "./db";
import { ConflictError, ValidationError, customFieldDef, eventDef, listEntities } from "./entities";
import { cleanCustom, listGuests } from "./guests";

export const MAX_IMPORT_ROWS = 2000;
export const MAX_IMPORT_BYTES = 1_000_000;

const ALIASES: Record<string, string[]> = {
    firstName: ["first name", "firstname", "first", "given name", "given"],
    lastName: ["last name", "lastname", "last", "surname", "family name"],
    fullName: ["name", "full name", "guest", "guest name"],
    email: ["email", "email address", "e-mail"],
    phone: ["phone", "mobile", "phone number", "mobile number", "mobile phone", "cell", "cell phone"],
    household: ["household", "party", "party name", "invitation", "family", "household name", "group name"],
    address: ["mailing address", "address", "postal address", "home address"],
    inviteLink: ["unique link", "invitation link", "rsvp link"],
    plusOne: ["plus one allowed", "plus one", "plus-one allowed", "plus ones allowed"],
    rowNumber: ["#", "no", "no."],
    side: ["side"],
    groupName: ["group", "category", "relationship"],
    ageGroup: ["age group", "age", "adult/child", "type"],
    dietary: ["dietary", "dietary requirements", "diet", "dietary restrictions", "meal"],
    notes: ["notes", "note", "comments"],
    tags: ["tags", "labels"],
    rsvp: ["rsvp", "rsvp status", "attending", "status", "response"],
    events: ["events", "invited to"],
};

export const FIELD_LABELS: Record<string, string> = {
    firstName: "First name",
    lastName: "Last name",
    household: "Household",
    email: "Email",
    phone: "Mobile",
    side: "Side",
    groupName: "Group",
    ageGroup: "Age group",
    dietary: "Dietary",
    notes: "Notes",
    rsvp: "RSVP",
    events: "Invited to",
    tags: "Tags",
    name: "Household name",
    address: "Address",
    link: "Say I Do party",
    order: "Position on invitation",
};

const norm = (value: string) =>
    value
        .trim()
        .toLowerCase()
        .replace(/[_\s]+/g, " ");

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

/** Only an explicit answer counts. Blank, "pending", "maybe" and the like are no response. */
const parseRsvp = (value: string): "attending" | "declined" | null | "invalid" => {
    const v = norm(value);
    if (!v) return null;
    if (["yes", "y", "attending", "accepted", "accept", "going", "confirmed", "true"].includes(v)) return "attending";
    if (["no", "n", "declined", "decline", "regrets", "not attending", "not going", "false"].includes(v)) return "declined";
    if (["pending", "awaiting", "no response", "unknown", "maybe", "invited", "-"].includes(v)) return null;
    return "invalid";
};

const parseYesNo = (value: string) => {
    const v = norm(value);
    if (["yes", "y", "true", "1"].includes(v)) return true;
    if (["no", "n", "false", "0"].includes(v)) return false;
    return null;
};

const sha256 = async (value: string) =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((b) => b.toString(16).padStart(2, "0")).join("");

const fullName = (g: { firstName: string; lastName: string }) => `${g.firstName} ${g.lastName}`.trim();
const nameKey = (first: string, last: string) => matchKey(`${first} ${last}`);
const RSVP_TEXT: Record<RsvpStatus, string> = { pending: "No response", attending: "Attending", declined: "Declined" };

// ---------------------------------------------------------------------------------------------
// Decisions sent back from the preview

const optText = (max: number) =>
    z
        .string()
        .trim()
        .max(max)
        .transform((v) => (v === "" ? null : v))
        .nullable();

const addressSchema = z.object({
    addressLine1: optText(200),
    addressLine2: optText(200),
    locality: optText(100),
    region: optText(100),
    postcode: optText(20),
    country: optText(100),
});

const confirmSchema = z.array(z.string().max(60)).max(30).optional();

export const decisionsSchema = z
    .object({
        households: z
            .record(
                z.string().max(400),
                z.object({
                    name: z.string().trim().min(1, "A household needs a name").max(120).optional(),
                    address: addressSchema.nullable().optional(),
                    target: z.string().max(40).optional(),
                    confirm: confirmSchema,
                }),
            )
            .default({}),
        guests: z
            .record(
                z.string().max(20),
                z.object({
                    firstName: z.string().trim().min(1, "First name is required").max(80).optional(),
                    lastName: z.string().trim().max(80).optional(),
                    target: z.string().max(40).optional(),
                    confirm: confirmSchema,
                }),
            )
            .default({}),
        inviteEventIds: z.array(z.string().max(40)).max(50).optional(),
        rsvpSource: z.enum(["sayido", "import"]).optional(),
    })
    .default({ households: {}, guests: {} });

// ---------------------------------------------------------------------------------------------
// Reading the file

interface RowData {
    line: number;
    rawName: string;
    split: SplitName;
    email: string | null;
    phone: string | null;
    side: Side | null;
    ageGroup: AgeGroup | null;
    groupName: string | null;
    dietary: string | null;
    notes: string | null;
    tags: string[];
    custom: Guest["custom"];
    /** Events named in an Events column; null when the file doesn't say. */
    eventIds: string[] | null;
    rsvp: "attending" | "declined" | null;
    addressRaw: string | null;
    partyName: string | null;
    linkId: string | null;
    plusOne: boolean | null;
    issues: ImportIssue[];
}

interface ExistingHousehold {
    id: string;
    name: string;
    address: PostalAddress;
    externalSource: string | null;
    externalId: string | null;
    updatedAt: string;
    deleted: boolean;
}

interface HouseholdWrite {
    key: string;
    kind: "create" | "update" | "none" | "skip";
    id: string | null;
    name: string;
    columns: Record<string, unknown>;
    expectedUpdatedAt: string | null;
}

interface GuestWrite {
    key: string;
    kind: "create" | "update" | "none" | "skip";
    id: string | null;
    columns: Record<string, unknown>;
    addEvents: string[];
    rsvp: { eventId: string; from: RsvpStatus; to: "attending" | "declined" }[];
    expectedUpdatedAt: string | null;
}

export interface PlannedImport {
    plan: ImportPlan;
    households: HouseholdWrite[];
    guests: GuestWrite[];
    rsvpSource: "sayido" | "import";
}

const ADDRESS_COLUMNS: Record<(typeof ADDRESS_FIELDS)[number], string> = {
    addressLine1: "address_line1",
    addressLine2: "address_line2",
    locality: "locality",
    region: "region",
    postcode: "postcode",
    country: "country",
};

const emptyAddress = (a: PostalAddress) => ADDRESS_FIELDS.every((f) => !a[f]);
const sameAddress = (a: PostalAddress, b: PostalAddress) =>
    ADDRESS_FIELDS.every((f) => matchKey(a[f] ?? "").replace(/[^a-z0-9]/g, "") === matchKey(b[f] ?? "").replace(/[^a-z0-9]/g, ""));

export async function planImport(db: D1Database, csv: string, decisionsInput: unknown, options: { partnerNames: [string, string] }): Promise<PlannedImport> {
    if (csv.length > MAX_IMPORT_BYTES) throw new ValidationError("The file is larger than 1 MB", "file");
    const decisions: ImportDecisions = decisionsSchema.parse(decisionsInput ?? {});
    const table = parseCsvRows(csv);
    if (table.length < 2) throw new ValidationError("The file needs a header row and at least one guest", "file");
    if (table.length - 1 > MAX_IMPORT_ROWS) throw new ValidationError(`At most ${MAX_IMPORT_ROWS} guests per import`, "file");

    const fileSha256 = await sha256(csv.replace(/^\uFEFF/, ""));
    const [customFields, events, liveGuests, guestRows, householdRows, previous] = await Promise.all([
        listEntities(db, customFieldDef),
        listEntities(db, eventDef),
        listGuests(db),
        db.prepare("SELECT id, first_name, last_name, household_id, household_order, updated_at, deleted_at FROM guests").all<{
            id: string;
            first_name: string;
            last_name: string;
            household_id: string | null;
            household_order: number | null;
            updated_at: string;
            deleted_at: string | null;
        }>(),
        db.prepare("SELECT * FROM households").all<Record<string, unknown>>(),
        db
            .prepare("SELECT id, created_at, actor FROM guest_imports WHERE file_sha256 = ? ORDER BY created_at DESC LIMIT 5")
            .bind(fileSha256)
            .all<{ id: string; created_at: string; actor: string }>(),
    ]);
    const activeCustom = customFields.filter((f) => !f.archived);
    const fileIssues: ImportIssue[] = [];

    // --- Columns. Header cells that are blank (a trailing comma) are not columns.
    const header = table[0].cells.map((h) => h.trim());
    while (header.length && header[header.length - 1] === "") header.pop();
    const columns = header.map((raw) => {
        const h = norm(raw);
        const field = Object.entries(ALIASES).find(([, aliases]) => aliases.includes(h))?.[0];
        if (field) return { header: raw, field };
        const custom = activeCustom.find((f) => norm(f.label) === h || f.key === h.replace(/ /g, "_"));
        return { header: raw, field: custom ? `custom:${custom.key}` : null };
    });
    const indexOf = (field: string) => columns.findIndex((c) => c.field === field);
    if (indexOf("firstName") < 0 && indexOf("fullName") < 0) {
        throw new ValidationError("Couldn't find a name column. Use “First name” and “Last name”, “Name”, or “Guest Name”.", "file");
    }
    const source: ImportPlan["source"] = indexOf("inviteLink") >= 0 && indexOf("household") >= 0 && indexOf("fullName") >= 0 ? "sayido" : "csv";
    const rsvpSource = decisions.rsvpSource ?? (source === "sayido" ? "sayido" : "import");
    const eventByName = new Map(events.map((e) => [norm(e.name), e]));

    // --- Rows
    const errors: ImportPlan["errors"] = [];
    const rows: RowData[] = [];
    let trailingEmpty = 0;
    for (const { cells, line } of table.slice(1)) {
        const extra = cells.slice(header.length);
        const issues: ImportIssue[] = [];
        // Say I Do ends every row with a comma; an empty extra cell is harmless. Values beyond the
        // header are kept out of the import and pointed out.
        if (extra.some((cell) => cell.trim() !== "")) issues.push({ level: "warning", message: "Values beyond the last column were ignored." });
        else if (extra.length) trailingEmpty++;
        const get = (field: string) => {
            const i = indexOf(field);
            return i >= 0 ? (cells[i] ?? "").trim() : "";
        };

        let split: SplitName;
        let rawName: string;
        if (get("firstName")) {
            // Separate columns are taken as given; only the capitalisation and characters are checked.
            rawName = `${get("firstName")} ${get("lastName")}`.trim();
            const check = splitGuestName(rawName);
            const review = check.review.filter((r) => !r.startsWith("More than") && !r.startsWith("Only one"));
            if (!get("lastName")) review.push("No last name was given.");
            split = {
                firstName: get("firstName"),
                lastName: get("lastName"),
                review,
                suggestion: check.suggestion ? { firstName: properCase(get("firstName")), lastName: properCase(get("lastName")) } : null,
            };
        } else {
            rawName = get("fullName");
            split = splitGuestName(rawName);
        }
        const name = rawName || "(no name)";
        const fail = (message: string) => errors.push({ line, name, message });

        if (!split.firstName) {
            fail("No name");
            continue;
        }
        if (split.firstName.length > 80 || split.lastName.length > 80) {
            fail("Name is longer than 80 characters");
            continue;
        }
        const email = get("email").toLowerCase() || null;
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            fail(`“${email}” isn't a valid email address`);
            continue;
        }
        const sideRaw = get("side");
        const side = parseSide(sideRaw, options.partnerNames);
        if (sideRaw && !side) {
            fail(`Unknown side “${sideRaw}”`);
            continue;
        }
        const ageRaw = get("ageGroup");
        const ageGroup = parseAge(ageRaw);
        if (ageRaw && !ageGroup) {
            fail(`Unknown age group “${ageRaw}”`);
            continue;
        }
        const rsvp = parseRsvp(get("rsvp"));
        if (rsvp === "invalid") {
            fail(`Unknown RSVP “${get("rsvp")}”`);
            continue;
        }
        const eventNames = get("events")
            .split(/[;|]/)
            .map((e) => e.trim())
            .filter(Boolean);
        const missingEvent = eventNames.find((e) => !eventByName.has(norm(e)));
        if (missingEvent) {
            fail(`No event called “${missingEvent}”`);
            continue;
        }
        let custom: Guest["custom"] = {};
        try {
            const raw: Record<string, unknown> = {};
            columns.forEach((c, i) => {
                if (c.field?.startsWith("custom:") && (cells[i] ?? "").trim() !== "") raw[c.field.slice(7)] = (cells[i] ?? "").trim();
            });
            custom = cleanCustom(raw, activeCustom);
        } catch (e) {
            fail((e as Error).message);
            continue;
        }

        const linkRaw = get("inviteLink");
        const linkId = linkRaw ? sayIDoLinkId(linkRaw) : null;
        if (linkRaw && !linkId) issues.push({ level: "warning", message: `“${linkRaw.slice(0, 80)}” isn't a Say I Do invitation link, so it was ignored.` });
        else if (source === "sayido" && !linkRaw) issues.push({ level: "warning", message: "No unique link, so this guest is grouped by party name only." });
        const addressRaw = get("address");
        // Mobiles are stored in E.164. One that can't be read is left out (never blanking a number
        // the guest already has) and pointed out, rather than stopping the whole row.
        let phone: string | null = null;
        const phoneRaw = get("phone");
        if (phoneRaw) {
            const mobile = parseMobile(phoneRaw);
            if (mobile.ok) {
                phone = mobile.e164;
                if (mobile.assumed)
                    issues.push({ level: "info", message: `Mobile “${phoneRaw.slice(0, 40)}” was missing its leading 0; saved as ${mobile.e164}.` });
            } else {
                issues.push({ level: "warning", message: `Mobile “${phoneRaw.slice(0, 40)}” wasn't imported. ${mobile.message}` });
            }
        }

        rows.push({
            line,
            rawName,
            split,
            email,
            phone,
            side,
            ageGroup,
            groupName: get("groupName").slice(0, 80) || null,
            dietary: get("dietary").slice(0, 500) || null,
            notes: get("notes").slice(0, 4000) || null,
            tags: get("tags")
                .split(/[;,]/)
                .map((t) => t.trim().slice(0, 40))
                .filter(Boolean),
            custom,
            eventIds: eventNames.length ? [...new Set(eventNames.map((e) => eventByName.get(norm(e))!.id))] : null,
            rsvp,
            addressRaw: isBlankAddress(addressRaw) ? null : addressRaw,
            partyName: get("household").replace(/\s+/g, " ").trim() || null,
            linkId,
            plusOne: indexOf("plusOne") >= 0 ? parseYesNo(get("plusOne")) : null,
            issues,
        });
    }
    if (trailingEmpty > 0)
        fileIssues.push({ level: "info", message: `${trailingEmpty} rows ended with an extra empty column (normal for Say I Do); it was ignored.` });

    // --- Group into households: by Say I Do link when there is one, else by party name.
    interface Group {
        key: string;
        externalId: string | null;
        names: Map<string, number>;
        rows: RowData[];
        issues: ImportIssue[];
    }
    const groups = new Map<string, Group>();
    // Party name → the links used with it, to spot two different parties sharing a name.
    const linksByName = new Map<string, Set<string>>();
    for (const row of rows) {
        if (!row.partyName && !row.linkId) continue;
        const key = row.linkId ? `link:${row.linkId}` : `party:${matchKey(row.partyName!).slice(0, 200)}`;
        const group: Group = groups.get(key) ?? { key, externalId: row.linkId, names: new Map(), rows: [], issues: [] };
        if (row.partyName) group.names.set(row.partyName, (group.names.get(row.partyName) ?? 0) + 1);
        group.rows.push(row);
        groups.set(key, group);
        if (row.linkId && row.partyName) {
            const links = linksByName.get(matchKey(row.partyName)) ?? new Set<string>();
            links.add(row.linkId);
            linksByName.set(matchKey(row.partyName), links);
        }
    }
    for (const group of groups.values()) {
        if (group.names.size > 1) {
            group.issues.push({
                level: "warning",
                message: `These guests share one invitation link but have different party names (${[...group.names.keys()].map((n) => `“${n}”`).join(", ")}). They're kept together as one household.`,
            });
        }
        const sharedName = [...group.names.keys()].find((n) => (linksByName.get(matchKey(n))?.size ?? 0) > 1);
        if (group.externalId && sharedName) {
            group.issues.push({
                level: "warning",
                message: `Another party in this file is also called “${sharedName}” but has a different invitation link, so they're separate households.`,
            });
        }
    }

    // --- Existing records
    const existingHouseholds = new Map<string, ExistingHousehold>(
        householdRows.results.map((r) => [
            r.id as string,
            {
                id: r.id as string,
                name: r.name as string,
                address: {
                    addressLine1: (r.address_line1 as string | null) ?? null,
                    addressLine2: (r.address_line2 as string | null) ?? null,
                    locality: (r.locality as string | null) ?? null,
                    region: (r.region as string | null) ?? null,
                    postcode: (r.postcode as string | null) ?? null,
                    country: (r.country as string | null) ?? null,
                },
                externalSource: (r.external_source as string | null) ?? null,
                externalId: (r.external_id as string | null) ?? null,
                updatedAt: r.updated_at as string,
                deleted: !!r.deleted_at,
            },
        ]),
    );
    const liveHouseholds = [...existingHouseholds.values()].filter((h) => !h.deleted);
    const guestsById = new Map(liveGuests.map((g) => [g.id, g]));
    const guestsByName = new Map<string, Guest[]>();
    for (const g of liveGuests) {
        const key = nameKey(g.firstName, g.lastName);
        guestsByName.set(key, [...(guestsByName.get(key) ?? []), g]);
    }
    const guestsByEmail = new Map(liveGuests.filter((g) => g.email).map((g) => [g.email!.toLowerCase(), g]));
    const deletedGuests = guestRows.results.filter((g) => g.deleted_at);
    const storedOrder = new Map(guestRows.results.map((g) => [g.id, g.household_order]));
    // Any edit, addition or deletion anywhere in the guest list since the preview means "review again".
    const latest = (rows: Record<string, unknown>[]) => rows.reduce<string>((max, r) => (String(r.updated_at ?? "") > max ? String(r.updated_at) : max), "");
    const basis: Record<string, string> = {
        $list: `${guestRows.results.length}:${latest(guestRows.results)}:${householdRows.results.length}:${latest(householdRows.results)}`,
    };

    // --- Names, after the person's edits
    interface GuestDraft {
        row: RowData;
        key: string;
        firstName: string;
        lastName: string;
        groupKey: string | null;
        order: number | null;
    }
    const drafts: GuestDraft[] = rows.map((row) => {
        const edit = decisions.guests?.[`L${row.line}`];
        const groupKey = row.linkId ? `link:${row.linkId}` : row.partyName ? `party:${matchKey(row.partyName).slice(0, 200)}` : null;
        const order = groupKey ? groups.get(groupKey)!.rows.indexOf(row) + 1 : null;
        return {
            row,
            key: `L${row.line}`,
            firstName: edit?.firstName ?? row.split.firstName,
            lastName: edit?.lastName ?? row.split.lastName,
            groupKey,
            order,
        };
    });

    // A first pass of guest matching by name alone tells us which household a party may already be.
    const uniqueByName = (d: GuestDraft) => {
        const found = guestsByName.get(nameKey(d.firstName, d.lastName)) ?? [];
        return found.length === 1 ? found[0] : null;
    };

    // --- Households
    const householdPlans: ImportHouseholdPlan[] = [];
    const householdWrites: HouseholdWrite[] = [];
    const claimedHouseholds = new Set<string>();
    const householdTargetId = new Map<string, string | null>(); // group key → household id (new or existing); null = skipped

    for (const group of groups.values()) {
        const edit = decisions.households?.[group.key];
        const issues = [...group.issues];
        const sourceNames = [...group.names.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
        const groupDrafts = drafts.filter((d) => d.groupKey === group.key);
        const defaultName = sourceNames[0] ?? groupDrafts.map((d) => d.firstName).join(" & ");
        const name = (edit?.name ?? defaultName).slice(0, 120);

        // Address: the one most guests gave; differing addresses are a conflict to resolve.
        const addressChoices = groupAddresses(groupDrafts.map((d) => ({ raw: d.row.addressRaw, guest: fullName(d) })));
        const addressConflict = addressChoices.length > 1;
        const variants = new Set(groupDrafts.map((d) => d.row.addressRaw?.replace(/\s+/g, " ").trim()).filter(Boolean));
        if (addressConflict) issues.push({ level: "warning", message: "Guests in this party gave different addresses. Choose the right one." });
        else if (addressChoices.length === 1 && variants.size > 1)
            issues.push({ level: "info", message: "Guests gave slightly different versions of the same address; the most complete one is used." });
        if (addressChoices[0] && addressLooksIncomplete(addressChoices[0].text))
            issues.push({ level: "warning", message: `The address “${addressChoices[0].text}” looks incomplete.` });
        const address: PostalAddress | null =
            edit && "address" in edit && edit.address !== undefined ? edit.address : addressChoices[0] ? parseAddress(addressChoices[0].text) : null;

        // Target household
        let target: ImportHouseholdPlan["target"] = { kind: "new" };
        const byLink = group.externalId
            ? [...existingHouseholds.values()].find((h) => h.externalSource === "sayido" && h.externalId === group.externalId)
            : undefined;
        if (edit?.target === "skip") target = { kind: "skip", reason: "Skipped in the preview" };
        else if (edit?.target && edit.target !== "new") {
            const chosen = existingHouseholds.get(edit.target);
            if (!chosen || chosen.deleted) throw new ValidationError("That household no longer exists", `households.${group.key}`);
            // Its Say I Do link is how a re-import finds it; one household can't stand for two parties.
            if (group.externalId && chosen.externalId && chosen.externalId !== group.externalId)
                throw new ValidationError(`“${chosen.name}” is already another Say I Do party. Choose a different household.`, `households.${group.key}`);
            target = { kind: "existing", id: chosen.id, name: chosen.name, matchedBy: "chosen" };
        } else if (edit?.target === "new") {
            if (byLink) throw new ValidationError(`“${byLink.name}” already has this Say I Do link, so it can't be added again`, `households.${group.key}`);
        } else if (byLink) {
            target = byLink.deleted
                ? { kind: "skip", reason: `This party's household (“${byLink.name}”) was deleted. Restore it from Settings → Privacy, or skip it.` }
                : { kind: "existing", id: byLink.id, name: byLink.name, matchedBy: "link" };
        } else {
            const sameName = [...existingHouseholds.values()].filter(
                (h) => matchKey(h.name) === matchKey(name) && (!h.externalId || !group.externalId) && !claimedHouseholds.has(h.id),
            );
            const live = sameName.filter((h) => !h.deleted);
            if (live.length === 1) target = { kind: "existing", id: live[0].id, name: live[0].name, matchedBy: "name" };
            else if (live.length === 0 && sameName.length > 0)
                target = { kind: "skip", reason: `A household called “${name}” was deleted. Restore it from Settings → Privacy, or add this as new.` };
            else {
                // Every guest already exists and they all share one household (without its own link).
                const matched = groupDrafts.map(uniqueByName);
                const homes = new Set(matched.map((g) => g?.householdId ?? null));
                const [home] = homes;
                const candidate = home ? existingHouseholds.get(home) : undefined;
                if (
                    matched.every(Boolean) &&
                    homes.size === 1 &&
                    candidate &&
                    !candidate.deleted &&
                    !candidate.externalId &&
                    !claimedHouseholds.has(candidate.id)
                )
                    target = { kind: "existing", id: candidate.id, name: candidate.name, matchedBy: "guests" };
            }
        }
        if (target.kind === "existing") {
            if (claimedHouseholds.has(target.id) && target.matchedBy !== "chosen") {
                issues.push({ level: "warning", message: `“${target.name}” already matches another party in this file, so this one is added as new.` });
                target = { kind: "new" };
            } else claimedHouseholds.add(target.id);
        }

        // Suggestions: similar names and households some of these guests are already in.
        const suggestions: (ImportSuggestion & { score: number })[] = [];
        const words = new Set(
            matchKey(name)
                .split(/[\s,&]+/)
                .filter((w) => w.length > 2),
        );
        for (const h of liveHouseholds) {
            if (target.kind === "existing" && target.id === h.id) continue;
            if (group.externalId && h.externalId && h.externalId !== group.externalId) continue;
            const members = groupDrafts.filter((d) => uniqueByName(d)?.householdId === h.id).length;
            const theirs = matchKey(h.name)
                .split(/[\s,&]+/)
                .filter((w) => w.length > 2);
            const overlap = theirs.filter((w) => words.has(w)).length;
            const score = members * 2 + overlap / Math.max(1, Math.min(theirs.length, words.size));
            if (members > 0 || overlap / Math.max(1, Math.min(theirs.length, words.size)) >= 0.5)
                suggestions.push({
                    id: h.id,
                    name: h.name,
                    detail: formatAddress(h.address) || null,
                    reason: members > 0 ? `${members} of these guests ${members === 1 ? "is" : "are"} already in this household` : "Similar name",
                    score,
                });
        }
        const topSuggestions: ImportSuggestion[] = suggestions
            .sort((a, b) => b.score - a.score)
            .slice(0, 3)
            .map(({ id, name: n, detail, reason }) => ({ id, name: n, detail, reason }));

        // Changes
        const confirmed = new Set(edit?.confirm ?? []);
        const changes: ImportFieldChange[] = [];
        const columns: Record<string, unknown> = {};
        let write: HouseholdWrite;
        if (target.kind === "skip") {
            write = { key: group.key, kind: "skip", id: null, name, columns, expectedUpdatedAt: null };
        } else if (target.kind === "new") {
            Object.assign(columns, { name, external_source: group.externalId ? "sayido" : null, external_id: group.externalId });
            for (const f of ADDRESS_FIELDS) columns[ADDRESS_COLUMNS[f]] = address?.[f] ?? null;
            changes.push({ field: "name", label: FIELD_LABELS.name, from: null, to: name, needsConfirmation: false, applied: true });
            if (address && !emptyAddress(address))
                changes.push({
                    field: "address",
                    label: FIELD_LABELS.address,
                    from: null,
                    to: formatAddress(address),
                    needsConfirmation: false,
                    applied: true,
                });
            write = { key: group.key, kind: "create", id: newId("hh"), name, columns, expectedUpdatedAt: null };
        } else {
            const current = existingHouseholds.get(target.id)!;
            basis[current.id] = current.updatedAt;
            const change = (field: string, from: string | null, to: string | null, needsConfirmation: boolean) => {
                const applied = !needsConfirmation || confirmed.has(field);
                changes.push({ field, label: FIELD_LABELS[field] ?? field, from, to, needsConfirmation, applied });
                return applied;
            };
            if (matchKey(current.name) !== matchKey(name) || (edit?.name !== undefined && current.name !== name)) {
                if (change("name", current.name, name, true)) columns.name = name;
            }
            if (address && !emptyAddress(address) && !sameAddress(current.address, address)) {
                if (change("address", formatAddress(current.address) || null, formatAddress(address), !emptyAddress(current.address)))
                    for (const f of ADDRESS_FIELDS) columns[ADDRESS_COLUMNS[f]] = address[f] ?? null;
            } else if (edit?.address === null && !emptyAddress(current.address)) {
                if (change("address", formatAddress(current.address), null, true)) for (const f of ADDRESS_FIELDS) columns[ADDRESS_COLUMNS[f]] = null;
            }
            if (group.externalId && !current.externalId) {
                change("link", null, group.externalId, false);
                Object.assign(columns, { external_source: "sayido", external_id: group.externalId });
            }
            write = {
                key: group.key,
                kind: Object.keys(columns).length ? "update" : "none",
                id: current.id,
                name: (columns.name as string | undefined) ?? current.name,
                columns,
                expectedUpdatedAt: current.updatedAt,
            };
        }
        householdTargetId.set(group.key, write.kind === "skip" ? null : write.id);
        householdWrites.push(write);
        householdPlans.push({
            key: group.key,
            name,
            sourceNames,
            suggestedName: suggestPartyName(name),
            externalId: group.externalId,
            lines: group.rows.map((r) => r.line),
            address,
            addressChoices,
            addressConflict,
            target,
            action: write.kind === "none" ? "unchanged" : write.kind,
            changes,
            suggestions: topSuggestions,
            issues,
        });
    }

    // --- Events guests are invited to
    const eventIds = new Set(events.map((e) => e.id));
    if (decisions.inviteEventIds?.some((id) => !eventIds.has(id))) throw new ValidationError("One of the events no longer exists", "inviteEventIds");
    const rsvpEvents = events.filter((e) => e.rsvpEnabled);
    const inviteEventIds = decisions.inviteEventIds ?? (rsvpEvents.length ? rsvpEvents : events).map((e) => e.id);
    if (events.length === 0)
        fileIssues.push({
            level: "warning",
            message: "There are no events yet, so guests can't RSVP online until they're invited to one (Events, then Guests → Invite).",
        });
    else if (inviteEventIds.length === 0)
        fileIssues.push({ level: "warning", message: "New guests won't be invited to any event, so they can't RSVP online." });

    // --- Guests
    const guestPlans: ImportGuestPlan[] = [];
    const guestWrites: GuestWrite[] = [];
    const claimedGuests = new Map<string, number>(); // existing guest id → line
    const seenInParty = new Map<string, number>();

    for (const draft of drafts) {
        const { row } = draft;
        const edit = decisions.guests?.[draft.key];
        const issues = [...row.issues];
        const nameReview = edit?.firstName !== undefined || edit?.lastName !== undefined ? [] : row.split.review;
        const householdKey = draft.groupKey;
        const householdId = householdKey ? householdTargetId.get(householdKey) : null;
        const householdPlan = householdKey ? householdPlans.find((h) => h.key === householdKey)! : null;
        const targetHousehold = householdPlan?.target.kind === "existing" ? householdPlan.target.id : null;
        const name = fullName(draft);
        const key = nameKey(draft.firstName, draft.lastName);

        let target: ImportGuestPlan["target"] = { kind: "new" };
        const duplicateOf = seenInParty.get(`${householdKey ?? ""}|${key}`);
        if (householdKey && householdId === null) target = { kind: "skip", reason: "The party is skipped." };
        else if (edit?.target === "skip") target = { kind: "skip", reason: "Skipped in the preview" };
        else if (edit?.target && edit.target !== "new") {
            const chosen = guestsById.get(edit.target);
            if (!chosen) throw new ValidationError("That guest no longer exists", `guests.${draft.key}`);
            target = { kind: "existing", id: chosen.id, name: fullName(chosen), matchedBy: "chosen", householdName: chosen.householdName };
        } else if (edit?.target === "new") {
            // Explicitly a new person, even with a familiar name.
        } else if (duplicateOf !== undefined) {
            target = { kind: "skip", reason: `Same person as line ${duplicateOf} in this party.` };
        } else {
            const byEmail = row.email ? guestsByEmail.get(row.email) : undefined;
            const inHousehold = targetHousehold
                ? liveGuests.filter(
                      (g) =>
                          g.householdId === targetHousehold &&
                          (nameKey(g.firstName, g.lastName) === key ||
                              (matchKey(g.firstName) === matchKey(draft.firstName) && (!draft.lastName || !g.lastName))),
                  )
                : [];
            // Someone in this household first; failing that, the one person anywhere with this exact
            // name (found the same way on every import, so a re-import never duplicates them).
            const sameName = (guestsByName.get(key) ?? []).filter((g) => !claimedGuests.has(g.id));
            const match = byEmail ?? (inHousehold.length === 1 ? inHousehold[0] : undefined) ?? (sameName.length === 1 ? sameName[0] : undefined);
            const deleted = deletedGuests.find((g) => nameKey(g.first_name, g.last_name) === key && (!targetHousehold || g.household_id === targetHousehold));
            if (match)
                target = { kind: "existing", id: match.id, name: fullName(match), matchedBy: byEmail ? "email" : "name", householdName: match.householdName };
            else if (deleted)
                target = { kind: "skip", reason: "A guest with this name was deleted. Restore them from Settings → Privacy, or choose “Add as new”." };
            else if (sameName.length > 1)
                issues.push({ level: "warning", message: `${sameName.length} existing guests are called ${name}. Choose one below, or add as new.` });
        }
        if (target.kind === "existing") {
            const other = claimedGuests.get(target.id);
            if (other !== undefined && target.matchedBy !== "chosen") {
                issues.push({ level: "warning", message: `Line ${other} already matches ${target.name}, so this row is added as a new guest.` });
                target = { kind: "new" };
            } else if (other !== undefined) {
                throw new ValidationError(`${target.name} is chosen for two rows (lines ${other} and ${row.line})`, `guests.${draft.key}`);
            } else claimedGuests.set(target.id, row.line);
        }
        if (target.kind !== "skip") seenInParty.set(`${householdKey ?? ""}|${key}`, row.line);

        // Suggestions: existing people with a close name.
        const suggestions: ImportSuggestion[] = [];
        if (target.kind !== "existing" || target.matchedBy !== "email") {
            for (const g of liveGuests) {
                if (target.kind === "existing" && target.id === g.id) continue;
                const sameLast = matchKey(g.lastName) === matchKey(draft.lastName);
                const sameFirst = matchKey(g.firstName) === matchKey(draft.firstName);
                let reason: string | null = null;
                if (nameKey(g.firstName, g.lastName) === key) reason = "Same name";
                else if (sameFirst && (!g.lastName || !draft.lastName) && (!targetHousehold || g.householdId === targetHousehold)) reason = "Same first name";
                else if (sameLast && draft.lastName && levenshtein(matchKey(g.firstName), matchKey(draft.firstName)) <= 2) reason = "Similar first name";
                else if (sameFirst && draft.lastName && g.lastName && levenshtein(matchKey(g.lastName), matchKey(draft.lastName)) <= 2)
                    reason = "Similar last name";
                if (reason) suggestions.push({ id: g.id, name: fullName(g), detail: g.householdName, reason });
            }
        }

        // Changes
        const confirmed = new Set(edit?.confirm ?? []);
        const changes: ImportFieldChange[] = [];
        const columns: Record<string, unknown> = {};
        let addEvents: string[] = [];
        const rsvp: GuestWrite["rsvp"] = [];
        let write: GuestWrite;
        const add = (field: string, from: string | null, to: string | null, needsConfirmation: boolean) => {
            const applied = !needsConfirmation || confirmed.has(field);
            changes.push({ field, label: FIELD_LABELS[field] ?? field.replace(/^custom\./, ""), from, to, needsConfirmation, applied });
            return applied;
        };
        const optional: [string, string, unknown][] = [
            ["email", "email", row.email],
            ["phone", "phone", row.phone],
            ["side", "side", row.side],
            ["groupName", "group_name", row.groupName],
            ["ageGroup", "age_group", row.ageGroup],
            ["dietary", "dietary", row.dietary],
            ["notes", "notes", row.notes],
        ];

        if (target.kind === "skip") {
            write = { key: draft.key, kind: "skip", id: null, columns, addEvents, rsvp, expectedUpdatedAt: null };
        } else if (target.kind === "new") {
            Object.assign(columns, {
                first_name: draft.firstName,
                last_name: draft.lastName,
                household_id: householdId ?? null,
                household_order: draft.order,
                tags: JSON.stringify(row.tags),
                custom: JSON.stringify(row.custom),
            });
            for (const [, column, value] of optional) if (value) columns[column] = value;
            addEvents = row.eventIds ?? inviteEventIds;
            add("firstName", null, draft.firstName, false);
            if (draft.lastName) add("lastName", null, draft.lastName, false);
            if (householdPlan) add("household", null, householdPlan.name, false);
            if (addEvents.length) add("events", null, addEvents.map((id) => events.find((e) => e.id === id)!.name).join(", "), false);
            if (row.rsvp && addEvents.length) {
                add("rsvp", null, RSVP_TEXT[row.rsvp], false);
                for (const eventId of addEvents) rsvp.push({ eventId, from: "pending", to: row.rsvp });
            }
            write = { key: draft.key, kind: "create", id: newId("gst"), columns, addEvents, rsvp, expectedUpdatedAt: null };
        } else {
            const current = guestsById.get(target.id)!;
            basis[current.id] = current.updatedAt;
            // Names: case-only differences aren't changes, and a file without a surname never removes one.
            if (matchKey(current.firstName) !== matchKey(draft.firstName) || (edit?.firstName && current.firstName !== draft.firstName)) {
                if (add("firstName", current.firstName, draft.firstName, true)) columns.first_name = draft.firstName;
            }
            if (draft.lastName && (matchKey(current.lastName) !== matchKey(draft.lastName) || (edit?.lastName && current.lastName !== draft.lastName))) {
                if (add("lastName", current.lastName || null, draft.lastName, !!current.lastName)) columns.last_name = draft.lastName;
            }
            if (householdKey && householdId && current.householdId !== householdId) {
                if (add("household", current.householdName, householdPlan!.name, !!current.householdId)) columns.household_id = householdId;
            }
            for (const [field, column, value] of optional) {
                if (value === null || value === undefined) continue;
                const before = current[field as keyof Guest] as string | null;
                if (before === value || (typeof before === "string" && typeof value === "string" && before.trim() === value.trim())) continue;
                // The same mobile written differently isn't a change; the mobile number review tidies the stored format.
                if (field === "phone" && normaliseMobile(before) === value) continue;
                if (add(field, before ?? null, String(value), !!before)) columns[column] = value;
            }
            const newTags = row.tags.filter((t) => !current.tags.includes(t));
            if (newTags.length) {
                add("tags", current.tags.join(", ") || null, [...current.tags, ...newTags].join(", "), false);
                columns.tags = JSON.stringify([...current.tags, ...newTags]);
            }
            const custom = { ...current.custom };
            for (const [k, v] of Object.entries(row.custom)) {
                if (v === null || current.custom[k] === v) continue;
                const before = current.custom[k];
                if (add(`custom.${k}`, before === null || before === undefined ? null : String(before), String(v), before !== null && before !== undefined))
                    custom[k] = v;
            }
            if (JSON.stringify(custom) !== JSON.stringify(current.custom)) columns.custom = JSON.stringify(custom);
            // Keep the order guests appear on their invitation in step with the file. Reported (so a
            // reorder-only re-import can be applied), but never needs confirmation.
            const storedPosition = storedOrder.get(current.id) ?? null;
            if (draft.order !== null && householdId === (columns.household_id ?? current.householdId) && storedPosition !== draft.order) {
                if (storedPosition !== null) add("order", String(storedPosition), String(draft.order), false);
                columns.household_order = draft.order;
            }
            // Invitations: guests who aren't invited to anything yet get the chosen events.
            const invited = current.events.map((e) => e.eventId);
            addEvents = (row.eventIds ?? (invited.length ? [] : inviteEventIds)).filter((id) => !invited.includes(id));
            if (addEvents.length)
                add(
                    "events",
                    invited.map((id) => events.find((e) => e.id === id)?.name).join(", ") || null,
                    addEvents.map((id) => events.find((e) => e.id === id)!.name).join(", "),
                    false,
                );
            // RSVP: an answer fills a "no response"; replacing a recorded answer needs confirmation.
            if (row.rsvp) {
                const statuses = [
                    ...current.events.map((e) => ({ eventId: e.eventId, status: e.status })),
                    ...addEvents.map((eventId) => ({ eventId, status: "pending" as RsvpStatus })),
                ];
                const differing = statuses.filter((s) => s.status !== row.rsvp);
                if (differing.length) {
                    const overwrite = differing.some((s) => s.status !== "pending");
                    const from = [...new Set(differing.map((s) => RSVP_TEXT[s.status]))].join(" / ");
                    if (add("rsvp", from, RSVP_TEXT[row.rsvp], overwrite))
                        for (const s of differing) rsvp.push({ eventId: s.eventId, from: s.status, to: row.rsvp });
                }
            }
            const touched = Object.keys(columns).length > 0 || addEvents.length > 0 || rsvp.length > 0;
            write = { key: draft.key, kind: touched ? "update" : "none", id: current.id, columns, addEvents, rsvp, expectedUpdatedAt: current.updatedAt };
        }

        const reported = changes.filter((c) => c.applied);
        const action: ImportGuestPlan["action"] =
            write.kind === "skip"
                ? "skip"
                : write.kind === "create"
                  ? "create"
                  : reported.length === 0
                    ? "unchanged"
                    : reported.every((c) => c.field === "household" || c.field === "events")
                      ? "link"
                      : "update";
        guestWrites.push(write);
        guestPlans.push({
            key: draft.key,
            line: row.line,
            rawName: row.rawName,
            firstName: draft.firstName,
            lastName: draft.lastName,
            nameReview,
            suggestedName:
                row.split.suggestion && (row.split.suggestion.firstName !== draft.firstName || row.split.suggestion.lastName !== draft.lastName)
                    ? row.split.suggestion
                    : null,
            householdKey,
            rsvp: row.rsvp,
            plusOneAllowed: row.plusOne,
            target,
            action,
            changes,
            suggestions: suggestions.slice(0, 3),
            issues,
        });
    }

    // Households whose only change is new or moved guests still count as unchanged themselves.
    const count = <T extends string>(items: { action: T }[], keys: readonly T[]) =>
        Object.fromEntries(keys.map((k) => [k, items.filter((i) => i.action === k).length])) as Record<T, number>;
    const summary: ImportSummary = {
        rows: table.length - 1,
        guests: count(guestPlans, ["create", "update", "link", "unchanged", "skip"] as const),
        households: count(householdPlans, ["create", "update", "unchanged", "skip"] as const),
        errors: errors.length,
        nameReview: guestPlans.filter((g) => g.nameReview.length && g.action !== "skip").length,
        unconfirmed: [...guestPlans, ...householdPlans].reduce((n, p) => n + p.changes.filter((c) => !c.applied).length, 0),
        addressConflicts: householdPlans.filter((h) => h.addressConflict && h.action !== "skip").length,
    };

    return {
        plan: {
            source,
            fileSha256,
            columns,
            fileIssues,
            households: householdPlans,
            guests: guestPlans,
            errors,
            events: events.map((e) => ({ id: e.id, name: e.name, rsvpEnabled: e.rsvpEnabled })),
            inviteEventIds,
            previousImports: previous.results.map((p) => ({ id: p.id, createdAt: p.created_at, actor: p.actor })),
            basis,
            summary,
        },
        households: householdWrites,
        guests: guestWrites,
        rsvpSource,
    };
}

// ---------------------------------------------------------------------------------------------
// Applying

const commitSchema = z.object({
    csv: z.string().max(MAX_IMPORT_BYTES),
    fileName: z.string().trim().max(200).nullable().optional(),
    clientId: z.string().min(16).max(100),
    decisions: z.unknown().optional(),
    /** The basis the preview showed; anything that moved since means "review again". */
    basis: z.record(z.string().max(60), z.string().max(200)),
});

export const IMPORT_CHANGED_MESSAGE = "The guest list changed since this preview was made. Review the import again before applying it.";

export async function commitImport(
    db: D1Database,
    input: unknown,
    options: { actor: string; partnerNames: [string, string]; canEditRsvps: boolean },
): Promise<ImportReport> {
    const body = commitSchema.parse(input);
    const already = await db.prepare("SELECT id FROM guest_imports WHERE client_id = ?").bind(body.clientId).first<{ id: string }>();
    // A retried import (double click, flaky network) returns the first result and changes nothing.
    if (already) return (await getImportReport(db, already.id))!;

    const planned = await planImport(db, body.csv, body.decisions, { partnerNames: options.partnerNames });
    const { plan } = planned;
    for (const [id, version] of Object.entries(plan.basis)) {
        if (body.basis[id] !== version) throw new ConflictError(IMPORT_CHANGED_MESSAGE);
    }
    if (!options.canEditRsvps && planned.guests.some((g) => g.rsvp.length > 0)) {
        throw new ValidationError("You can't record RSVPs. Remove the Attending column, or ask someone who can.", "file");
    }

    const now = nowIso();
    const importId = newId("imp");
    const statements: D1PreparedStatement[] = [];
    const guarded = (statement: D1PreparedStatement) => statements.push(statement, requireChange(db));

    for (const h of planned.households) {
        if (h.kind === "create") {
            const cols = ["id", "rsvp_code", "created_at", "updated_at", ...Object.keys(h.columns)];
            statements.push(
                db
                    .prepare(`INSERT INTO households (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
                    .bind(h.id, newRsvpCode(), now, now, ...Object.values(h.columns)),
            );
        } else if (h.kind === "update") {
            const sets = Object.keys(h.columns).map((c) => `${c} = ?`);
            // Compare-and-set: if anyone saved this household since the preview, the whole import rolls back.
            guarded(
                db
                    .prepare(`UPDATE households SET ${[...sets, "updated_at = ?"].join(", ")} WHERE id = ? AND updated_at = ? AND deleted_at IS NULL`)
                    .bind(...Object.values(h.columns), now, h.id, h.expectedUpdatedAt),
            );
        }
    }
    for (const g of planned.guests) {
        if (g.kind === "create") {
            const cols = ["id", "created_at", "updated_at", ...Object.keys(g.columns)];
            statements.push(
                db
                    .prepare(`INSERT INTO guests (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
                    .bind(g.id, now, now, ...Object.values(g.columns)),
            );
        } else if (g.kind === "update" && Object.keys(g.columns).length) {
            const sets = Object.keys(g.columns).map((c) => `${c} = ?`);
            guarded(
                db
                    .prepare(`UPDATE guests SET ${[...sets, "updated_at = ?"].join(", ")} WHERE id = ? AND updated_at = ? AND deleted_at IS NULL`)
                    .bind(...Object.values(g.columns), now, g.id, g.expectedUpdatedAt),
            );
        }
        if (g.kind !== "create" && g.kind !== "update") continue;
        for (const eventId of g.addEvents)
            statements.push(db.prepare("INSERT OR IGNORE INTO guest_events (guest_id, event_id, status) VALUES (?, ?, 'pending')").bind(g.id, eventId));
        for (const r of g.rsvp) {
            // Only if the RSVP is still what the preview showed: a reply that arrives in between wins.
            guarded(
                db
                    .prepare("UPDATE guest_events SET status = ?, source = ?, responded_at = ? WHERE guest_id = ? AND event_id = ? AND status = ?")
                    .bind(r.to, planned.rsvpSource, now, g.id, r.eventId, r.from),
            );
        }
    }

    // The report
    const householdByKey = new Map(plan.households.map((h) => [h.key, h]));
    const writeByKey = new Map(planned.guests.map((g) => [g.key, g]));
    const householdWriteByKey = new Map(planned.households.map((h) => [h.key, h]));
    const reportRows: ImportReportRow[] = [
        ...plan.guests.map((g) => {
            const h = g.householdKey ? householdByKey.get(g.householdKey) : null;
            const hw = g.householdKey ? householdWriteByKey.get(g.householdKey) : null;
            const notes = [
                ...g.changes.map((c) =>
                    c.applied
                        ? `${c.label}: ${c.from ?? "—"} → ${c.to ?? "—"}`
                        : `${c.label} not changed (kept “${c.from ?? ""}”; the file had “${c.to ?? ""}”)`,
                ),
                ...(g.target.kind === "skip" ? [g.target.reason] : []),
                ...(g.target.kind === "existing" ? [`Matched existing guest by ${g.target.matchedBy === "chosen" ? "choice" : g.target.matchedBy}`] : []),
                ...g.nameReview.map((r) => `Name: ${r}`),
                ...(g.rsvp === null ? ["No RSVP in the file"] : []),
                ...(g.plusOneAllowed === false ? ["Plus one not allowed (named guests are still invited)"] : []),
                ...g.issues.map((i) => i.message),
                ...(h && h.lines[0] === g.line
                    ? [
                          ...h.issues.map((i) => `Household: ${i.message}`),
                          ...h.changes.filter((c) => !c.applied).map((c) => `Household ${c.label.toLowerCase()} not changed (kept “${c.from ?? ""}”)`),
                      ]
                    : []),
            ];
            return {
                line: g.line,
                name: `${g.firstName} ${g.lastName}`.trim(),
                householdName: h?.name ?? null,
                address: h?.address ? formatAddress(h.address) || null : null,
                action: g.action,
                householdAction: h?.action ?? null,
                guestId: writeByKey.get(g.key)?.id ?? null,
                householdId: hw?.id ?? null,
                notes,
            };
        }),
        ...plan.errors.map((e) => ({
            line: e.line,
            name: e.name,
            householdName: null,
            address: null,
            action: "error",
            householdAction: null,
            guestId: null,
            householdId: null,
            notes: [e.message],
        })),
    ].sort((a, b) => a.line - b.line);

    statements.push(
        db
            .prepare("INSERT INTO guest_imports (id, client_id, source, file_name, file_sha256, actor, created_at, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(importId, body.clientId, plan.source, body.fileName ?? null, plan.fileSha256, options.actor, now, JSON.stringify(plan.summary)),
        ...reportRows.map((r) =>
            db
                .prepare(
                    `INSERT INTO guest_import_rows (import_id, line, guest_id, household_id, name, household_name, address, action, household_action, notes)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .bind(importId, r.line, r.guestId, r.householdId, r.name, r.householdName, r.address, r.action, r.householdAction, JSON.stringify(r.notes)),
        ),
        auditStatement(db, {
            actor: options.actor,
            action: "guest.import",
            entityType: "guest",
            entityId: importId,
            summary:
                `Imported ${plan.source === "sayido" ? "a Say I Do guest list" : "guests"}: ${plan.summary.guests.create} added, ` +
                `${plan.summary.guests.update + plan.summary.guests.link} updated, ${plan.summary.guests.unchanged} unchanged, ` +
                `${plan.summary.households.create} new households`,
            // Who was touched, by id; names and addresses stay in the import report, which erasure scrubs.
            changes: {
                importId,
                ids: planned.guests.filter((g) => g.kind === "create" || g.kind === "update").map((g) => g.id),
                households: planned.households.filter((h) => h.kind === "create" || h.kind === "update").map((h) => h.id),
                summary: plan.summary,
            },
        }),
    );

    try {
        // One batch: D1 runs it as a single transaction, so the import applies completely or not at all.
        await db.batch(statements);
    } catch (error) {
        // A concurrent retry of this same import got there first (it fails on whichever unique
        // index or version check it hits first): return that result.
        const won = await db.prepare("SELECT id FROM guest_imports WHERE client_id = ?").bind(body.clientId).first<{ id: string }>();
        if (won) return (await getImportReport(db, won.id))!;
        if (isGuardFailure(error) || /UNIQUE constraint failed: households\.external/i.test(String((error as Error).message)))
            throw new ConflictError(IMPORT_CHANGED_MESSAGE);
        throw error;
    }
    return (await getImportReport(db, importId))!;
}

// ---------------------------------------------------------------------------------------------
// Reports

export async function listImports(db: D1Database, limit = 20): Promise<ImportHistoryEntry[]> {
    const rows = await db.prepare("SELECT * FROM guest_imports ORDER BY created_at DESC LIMIT ?").bind(limit).all<Record<string, unknown>>();
    return rows.results.map((r) => ({
        id: r.id as string,
        createdAt: r.created_at as string,
        actor: r.actor as string,
        source: r.source as ImportHistoryEntry["source"],
        fileName: (r.file_name as string | null) ?? null,
        summary: parseJson<ImportSummary>(r.summary, {} as ImportSummary),
    }));
}

export async function getImportReport(db: D1Database, id: string): Promise<ImportReport | null> {
    const [batch, rows] = await db.batch([
        db.prepare("SELECT * FROM guest_imports WHERE id = ?").bind(id),
        db.prepare("SELECT * FROM guest_import_rows WHERE import_id = ? ORDER BY line").bind(id),
    ]);
    const b = batch.results[0] as Record<string, unknown> | undefined;
    if (!b) return null;
    return {
        id: b.id as string,
        createdAt: b.created_at as string,
        actor: b.actor as string,
        source: b.source as ImportReport["source"],
        fileName: (b.file_name as string | null) ?? null,
        summary: parseJson<ImportSummary>(b.summary, {} as ImportSummary),
        rows: (rows.results as Record<string, unknown>[]).map((r) => ({
            line: r.line as number,
            name: r.name as string,
            householdName: (r.household_name as string | null) ?? null,
            address: (r.address as string | null) ?? null,
            action: r.action as string,
            householdAction: (r.household_action as string | null) ?? null,
            guestId: (r.guest_id as string | null) ?? null,
            householdId: (r.household_id as string | null) ?? null,
            notes: parseJson<string[]>(r.notes, []),
        })),
    };
}

const ACTION_LABELS: Record<string, string> = {
    create: "Added",
    update: "Updated",
    link: "Linked to household",
    unchanged: "Already up to date",
    skip: "Skipped",
    error: "Not imported",
};

export const importReportCsv = (report: ImportReport) =>
    toCsv(report.rows, [
        { header: "Line", value: (r) => r.line },
        { header: "Guest", value: (r) => r.name },
        { header: "Result", value: (r) => ACTION_LABELS[r.action] ?? r.action },
        { header: "Household", value: (r) => r.householdName },
        { header: "Household result", value: (r) => (r.householdAction ? (ACTION_LABELS[r.householdAction] ?? r.householdAction) : null) },
        { header: "Address", value: (r) => r.address },
        { header: "Notes", value: (r) => r.notes.join("; ") },
    ]);
