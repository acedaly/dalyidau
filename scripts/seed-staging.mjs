// Fills the STAGING database (or a local one) with fictional demonstration data.
//
//   node scripts/seed-staging.mjs --yes                      # staging (remote)
//   node scripts/seed-staging.mjs --local [--persist-to dir] # a local database
//
// Every row it writes has an id starting with "demo_", and re-running it replaces only those rows,
// so it never touches anything else. It refuses to run against the production database, and checks
// that by database id, not just by name. All names are invented.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { environmentConfig, parseArgs, readWranglerConfig, wrangler } from "./lib/ops.mjs";

const args = parseArgs();
const local = !!args.local;
const config = readWranglerConfig();
const staging = environmentConfig(config, "staging").d1.find((d) => d.binding === "DB");
const production = environmentConfig(config, "production").d1.find((d) => d.binding === "DB");
if (!local) {
    if (!staging || !production || staging.database_id === production.database_id) {
        console.error("Refusing: staging and production share a database (or one is missing) in wrangler.jsonc.");
        process.exit(1);
    }
    if (!args.yes) {
        console.error(`This writes fictional demo rows to the staging database "${staging.database_name}". Re-run with --yes.`);
        process.exit(1);
    }
}

const q = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const now = new Date().toISOString();
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const wedding = day(200);
const rows = [];
const insert = (table, values) => {
    const cols = Object.keys(values);
    rows.push(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((c) => q(values[c])).join(", ")});`);
};

// Remove the previous demo data only.
const cleanup = [
    "DELETE FROM guest_events WHERE guest_id LIKE 'demo_%'",
    "DELETE FROM guests WHERE id LIKE 'demo_%'",
    "DELETE FROM households WHERE id LIKE 'demo_%'",
    "DELETE FROM events WHERE id LIKE 'demo_%'",
    "DELETE FROM tasks WHERE id LIKE 'demo_%'",
    "DELETE FROM budget_items WHERE id LIKE 'demo_%'",
    "DELETE FROM suppliers WHERE id LIKE 'demo_%'",
    "DELETE FROM timeline_items WHERE id LIKE 'demo_%'",
    "DELETE FROM message_templates WHERE id LIKE 'demo_%'",
].map((s) => `${s};`);

const events = [
    { id: "demo_evt_ceremony", name: "Ceremony", starts_at: `${wedding}T15:00`, ends_at: `${wedding}T15:45`, venue_name: "Demo Garden", sort_order: 10 },
    { id: "demo_evt_reception", name: "Reception", starts_at: `${wedding}T17:30`, ends_at: `${wedding}T23:00`, venue_name: "Demo Hall", sort_order: 20 },
];
for (const e of events) insert("events", { ...e, is_public: 1, rsvp_enabled: 1, created_at: now, updated_at: now });

const families = [
    ["The Examples", "partner_one", "Family", ["Avery", "Blair", "Casey"]],
    ["The Samples", "partner_two", "Family", ["Devon", "Emery"]],
    ["Finley & Gray", "shared", "Friends", ["Finley", "Gray"]],
    ["Harper", "partner_one", "Work", ["Harper"]],
    ["The Testers", "partner_two", "Friends", ["Indigo", "Jules", "Kai"]],
];
const statuses = ["attending", "declined", "pending", "attending"];
let n = 0;
families.forEach(([name, side, group, people], f) => {
    const hh = `demo_hh_${f}`;
    insert("households", {
        id: hh,
        name,
        rsvp_code: ["DEM3AAQX", "DEM4BBRX", "DEM6CCTX", "DEM7DDWX", "DEM8EEYX"][f],
        email: `demo${f}@example.com`,
        created_at: now,
        updated_at: now,
    });
    for (const first of people) {
        const id = `demo_gst_${n}`;
        insert("guests", {
            id,
            household_id: hh,
            first_name: first,
            last_name: name.replace(/^The /, "").replace(/s$/, "").split(" ")[0],
            email: `${first.toLowerCase()}@example.com`,
            side,
            group_name: group,
            age_group: first === "Kai" || first === "Casey" ? "child" : "adult",
            dietary: ["", "Vegetarian", "", "Gluten free"][n % 4] || null,
            tags: "[]",
            custom: "{}",
            created_at: now,
            updated_at: now,
        });
        const status = statuses[n % statuses.length];
        for (const e of events)
            insert("guest_events", {
                guest_id: id,
                event_id: e.id,
                status,
                source: status === "pending" ? null : "portal",
                responded_at: status === "pending" ? null : now,
            });
        n++;
    }
});

[
    ["Book the celebrant", "done", "high", -30],
    ["Confirm photographer", "in_progress", "high", 7],
    ["Send save-the-dates", "todo", "medium", 14],
    ["Choose flowers", "todo", "low", 45],
].forEach(([title, status, priority, due], i) =>
    insert("tasks", {
        id: `demo_tsk_${i}`,
        title,
        status,
        priority,
        due_date: day(due),
        created_at: now,
        updated_at: now,
        completed_at: status === "done" ? now : null,
    }),
);
insert("suppliers", { id: "demo_sup_photo", name: "Demo Photography", category: "Photography", status: "booked", created_at: now, updated_at: now });
insert("budget_items", {
    id: "demo_bud_photo",
    category: "Photography",
    description: "Photographer",
    supplier_id: "demo_sup_photo",
    estimated_cents: 450000,
    paid_cents: 100000,
    due_date: day(30),
    created_at: now,
    updated_at: now,
});
insert("timeline_items", {
    id: "demo_tli_ceremony",
    starts_at: `${wedding}T15:00`,
    title: "Ceremony",
    location: "Demo Garden",
    created_at: now,
    updated_at: now,
});
insert("message_templates", {
    id: "demo_tpl_std",
    name: "Save the date (demo)",
    subject: "Save the date, {{first_name}}",
    body: "Hi {{first_name}},\n\nPlease save {{wedding_date}}.",
    created_at: now,
    updated_at: now,
});

const dir = mkdtempSync(join(tmpdir(), "dalyidau-seed-"));
const file = join(dir, "demo.sql");
writeFileSync(file, [...cleanup, ...rows].join("\n") + "\n");
const target = local ? ["--local", "--env=", ...(args["persist-to"] ? ["--persist-to", args["persist-to"]] : [])] : ["--remote", "--env=staging"];
const result = wrangler(["d1", "execute", "DB", ...target, "--file", file, "--yes"]);
rmSync(dir, { recursive: true, force: true });
if (!result.ok) process.exit(1);
console.log(
    `Seeded ${n} fictional guests, ${families.length} households and planning data into ${local ? "the local database" : `staging (${staging.database_name})`}.`,
);
