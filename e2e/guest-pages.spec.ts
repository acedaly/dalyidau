import { type APIRequestContext, type Page, expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

// The pages a guest opens from a message, in a real browser at desktop and phone sizes: their own
// invitation (from the invitation text) leading to the RSVP form, and the Save the Date with Add to
// Calendar. Nothing is sent. With CAPTURE=1 it saves screenshots (fictional names only, never a
// signed link) to docs/design/assets/guest-pages/.

const JSON_HEADERS = { Origin: "http://localhost:8787", "Content-Type": "application/json" };
const CAPTURE = !!process.env.CAPTURE;
const ASSETS = "docs/design/assets/guest-pages";

const api = async <T>(request: APIRequestContext, method: "post" | "put" | "patch" | "get", path: string, data?: unknown): Promise<T> => {
    const response = await request[method](path, { headers: JSON_HEADERS, ...(data === undefined ? {} : { data }) });
    expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
    return response.json() as Promise<T>;
};

const flags = (request: APIRequestContext, enabled: boolean) =>
    Promise.all(
        ["wedding.site.public", "rsvp.native", "wedding.save_the_date.public"].map((flag) => api(request, "put", `/api/portal/flags/${flag}`, { enabled })),
    );

const shot = async (page: Page, name: string) => {
    if (!CAPTURE) return;
    mkdirSync(ASSETS, { recursive: true });
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: `${ASSETS}/${name}.jpg`, fullPage: true, type: "jpeg", quality: 78 });
};

const noSidewaysScroll = async (page: Page) =>
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), "page scrolls sideways").toBeLessThanOrEqual(0);

