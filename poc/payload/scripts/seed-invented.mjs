// Invented wedding data for local Phase 0 runs, created through the existing portal API (so it's audited
// and validated exactly as real edits are). Never point this at anything but `wrangler dev`.
import { token, OWNER } from "./test-identity.mjs";

const base = process.argv[2] ?? "http://localhost:8790";
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(base)) throw new Error("Local wrangler dev only.");
const headers = { Host: "daly.id.au", Origin: "https://daly.id.au", "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": token(OWNER) };
const call = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${await response.text()}`);
    return response.json();
};

const ceremony = (await call("POST", "/api/portal/wedding/events", { name: "Ceremony", startsAt: "2027-03-20T15:00" })).item;
const reception = (await call("POST", "/api/portal/wedding/events", { name: "Reception", startsAt: "2027-03-20T18:00" })).item;
const families = [["The Testers", ["Tess", "Toby"]], ["The Placeholders", ["Pat"]], ["The Fictionals", ["Fern", "Felix", "Fay"]], ["The Samples", ["Sam"]]];
let n = 0;
for (const [name, people] of families) {
    const household = (await call("POST", "/api/portal/wedding/households", { name })).item;
    for (const first of people) {
        await call("POST", "/api/portal/wedding/guests", {
            firstName: first,
            lastName: name.replace("The ", "").replace(/s$/, ""),
            email: `${first.toLowerCase()}@example.test`,
            householdId: household.id,
            events: [ceremony.id, reception.id],
        });
        n++;
    }
}
await call("POST", "/api/portal/users", { email: "viewer@example.test", role: "viewer" });
console.log(`Seeded ${families.length} invented households, ${n} guests and a viewer.`);
