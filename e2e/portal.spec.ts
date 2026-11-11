import AxeBuilder from "@axe-core/playwright";
import { type APIRequestContext, type Page, expect, test } from "@playwright/test";
import { at, screen } from "./helpers";

// The e2e Worker runs with ENVIRONMENT=development and ACCESS_DEV_EMAIL, so localhost requests act
// as an owner without Cloudflare Access. Both projects (desktop, mobile) share one database, so
// every name includes the project to keep runs independent.

const JSON_HEADERS = { Origin: "http://localhost:8787", "Content-Type": "application/json" };

const api = async (request: APIRequestContext, method: "post" | "put" | "patch", path: string, data: unknown) => {
    const response = await request[method](path, { headers: JSON_HEADERS, data });
    expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
    return response.json();
};

const watchErrors = (page: Page) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && !m.text().includes("Failed to load resource") && errors.push(m.text()));
    return errors;
};

test("old portal addresses open the wedding admin in Payload, with the wedding and administration menus", async ({ page }) => {
    await page.goto("/portal");
    await expect(page).toHaveURL(/\/admin\/wedding$/);
    await expect(at(page).getByText("Everything for", { exact: false })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Wedding and administration" });
    // Payload's menu starts closed for someone new, and on a phone.
    await expect(at(page).getByRole("heading", { level: 1 })).toBeVisible();
    if (!(await nav.getByRole("link", { name: "Guests" }).isVisible())) await page.locator(".nav-toggler, button[aria-label*='enu']").first().click();
    await expect(nav.getByRole("link", { name: "Guests" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Users and permissions" })).toBeVisible();
    await page.goto("/portal/settings/features");
    await expect(page).toHaveURL(/\/admin\/administration\/features$/);
    await expect(at(page).getByRole("heading", { level: 1, name: "Administration" })).toBeVisible();
});

test("every portal page loads, hydrates and fits the screen", async ({ page }) => {
    const errors = watchErrors(page);
    for (const path of [
        "/admin/wedding",
        "/admin/wedding/guests",
        "/admin/wedding/guests/import",
        "/admin/wedding/households",
        "/admin/wedding/rsvps",
        "/admin/wedding/events",
        "/admin/wedding/communications",
        "/admin/wedding/invitations",
        "/admin/wedding/communications/providers",
        "/admin/wedding/tasks",
        "/admin/wedding/timeline",
        "/admin/wedding/seating",
        "/admin/wedding/catering",
        "/admin/wedding/budget",
        "/admin/wedding/suppliers",
        "/admin/wedding/website",
        "/admin/wedding/settings",
        "/admin/administration",
        "/admin/administration/access",
        "/admin/administration/features",
        "/admin/administration/website",
        "/admin/administration/security",
        "/admin/administration/privacy",
        "/admin/administration/audit",
    ]) {
        await page.goto(path);
        await expect(at(page).getByRole("heading", { level: 1 })).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, path).toBeLessThanOrEqual(0);
    }
    expect(errors).toEqual([]);
});

test("core portal workflows expose labelled controls and keyboard focus", async ({ page }) => {
    for (const path of [
        "/admin/wedding",
        "/admin/wedding/rsvps",
        "/admin/wedding/seating",
        "/admin/wedding/catering",
        "/admin/wedding/communications",
        "/admin/wedding/invitations",
        "/admin/wedding/communications/providers",
        "/admin/wedding/households",
        "/admin/wedding/guests/import",
    ]) {
        await page.goto(path);
        await expect(screen(page)).toBeVisible();
        await expect(at(page).getByRole("heading", { level: 1 })).toHaveCount(1);
        const unlabelled = await at(page).locator("button, input:not([type=hidden]), select, textarea").evaluateAll((elements) =>
            elements
                .filter((element) => {
                    const labelled = element.getAttribute("aria-label") || element.getAttribute("aria-labelledby") || element.getAttribute("title");
                    const nativeLabel =
                        element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement
                            ? element.labels?.length
                            : false;
                    return !labelled && !nativeLabel && !element.textContent?.trim();
                })
                .map((element) => element.outerHTML.slice(0, 160)),
        );
        expect(unlabelled, path).toEqual([]);
        await page.keyboard.press("Tab");
        expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
    }
});

test("Invitation Studio exposes the shared native stationery template", async ({ page }) => {
    await page.goto("/admin/wedding/invitations");

    await expect(at(page).getByRole("heading", { level: 2, name: "Invitation template" })).toBeVisible();
    await expect(at(page).getByLabel("Artwork")).toContainText("Australian native botanicals");
    await expect(at(page).getByLabel("Primary accent")).toContainText("Deep burgundy");
    await expect(at(page).getByLabel("Email greeting")).toHaveValue("Dear");
    await expect(at(page).getByText("Advanced delivery")).toBeVisible();
    await expect(at(page).getByLabel("Invitation wording")).toHaveValue("invite you to celebrate their marriage");
    await expect(at(page).getByRole("button", { name: "Save template" })).toBeVisible();
    await expect(at(page).getByText("Generating never sends.")).toBeVisible();
    await expect(at(page).getByRole("navigation", { name: "Invitation Studio workflow" })).toContainText("Check recipients");
    await expect(at(page).getByRole("heading", { level: 2, name: "Check recipients" })).toBeVisible();
    await expect(at(page).getByRole("button", { name: "Mobile", exact: true })).toBeVisible();
});

test("builds an RSVP question with Untitled UI controls", async ({ page }, info) => {
    const question = `Which song will get you dancing? ${info.project.name}`;
    await page.goto("/admin/wedding/rsvps");
    await at(page).getByRole("tab", { name: /Questions/ }).click();
    await at(page).getByRole("button", { name: "Add question" }).click();
    const dialog = at(page).getByRole("dialog", { name: "Add RSVP question" });
    await dialog.getByLabel("Question").fill(question);
    await dialog.getByLabel("Help text").fill("One song is plenty.");
    // Enter is the accessible form-submit path and avoids viewport-dependent pointer coordinates.
    await dialog.getByLabel("Question").press("Enter");
    await expect(at(page).getByText("Question created")).toBeVisible();
    await expect(at(page).getByRole("heading", { name: question })).toBeVisible();
    await expect(at(page).getByText("v1").last()).toBeVisible();
});

test("connects RSVP attendance to seating and catering", async ({ page, request }, info) => {
    const suffix = `Flow ${info.project.name}`;
    const event = (await api(request, "post", "/api/portal/wedding/events", { name: `Reception ${suffix}` })).item;
    const household = (await api(request, "post", "/api/portal/wedding/households", { name: `Household ${suffix}` })).item;
    const guest = (
        await api(request, "post", "/api/portal/wedding/guests", {
            firstName: "Seat",
            lastName: suffix,
            householdId: household.id,
            events: [event.id],
        })
    ).guest;
    await api(request, "put", `/api/portal/wedding/guests/${guest.id}/rsvp`, { eventId: event.id, status: "attending" });
    await api(request, "put", "/api/portal/settings/catering", {
        eventId: event.id,
        categories: [
            { id: "adult_buffet", label: "Adult buffet", description: "", appliesTo: "any" },
            { id: "kids_meal", label: "Children's meal", description: "", appliesTo: "child" },
            { id: "no_meal", label: "No meal", description: "", appliesTo: "any" },
        ],
        adultDefault: "adult_buffet",
        notes: "",
    });

    await page.goto("/admin/wedding/seating");
    await at(page).getByRole("button", { name: "Add table" }).first().click();
    const panel = at(page).getByRole("dialog");
    await panel.getByLabel("Name").fill(`Table ${suffix}`);
    await panel.getByLabel("Seats").fill("8");
    await panel.getByRole("button", { name: "Add table" }).click();
    await expect(at(page).getByText("Table added")).toBeVisible();
    await at(page).getByRole("button", { name: `Move Seat ${suffix}` }).click();
    await at(page).getByRole("menuitem", { name: `Move to Table ${suffix}` }).click();
    await expect(at(page).getByRole("region", { name: `Table ${suffix}` }).getByText(`Seat ${suffix}`, { exact: true })).toBeVisible();
    await expect(at(page).getByText("1 / 1")).toBeVisible();

    await page.goto("/admin/wedding/catering");
    await expect(at(page).getByRole("row", { name: new RegExp(`Seat ${suffix}`) })).toBeVisible();
    await at(page).getByRole("button", { name: new RegExp(`Meal for Seat ${suffix}$`) }).click();
    await at(page).getByRole("option", { name: "No meal" }).click();
    await expect(at(page).getByText("Meal updated")).toBeVisible();
});

test("adds a guest through the slide-over and finds them in the list", async ({ page }, info) => {
    const name = `Morgan ${info.project.name}`;
    await page.goto("/admin/wedding/guests");
    await at(page).getByRole("button", { name: "Add guest" }).first().click();
    const panel = at(page).getByRole("dialog");
    await panel.getByLabel("First name").fill("Morgan");
    await panel.getByLabel("Last name").fill(info.project.name);
    await panel.getByRole("textbox", { name: "Email", exact: true }).fill(`morgan-${info.project.name}@example.com`);
    await panel.getByRole("button", { name: "Add guest" }).click();
    await expect(at(page).getByText("Guest added")).toBeVisible();
    await expect(panel).toBeHidden();

    await at(page).getByRole("searchbox", { name: "Search guests" }).fill(name);
    await expect(at(page).getByRole("rowheader", { name: new RegExp(name) })).toBeVisible();

    // It survives a reload (it was saved, not just added to the page).
    await page.reload();
    await at(page).getByRole("searchbox", { name: "Search guests" }).fill(name);
    await expect(at(page).getByRole("rowheader", { name: new RegExp(name) })).toBeVisible();
});

test("shows field errors from the server next to the field", async ({ page }) => {
    await page.goto("/admin/wedding/guests");
    await at(page).getByRole("button", { name: "Add guest" }).first().click();
    const panel = at(page).getByRole("dialog");
    await panel.getByLabel("First name").fill("Casey");
    await panel.getByRole("textbox", { name: "Email", exact: true }).fill("not-an-email");
    await panel.getByRole("button", { name: "Add guest" }).click();
    await expect(
        panel
            .getByText(/email/i)
            .filter({ hasText: /invalid|valid/i })
            .first(),
    ).toBeVisible();
    await expect(panel).toBeVisible();
});

test("guides mobile number entry and saves it in international format", async ({ page }, info) => {
    await page.goto("/admin/wedding/guests");
    await at(page).getByRole("button", { name: "Add guest" }).first().click();
    const panel = at(page).getByRole("dialog");
    await panel.getByLabel("First name").fill("Mobi");
    await panel.getByLabel("Last name").fill(info.project.name);
    const mobile = panel.getByRole("textbox", { name: "Mobile number" });
    await expect(panel.getByText("Australian mobile, e.g. 0412 345 678.")).toBeVisible();

    await mobile.fill("02 6884 0000");
    await mobile.blur();
    await expect(panel.getByText(/That looks like a landline/)).toBeVisible();
    // The server refuses it too, next to the field.
    await panel.getByRole("button", { name: "Add guest" }).click();
    await expect(panel.getByText(/That looks like a landline/)).toBeVisible();

    await mobile.fill("0412 345 678");
    await expect(panel.getByText("Will be saved as +61412345678.")).toBeVisible();
    await panel.getByRole("button", { name: "Add guest" }).click();
    await expect(at(page).getByText("Guest added")).toBeVisible();
});

test("customises the dashboard and keeps the layout", async ({ page }) => {
    await page.goto("/admin/wedding");
    await at(page).getByRole("button", { name: "Customise" }).click();
    const widgets = at(page).locator("section[aria-labelledby]");
    const before = await widgets.count();
    await widgets.first().getByRole("button", { name: "Remove" }).click();
    await at(page).getByRole("button", { name: "Save layout" }).click();
    await expect(at(page).getByText("Dashboard saved")).toBeVisible();
    await page.reload();
    await expect(widgets).toHaveCount(before - 1);
    // Put it back for the other project.
    await at(page).getByRole("button", { name: "Customise" }).click();
    await at(page).getByRole("button", { name: "Reset to default" }).click();
    await expect(at(page).getByText("Dashboard reset")).toBeVisible();
});

test("a guest RSVPs on the public website with their household code", async ({ page, request, isMobile }, info) => {
    const suffix = info.project.name;
    await page.goto("/");
    await expect(at(page).getByRole("link", { name: "Wedding" })).toHaveCount(0);
    await api(request, "put", "/api/portal/settings/wedding", {
        partnerOne: "Robin",
        partnerTwo: "Jules",
        date: "2027-03-20",
        location: "",
        timeZone: "Australia/Sydney",
    });
    const event = (await api(request, "post", "/api/portal/wedding/events", { name: `Ceremony ${suffix}`, startsAt: "2027-03-20T15:00" })).item;
    const household = (await api(request, "post", "/api/portal/wedding/households", { name: `The Testers ${suffix}` })).item;
    await api(request, "post", "/api/portal/wedding/guests", { firstName: "Taylor", lastName: suffix, householdId: household.id, events: [event.id] });
    await api(request, "put", "/api/portal/flags/wedding.site.public", { enabled: true });
    await api(request, "put", "/api/portal/flags/rsvp.native", { enabled: true });

    const errors = watchErrors(page);
    await page.goto("/");
    if (isMobile) await at(page).getByRole("button", { name: "Open navigation menu" }).click();
    await expect(at(page).getByRole("link", { name: "Wedding" })).toBeVisible();
    await page.goto("/wedding");
    await expect(at(page).getByRole("heading", { level: 1 })).toContainText("Robin & Jules");
    // The wedding site has its own palette even when the visitor prefers dark mode.
    await page.emulateMedia({ colorScheme: "dark" });
    await page.reload();
    await expect(at(page).locator("html")).not.toHaveClass(/dark-mode/);

    await at(page).getByRole("link", { name: "RSVP" }).first().click();
    await expect(page).toHaveURL(/\/wedding\/rsvp$/);
    await at(page).getByLabel("Invitation code").fill(household.rsvpCode);
    await at(page).getByRole("button", { name: "Find my invitation" }).click();
    await expect(at(page).getByRole("heading", { name: "Who's coming?" })).toBeVisible();
    // Addressed like the invitation (the invited guests' names), with each guest listed to answer for.
    await expect(at(page).getByText("Replying for")).toBeVisible();
    await expect(at(page).getByText(`Taylor ${suffix}`, { exact: true })).toHaveCount(2);
    // Continuing without an answer explains what's missing.
    await at(page).getByRole("button", { name: "Continue" }).click();
    await expect(at(page).getByText("We still need an answer for Taylor.")).toBeVisible();
    // Phones show the short label so both choices fit side by side.
    const accept = at(page).getByRole("radio", { name: isMobile ? "Accepts" : "Joyfully accepts" });
    await accept.click({ force: true });
    await expect(accept).toBeChecked();
    await at(page).getByRole("button", { name: "Continue" }).click();
    await at(page).getByLabel("Dietary requirements or allergies").fill("Vegetarian");
    await at(page).getByRole("button", { name: "Continue" }).click();
    // Transport and accommodation: optional, once per household. One guest, so no passenger count.
    await expect(at(page).getByRole("heading", { name: "Getting there and staying" })).toBeVisible();
    await at(page).getByText("Yes — both ways", { exact: true }).click();
    await expect(at(page).getByRole("textbox", { name: "How many of you need the bus to the wedding?" })).toHaveCount(0);
    await at(page).getByText("Accommodation in Dubbo", { exact: true }).click();
    await at(page).getByLabel("Accommodation name or location").fill(`Motel ${suffix}`);
    await at(page).getByRole("button", { name: "Review my RSVP" }).click();
    await expect(at(page).getByRole("heading", { name: "Does this look right?" })).toBeVisible();
    await expect(at(page).getByText("Dietary: Vegetarian")).toBeVisible();
    await expect(at(page).getByText("Yes — both ways")).toBeVisible();
    await expect(at(page).getByText(`Accommodation in Dubbo · Motel ${suffix}`)).toBeVisible();
    await at(page).getByRole("button", { name: "Send our RSVP" }).click();
    await expect(at(page).getByRole("heading", { name: "Thank you" })).toBeVisible();
    await expect(at(page).getByRole("button", { name: "Add to calendar" })).toBeVisible();
    await expect(at(page).getByText("celebrate with Taylor")).toBeVisible();
    expect(errors).toEqual([]);

    // The reply shows up in the portal.
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/admin/wedding/guests");
    await at(page).getByRole("searchbox", { name: "Search guests" }).fill(`Taylor ${suffix}`);
    await expect(at(page).getByRole("row", { name: new RegExp(`Taylor ${suffix}`) }).getByText("Attending")).toBeVisible();

    // …and on the planner's private transport overview, never on the public site.
    await page.goto("/admin/wedding/rsvps");
    await at(page).getByRole("tab", { name: /Transport/ }).click();
    await at(page).getByRole("searchbox", { name: "Search households or accommodation" }).fill(`Motel ${suffix}`);
    await expect(
        page
            .getByRole("row")
            .filter({ hasText: `Motel ${suffix}` })
            .getByText("Both ways"),
    ).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, "transport tab scrolls sideways").toBeLessThanOrEqual(0);
    await page.goto("/wedding");
    await expect(at(page).getByText(`Motel ${suffix}`)).toHaveCount(0);

    await api(request, "put", "/api/portal/flags/rsvp.native", { enabled: false });
    await api(request, "put", "/api/portal/flags/wedding.site.public", { enabled: false });
});

test("the wedding website is accessible and fits every screen", async ({ page, request, isMobile }) => {
    await api(request, "put", "/api/portal/settings/wedding", {
        partnerOne: "Amelia",
        partnerTwo: "Aidan",
        date: "2027-10-23",
        location: "Rhino Lodge · Dubbo, NSW",
        timeZone: "Australia/Sydney",
    });
    const errors = watchErrors(page);
    // Entrance animations fade text in; check contrast on the settled page.
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const path of ["/portal/wedding/website/preview", "/portal/wedding/website/preview/rsvp"]) {
        await page.goto(path);
        const signature = at(page).getByTestId("signature-botanicals").first();
        await expect(signature).toBeVisible();
        await expect(signature.locator("span").first()).toHaveCSS("background-image", /native-invitation-frame\.jpg/);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, `${path} scrolls sideways`).toBeLessThanOrEqual(0);
        // The preview banner belongs to the portal, so only the wedding site itself is checked.
        const results = await new AxeBuilder({ page }).include(".wedding-theme").exclude(".wedding-theme > p:first-of-type").analyze();
        expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    }

    await page.goto("/portal/wedding/website/preview");
    await expect(at(page).getByRole("heading", { level: 1 })).toContainText("Amelia & Aidan");
    if (isMobile) {
        await expect(at(page).getByTestId("hero-editorial-image")).toBeHidden();
        const heroBox = await at(page).getByTestId("wedding-hero").boundingBox();
        expect(heroBox && heroBox.height > heroBox.width).toBe(true);
        // The sticky RSVP bar appears once the hero has scrolled away, and the menu works without a page load.
        const bar = at(page).getByText("Will you join us?");
        await expect(bar).toBeHidden();
        await page.mouse.wheel(0, 1400);
        await expect(bar).toBeVisible();
        await page.evaluate(() => window.scrollTo(0, 0));
        await at(page).getByLabel("Menu").click();
        await at(page).getByRole("link", { name: "Venue" }).click();
        await expect(at(page).getByRole("heading", { name: "Rhino Lodge", level: 2 })).toBeInViewport();
    } else {
        const imageBox = await at(page).getByTestId("hero-editorial-image").boundingBox();
        const copyBox = await at(page).getByTestId("hero-editorial-copy").boundingBox();
        expect(imageBox && copyBox && imageBox.x < copyBox.x && Math.abs(imageBox.y - copyBox.y) < 2).toBe(true);
        await at(page).getByRole("link", { name: "Explore our wedding" }).click();
        await expect(at(page).getByText("We are excited to be getting married and even more excited to share the day with you.")).toBeInViewport();
    }
    expect(errors).toEqual([]);
});