test("a household opens its invitation from the text, then RSVPs; anyone can save the date", async ({ page, request }, info) => {
    test.setTimeout(60_000);
    const suffix = info.project.name;
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await api(request, "put", "/api/portal/settings/wedding", {
        partnerOne: "Aidan",
        partnerTwo: "Amelia",
        date: "2027-10-23",
        location: "Rhino Lodge · Dubbo, NSW",
        timeZone: "Australia/Sydney",
    });
    // Both projects share the database: reuse this spec's events rather than adding them twice.
    const existing = (await api<{ items: { id: string; name: string; venueName: string | null }[] }>(request, "get", "/api/portal/wedding/events")).items;
    const event = async (body: { name: string; startsAt: string; venueName: string }) =>
        existing.find((item) => item.name === body.name && item.venueName === body.venueName) ??
        (await api<{ item: { id: string } }>(request, "post", "/api/portal/wedding/events", body)).item;
    const ceremony = await event({ name: "Ceremony", startsAt: "2027-10-23T15:30", venueName: "Rhino Lodge" });
    const reception = await event({ name: "Reception", startsAt: "2027-10-23T17:30", venueName: "Rhino Lodge" });
    const home = (await api<{ item: { id: string } }>(request, "post", "/api/portal/wedding/households", { name: `Example ${suffix}` })).item;
    for (const firstName of ["Fred", "Ann"])
        await api(request, "post", "/api/portal/wedding/guests", {
            firstName,
            lastName: "Example",
            householdId: home.id,
            events: [ceremony.id, reception.id],
        });
    await flags(request, true);

    try {
        // The household's own signed link, exactly as the invitation text carries it.
        const sms = await api<{ body: string }>(request, "post", "/api/portal/wedding/messages/preview", {
            category: "invitation",
            channel: "sms",
            subject: "",
            body: "{{invitation_link}}",
            householdId: home.id,
        });
        const link = new URL(sms.body.trim());
        expect(link.pathname).toBe("/invitation");
        const token = link.searchParams.get("invite")!;

        await page.goto(`/wedding/invitation?invite=${encodeURIComponent(token)}`);
        await expect(page.getByRole("heading", { level: 1 })).toContainText("Aidan");
        await expect(page.getByText("Fred & Ann Example", { exact: true })).toBeVisible();
        // Other specs share this database and add their own events, so only this spec's times are
        // checked here; the shared-venue wording is covered in test/guest-journey.test.ts.
        await expect(page.getByText(/^Ceremony - \d{1,2}:\d{2} [ap]m/).first()).toBeVisible();
        await expect(page.getByText(/^Reception - 5:30 pm/).first()).toBeVisible();
        const rsvp = page.getByRole("link", { name: "RSVP", exact: true });
        await expect(rsvp).toBeVisible();
        expect(await rsvp.getAttribute("href")).toBe(`https://wedding.daly.id.au/rsvp?invite=${token}`);
        const pdf = page.getByRole("link", { name: "Download invitation (PDF)" });
        await expect(pdf).toBeVisible();
        expect(await pdf.getAttribute("href")).toBe(`https://wedding.daly.id.au/invitation.pdf?invite=${token}`);
        const file = await request.get(`/wedding/invitation.pdf?invite=${encodeURIComponent(token)}`);
        expect(file.headers()["content-type"]).toBe("application/pdf");
        await noSidewaysScroll(page);
        await shot(page, `invitation-page-${suffix}`);

        // The button's destination: the existing RSVP form, opened straight to this household.
        await page.goto(`/wedding/rsvp?invite=${encodeURIComponent(token)}`);
        await expect(page.getByRole("heading", { name: "Who's coming?" })).toBeVisible();
        await expect(page.getByText("Fred", { exact: false }).first()).toBeVisible();

        // A broken link gets a friendly page that names nobody.
        await page.goto("/wedding/invitation?invite=not-a-real-link");
        await expect(page.getByRole("heading", { name: "This invitation link isn’t working" })).toBeVisible();
        await expect(page.getByText("Fred")).toHaveCount(0);

        await page.goto("/wedding/save-the-date");
        await expect(page.getByText("Are getting married!")).toBeVisible();
        await expect(page.getByText("Saturday, 23 October 2027")).toBeVisible();
        await expect(page.getByText("Formal invitation to follow.")).toBeVisible();
        await expect(page.getByRole("heading", { name: "Add to calendar" })).toBeVisible();
        for (const name of ["Apple Calendar", "Google Calendar", "Outlook", "Microsoft 365"]) await expect(page.getByRole("link", { name })).toBeVisible();
        expect(await page.getByRole("link", { name: "Google Calendar" }).getAttribute("href")).toMatch(/^https:\/\/calendar\.google\.com\/calendar\/render\?/);
        expect(await page.getByRole("link", { name: "Apple Calendar" }).getAttribute("href")).toBe("https://wedding.daly.id.au/save-the-date.ics");
        const ics = await request.get("/wedding/save-the-date.ics");
        expect(ics.headers()["content-type"]).toBe("text/calendar; charset=utf-8");
        expect(await ics.text()).toContain("SUMMARY:Aidan & Amelia's Wedding");
        await noSidewaysScroll(page);
        await shot(page, `save-the-date-page-${suffix}`);
        expect(errors).toEqual([]);

        if (CAPTURE) {
            // The Save the Date email, rendered by the endpoint the portal's preview uses.
            const email = await api<{ html: string }>(request, "post", "/api/portal/wedding/messages/preview", {
                category: "save_the_date",
                channel: "email",
                subject: "Save the date: {{couple_names}}, {{wedding_date}}",
                body: "Dear {{greeting_names}},\n\nWe have some happy news to share!\n\n{{save_the_date_card}}\n\nWith love,\n{{couple_names}}",
                householdId: home.id,
            });
            await page.setViewportSize({ width: suffix === "mobile" ? 390 : 720, height: 900 });
            await page.setContent(email.html.replaceAll("https://wedding.daly.id.au", "http://localhost:8787"));
            await shot(page, `email-save-the-date-${suffix}`);
            if (suffix === "desktop") writeFileSync(`${ASSETS}/email-save-the-date.html`, email.html);
        }
    } finally {
        await flags(request, false);
    }
});
