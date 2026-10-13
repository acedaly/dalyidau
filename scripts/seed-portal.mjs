// Fills a LOCAL portal with realistic demo data so every screen has something to show.
//
//   npm run dev            (with ACCESS_DEV_EMAIL and PORTAL_OWNER_EMAILS in .dev.vars)
//   node scripts/seed-portal.mjs [http://localhost:8787]
//
// It refuses to run against anything but localhost. The names are invented.
import { readFile } from "node:fs/promises";

const base = (process.argv[2] ?? "http://localhost:8787").replace(/\/+$/, "");
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) {
    console.error(`Refusing to seed ${base}: demo data only goes into a local Worker.`);
    process.exit(1);
}

const call = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
        method,
        headers: { Origin: base, "Content-Type": "application/json", Accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text}`);
    return text ? JSON.parse(text) : null;
};

const today = new Date();
const inDays = (n) => new Date(today.getTime() + n * 86_400_000).toISOString().slice(0, 10);

await call("PUT", "/api/portal/settings/wedding", {
    partnerOne: "Robin",
    partnerTwo: "Jules",
    date: inDays(160),
    location: "Southern Highlands, NSW",
    timeZone: "Australia/Sydney",
});
const heroPhoto = await call("POST", "/api/portal/wedding/media", {
    data: (await readFile(new URL("../docs/design/wedding-redesign/hero-desktop.jpg", import.meta.url))).toString("base64"),
    alt: "A couple walking together beneath eucalyptus trees",
});
await call("PUT", "/api/portal/settings/website_draft", {
    heroEyebrow: "Together with their families",
    heroTitle: "",
    heroSubtitle: "invite you to celebrate their marriage among the gums.",
    heroImageId: heroPhoto.media.id,
    heroFocalX: 52,
    heroFocalY: 44,
    welcome: "We're so glad you're here.\n\nEverything you need for the weekend is below. If anything's unclear, just ask.",
    sections: [
        {
            id: "travel",
            title: "Getting there",
            body: "The venue is about ninety minutes from Sydney. There's plenty of parking, and a shuttle will run from the station.",
        },
        { id: "stay", title: "Where to stay", body: "We've held rooms at a couple of places nearby. Mention our names when you book." },
        {
            id: "faq",
            title: "Questions",
            body: "Can I bring a plus one? Your invitation lists everyone we've saved a seat for.\n\nAre kids welcome? Absolutely.",
        },
    ],
    contactEmail: "hello@example.com",
    noindex: true,
});
await call("POST", "/api/portal/wedding/website/publish", {});
await call("PUT", "/api/portal/flags/wedding.site.public", { enabled: true });
await call("PUT", "/api/portal/settings/rsvp", {
    externalUrl: "https://example.com/sayido",
    deadline: inDays(100),
    collectDietary: true,
    collectMessage: true,
});
await call("PUT", "/api/portal/settings/budget", { totalCents: 4_500_000, currency: "AUD" });

const existingEvents = (await call("GET", "/api/portal/wedding/events")).items;
const events = [];
for (const e of [
    {
        name: "Ceremony",
        startsAt: `${inDays(160)}T15:00`,
        endsAt: `${inDays(160)}T15:45`,
        venueName: "The Garden Chapel",
        address: "1 Example Lane",
        dressCode: "Garden formal",
        sortOrder: 10,
    },
    { name: "Reception", startsAt: `${inDays(160)}T17:30`, endsAt: `${inDays(160)}T23:30`, venueName: "The Barn", address: "1 Example Lane", sortOrder: 20 },
    { name: "Recovery brunch", startsAt: `${inDays(161)}T10:00`, venueName: "Café on the corner", isPublic: false, sortOrder: 30 },
]) {
    const existing = existingEvents.find((event) => event.name === e.name);
    const result = existing ? await call("PATCH", `/api/portal/wedding/events/${existing.id}`, e) : await call("POST", "/api/portal/wedding/events", e);
    events.push(result.item);
}

await call("POST", "/api/portal/wedding/custom-fields", {
    key: "meal",
    label: "Meal",
    type: "select",
    options: ["Beef", "Fish", "Vegetarian"],
    showInTable: true,
});

const families = [
    ["The Nguyens", "partner_one", "Family", ["Lan", "Minh", "Bao"]],
    ["The Okafors", "partner_two", "Family", ["Ada", "Chidi"]],
    ["Priya & Sam", "shared", "Friends", ["Priya", "Sam"]],
    ["The Walshes", "partner_one", "Family", ["Fiona", "Declan", "Orla"]],
    ["Marco", "partner_two", "Work", ["Marco"]],
    ["Hannah & Lee", "shared", "Friends", ["Hannah", "Lee"]],
    ["The Rossis", "partner_two", "Family", ["Gia", "Luca"]],
    ["Tom", "partner_one", "Friends", ["Tom"]],
];
const statuses = ["attending", "attending", "declined", "pending", "attending"];
let n = 0;
for (const [name, side, group, people] of families) {
    const household = (await call("POST", "/api/portal/wedding/households", { name, email: `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com` }))
        .item;
    for (const first of people) {
        const last = name.startsWith("The ") ? name.slice(4, -1) : "Example";
        const invited = n % 4 === 0 ? events.map((e) => e.id) : events.slice(0, 2).map((e) => e.id);
        const { guest } = await call("POST", "/api/portal/wedding/guests", {
            firstName: first,
            lastName: last,
            email: n % 5 === 3 ? "" : `${first.toLowerCase()}@example.com`,
            householdId: household.id,
            side,
            groupName: group,
            ageGroup: first === "Bao" || first === "Orla" ? "child" : "adult",
            dietary: ["", "Vegetarian", "", "Coeliac", "", "Vegan"][n % 6],
            events: invited,
            tags: n % 3 === 0 ? ["interstate"] : [],
            custom: { meal: ["Beef", "Fish", "Vegetarian"][n % 3] },
        });
        const status = statuses[n % statuses.length];
        if (status !== "pending")
            for (const eventId of invited)
                await call("PUT", `/api/portal/wedding/guests/${guest.id}/rsvp`, { eventId, status, source: n % 2 ? "sayido" : "portal" });
        n++;
    }
}

for (const t of [
    { title: "Book the celebrant", status: "done", priority: "high", category: "Ceremony", dueDate: inDays(-20) },
    { title: "Confirm photographer package", status: "in_progress", priority: "high", category: "Photography", dueDate: inDays(5) },
    { title: "Send save-the-dates", status: "todo", priority: "medium", category: "Guests", dueDate: inDays(12) },
    { title: "Taste menu with caterer", status: "todo", priority: "medium", category: "Catering", dueDate: inDays(-2) },
    { title: "Order flowers", status: "todo", priority: "low", category: "Styling", dueDate: inDays(40) },
])
    await call("POST", "/api/portal/wedding/tasks", t);

for (const [time, title, location, owner] of [
    ["13:00", "Hair and make-up", "Cottage", "Stylist"],
    ["15:00", "Ceremony", "Garden Chapel", "Celebrant"],
    ["16:00", "Photos", "The paddock", "Photographer"],
    ["17:30", "Reception opens", "The Barn", "Venue coordinator"],
    ["20:00", "Speeches", "The Barn", "MC"],
])
    await call("POST", "/api/portal/wedding/timeline", { startsAt: `${inDays(160)}T${time}`, title, location, owner });

const suppliers = {};
for (const s of [
    {
        name: "Gumtree Photography",
        category: "Photography",
        status: "booked",
        contactName: "Ellie",
        email: "ellie@example.com",
        website: "https://example.com",
    },
    { name: "The Barn", category: "Venue", status: "booked", contactName: "Venue team" },
    { name: "Wild Stems", category: "Styling", status: "quoted" },
])
    suppliers[s.category] = (await call("POST", "/api/portal/wedding/suppliers", s)).item.id;

for (const b of [
    {
        category: "Venue",
        description: "Venue hire",
        supplierId: suppliers.Venue,
        estimatedCents: 1_800_000,
        actualCents: 1_850_000,
        paidCents: 925_000,
        dueDate: inDays(30),
    },
    {
        category: "Photography",
        description: "Photographer (8 hours)",
        supplierId: suppliers.Photography,
        estimatedCents: 600_000,
        actualCents: 580_000,
        paidCents: 580_000,
    },
    { category: "Styling", description: "Flowers", supplierId: suppliers.Styling, estimatedCents: 300_000, paidCents: 0, dueDate: inDays(-3) },
    { category: "Catering", description: "Catering (per head)", estimatedCents: 1_200_000, paidCents: 200_000, dueDate: inDays(60) },
])
    await call("POST", "/api/portal/wedding/budget-items", b);

await call("POST", "/api/portal/wedding/templates", {
    name: "Save the date",
    subject: "Save the date: {{couple_names}}",
    body: "Hi {{first_name}},\n\nPlease save {{wedding_date}} for our wedding. Invitations to follow.\n\nRobin & Jules",
});

console.log(`Seeded ${n} guests, ${events.length} events and the rest at ${base}.`);