test("deletes a guest, restores it, then erases it with typed confirmation", async ({ page, request }, info) => {
    const name = `Rowan Erasable${info.project.name}`;
    await api(request, "post", "/api/portal/wedding/guests", { firstName: "Rowan", lastName: `Erasable${info.project.name}` });

    await page.goto("/admin/wedding/guests");
    await at(page).getByRole("searchbox", { name: "Search guests" }).fill(name);
    await at(page).getByRole("rowheader", { name: new RegExp(name) }).click();
    await at(page).getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await at(page).getByRole("button", { name: "Delete guest" }).click();
    await expect(at(page).getByText("Guest deleted")).toBeVisible();

    await page.goto("/admin/administration/privacy");
    const row = at(page).getByRole("row", { name: new RegExp(name) });
    await row.getByRole("button", { name: "Restore" }).click();
    await expect(at(page).getByText(`${name} restored`)).toBeVisible();
    await expect(row).toBeHidden();

    // Delete again via the API, then erase from the UI.
    const guests = (await (await request.get("/api/portal/wedding/guests")).json()).guests as { id: string; firstName: string; lastName: string }[];
    const id = guests.find((g) => `${g.firstName} ${g.lastName}` === name)!.id;
    await request.delete(`/api/portal/wedding/guests/${id}`, { headers: { Origin: "http://localhost:8787" } });
    await page.reload();
    await at(page)
        .getByRole("row", { name: new RegExp(name) })
        .getByRole("button", { name: "Erase" })
        .click();
    const dialog = at(page).getByRole("dialog");
    const erase = dialog.getByRole("button", { name: "Erase permanently" });
    await dialog.getByLabel(/Type .* to confirm/).fill("wrong name");
    await erase.click();
    await expect(at(page).getByText("Couldn't erase")).toBeVisible();
    await dialog.getByLabel(/Type .* to confirm/).fill(name);
    await erase.click();
    await expect(at(page).getByText("Permanently erased")).toBeVisible();
    await expect(at(page).getByRole("row", { name: new RegExp(name) })).toBeHidden();
});

test("retired applications are gone from the portal, and their addresses say they're retired", async ({ page, request }) => {
    await page.goto("/admin/wedding");
    await expect(at(page).locator('[data-application]:not([data-application="wedding"])')).toHaveCount(0);
    await expect(
        at(page).getByRole("link", {
            name: /Daly Knowledge|Daly Tasks|Home & Assets|Household Finance|Daly Calendar|Daly Intelligence|Intelligence Centre|All Applications/,
        }),
    ).toHaveCount(0);
    for (const [path, message] of [
        ["/portal/knowledge", /Daly Knowledge and Daly Tasks have been retired/],
        ["/portal/tasks/today", /Daly Knowledge and Daly Tasks have been retired/],
        ["/portal/assets", /Home & Assets has been retired and replaced by Home in Cloudflare OS/],
        ["/portal/finance/transactions", /Household Finance has been retired and replaced by Finances in Cloudflare OS/],
        ["/portal/calendar", /Daly Calendar and the Leave Planner have been retired/],
        ["/portal/calendar/leave", /Daly Calendar and the Leave Planner have been retired/],
        ["/portal/today", /Today has been retired/],
        ["/portal/intelligence", /Daly Intelligence has been retired/],
        ["/portal/intelligence-centre", /The Intelligence Centre has been retired/],
        ["/portal/intelligence-centre/map", /The Intelligence Centre has been retired/],
    ] as const) {
        const response = await page.goto(path);
        expect(response?.status(), path).toBe(410);
        await expect(at(page).getByText(message).first()).toBeVisible();
    }
    // Their public addresses answer a plain 410 to anyone.
    for (const path of ["/display", "/calendar/feed/aBcDeFgHiJkLmNoPqRsTuVwXyZ012345.ics", "/api/display/wallboard"])
        expect((await request.get(path)).status(), path).toBe(410);
    expect((await request.post("/api/amplenote/ingest", { data: {} })).status()).toBe(410);
    // The Wedding Planner's own tasks and budget are different features.
    expect((await page.goto("/admin/wedding/tasks"))?.status()).toBe(200);
    expect((await page.goto("/admin/wedding/budget"))?.status()).toBe(200);
});
