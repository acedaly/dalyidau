import AxeBuilder from "@axe-core/playwright";
import { type APIRequestContext, type Page, expect, test } from "@playwright/test";

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

test("launches Wedding Planner directly into its dashboard", async ({ page }) => {
    await page.goto("/portal");
    await expect(page.getByRole("heading", { level: 1, name: "Applications" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Wedding Planner" })).toBeVisible();
    await page.getByRole("link", { name: "Open Wedding Planner" }).click();
    await expect(page).toHaveURL(/\/portal\/wedding$/);
    await expect(page.getByText("Everything for", { exact: false })).toBeVisible();
    await expect(page.getByRole("link", { name: "All Applications" }).first()).toBeVisible();
});

test("every portal page loads, hydrates and fits the screen", async ({ page }) => {
    const errors = watchErrors(page);
    for (const path of [
        "/portal",
        "/portal/wedding",
        "/portal/wedding/guests",
        "/portal/wedding/guests/import",
        "/portal/wedding/households",
        "/portal/wedding/rsvps",
        "/portal/wedding/events",
        "/portal/wedding/communications",
        "/portal/wedding/invitations",
        "/portal/wedding/communications/providers",
        "/portal/wedding/tasks",
        "/portal/wedding/timeline",
        "/portal/wedding/seating",
        "/portal/wedding/catering",
        "/portal/wedding/budget",
        "/portal/wedding/suppliers",
        "/portal/wedding/website",
        "/portal/wedding/settings",
        "/portal/settings",
        "/portal/settings/access",
        "/portal/settings/features",
        "/portal/settings/calendar",
        "/portal/settings/security",
        "/portal/settings/privacy",
        "/portal/audit",
    ]) {
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, path).toBeLessThanOrEqual(0);
    }
    expect(errors).toEqual([]);
});

test("core portal workflows expose labelled controls and keyboard focus", async ({ page }) => {
    for (const path of [
        "/portal",
        "/portal/wedding/rsvps",
        "/portal/wedding/seating",
        "/portal/wedding/catering",
        "/portal/wedding/communications",
        "/portal/wedding/invitations",
        "/portal/wedding/communications/providers",
        "/portal/wedding/households",
        "/portal/wedding/guests/import",
    ]) {
        await page.goto(path);
        await expect(page.getByRole("main")).toBeVisible();
        await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
        const unlabelled = await page.locator("button, input:not([type=hidden]), select, textarea").evaluateAll((elements) =>
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
    await page.goto("/portal/wedding/invitations");

    await expect(page.getByRole("heading", { level: 2, name: "Invitation template" })).toBeVisible();
    await expect(page.getByLabel("Artwork")).toContainText("Australian native botanicals");
    await expect(page.getByLabel("Primary accent")).toContainText("Deep burgundy");
    await expect(page.getByLabel("Email greeting")).toHaveValue("Dear");
    await expect(page.getByText("Advanced delivery")).toBeVisible();
    await expect(page.getByLabel("Invitation wording")).toHaveValue("invite you to celebrate their marriage");
    await expect(page.getByRole("button", { name: "Save template" })).toBeVisible();
    await expect(page.getByText("Generating never sends.")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Invitation Studio workflow" })).toContainText("Check recipients");
    await expect(page.getByRole("heading", { level: 2, name: "Check recipients" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Mobile", exact: true })).toBeVisible();
});

test("builds an RSVP question with Untitled UI controls", async ({ page }, info) => {
    const question = `Which song will get you dancing? ${info.project.name}`;
    await page.goto("/portal/wedding/rsvps");
    await page.getByRole("tab", { name: /Questions/ }).click();
    await page.getByRole("button", { name: "Add question" }).click();
    const dialog = page.getByRole("dialog", { name: "Add RSVP question" });
    await dialog.getByLabel("Question").fill(question);
    await dialog.getByLabel("Help text").fill("One song is plenty.");
    // Enter is the accessible form-submit path and avoids viewport-dependent pointer coordinates.
    await dialog.getByLabel("Question").press("Enter");
    await expect(page.getByText("Question created")).toBeVisible();
    await expect(page.getByRole("heading", { name: question })).toBeVisible();
    await expect(page.getByText("v1").last()).toBeVisible();
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

    await page.goto("/portal/wedding/seating");
    await page.getByRole("button", { name: "Add table" }).first().click();
    const panel = page.getByRole("dialog");
    await panel.getByLabel("Name").fill(`Table ${suffix}`);
    await panel.getByLabel("Seats").fill("8");
    await panel.getByRole("button", { name: "Add table" }).click();
    await expect(page.getByText("Table added")).toBeVisible();
    await page.getByRole("button", { name: `Move Seat ${suffix}` }).click();
    await page.getByRole("menuitem", { name: `Move to Table ${suffix}` }).click();
    await expect(page.getByRole("region", { name: `Table ${suffix}` }).getByText(`Seat ${suffix}`, { exact: true })).toBeVisible();
    await expect(page.getByText("1 / 1")).toBeVisible();

    await page.goto("/portal/wedding/catering");
    await expect(page.getByRole("row", { name: new RegExp(`Seat ${suffix}`) })).toBeVisible();
    await page.getByRole("button", { name: new RegExp(`Meal for Seat ${suffix}$`) }).click();
    await page.getByRole("option", { name: "No meal" }).click();
    await expect(page.getByText("Meal updated")).toBeVisible();
});

test("adds a guest through the slide-over and finds them in the list", async ({ page }, info) => {
    const name = `Morgan ${info.project.name}`;
    await page.goto("/portal/wedding/guests");
    await page.getByRole("button", { name: "Add guest" }).first().click();
    const panel = page.getByRole("dialog");
    await panel.getByLabel("First name").fill("Morgan");
    await panel.getByLabel("Last name").fill(info.project.name);
    await panel.getByRole("textbox", { name: "Email", exact: true }).fill(`morgan-${info.project.name}@example.com`);
    await panel.getByRole("button", { name: "Add guest" }).click();
    await expect(page.getByText("Guest added")).toBeVisible();
    await expect(panel).toBeHidden();

    await page.getByRole("searchbox", { name: "Search guests" }).fill(name);
    await expect(page.getByRole("rowheader", { name: new RegExp(name) })).toBeVisible();

    // It survives a reload (it was saved, not just added to the page).
    await page.reload();
    await page.getByRole("searchbox", { name: "Search guests" }).fill(name);
    await expect(page.getByRole("rowheader", { name: new RegExp(name) })).toBeVisible();
});

test("shows field errors from the server next to the field", async ({ page }) => {
    await page.goto("/portal/wedding/guests");
    await page.getByRole("button", { name: "Add guest" }).first().click();
    const panel = page.getByRole("dialog");
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
    await page.goto("/portal/wedding/guests");
    await page.getByRole("button", { name: "Add guest" }).first().click();
    const panel = page.getByRole("dialog");
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
    await expect(page.getByText("Guest added")).toBeVisible();
});

test("customises the dashboard and keeps the layout", async ({ page }) => {
    await page.goto("/portal/wedding");
    await page.getByRole("button", { name: "Customise" }).click();
    const widgets = page.locator("main section[aria-labelledby]");
    const before = await widgets.count();
    await widgets.first().getByRole("button", { name: "Remove" }).click();
    await page.getByRole("button", { name: "Save layout" }).click();
    await expect(page.getByText("Dashboard saved")).toBeVisible();
    await page.reload();
    await expect(widgets).toHaveCount(before - 1);
    // Put it back for the other project.
    await page.getByRole("button", { name: "Customise" }).click();
    await page.getByRole("button", { name: "Reset to default" }).click();
    await expect(page.getByText("Dashboard reset")).toBeVisible();
});

test("a guest RSVPs on the public website with their household code", async ({ page, request, isMobile }, info) => {
    const suffix = info.project.name;
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Wedding" })).toHaveCount(0);
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
    if (isMobile) await page.getByRole("button", { name: "Open navigation menu" }).click();
    await expect(page.getByRole("link", { name: "Wedding" })).toBeVisible();
    await page.goto("/wedding");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Robin & Jules");
    // The wedding site has its own palette even when the visitor prefers dark mode.
    await page.emulateMedia({ colorScheme: "dark" });
    await page.reload();
    await expect(page.locator("html")).not.toHaveClass(/dark-mode/);

    await page.getByRole("link", { name: "RSVP" }).first().click();
    await expect(page).toHaveURL(/\/wedding\/rsvp$/);
    await page.getByLabel("Invitation code").fill(household.rsvpCode);
    await page.getByRole("button", { name: "Find my invitation" }).click();
    await expect(page.getByRole("heading", { name: "Who's coming?" })).toBeVisible();
    // Addressed like the invitation (the invited guests' names), with each guest listed to answer for.
    await expect(page.getByText("Replying for")).toBeVisible();
    await expect(page.getByText(`Taylor ${suffix}`, { exact: true })).toHaveCount(2);
    // Continuing without an answer explains what's missing.
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("We still need an answer for Taylor.")).toBeVisible();
    // Phones show the short label so both choices fit side by side.
    const accept = page.getByRole("radio", { name: isMobile ? "Accepts" : "Joyfully accepts" });
    await accept.click({ force: true });
    await expect(accept).toBeChecked();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Dietary requirements or allergies").fill("Vegetarian");
    await page.getByRole("button", { name: "Continue" }).click();
    // Transport and accommodation: optional, once per household. One guest, so no passenger count.
    await expect(page.getByRole("heading", { name: "Getting there and staying" })).toBeVisible();
    await page.getByText("Yes — both ways", { exact: true }).click();
    await expect(page.getByRole("textbox", { name: "How many of you need the bus to the wedding?" })).toHaveCount(0);
    await page.getByText("Accommodation in Dubbo", { exact: true }).click();
    await page.getByLabel("Accommodation name or location").fill(`Motel ${suffix}`);
    await page.getByRole("button", { name: "Review my RSVP" }).click();
    await expect(page.getByRole("heading", { name: "Does this look right?" })).toBeVisible();
    await expect(page.getByText("Dietary: Vegetarian")).toBeVisible();
    await expect(page.getByText("Yes — both ways")).toBeVisible();
    await expect(page.getByText(`Accommodation in Dubbo · Motel ${suffix}`)).toBeVisible();
    await page.getByRole("button", { name: "Send our RSVP" }).click();
    await expect(page.getByRole("heading", { name: "Thank you" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add to calendar" })).toBeVisible();
    await expect(page.getByText("celebrate with Taylor")).toBeVisible();
    expect(errors).toEqual([]);

    // The reply shows up in the portal.
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/portal/wedding/guests");
    await page.getByRole("searchbox", { name: "Search guests" }).fill(`Taylor ${suffix}`);
    await expect(page.getByRole("row", { name: new RegExp(`Taylor ${suffix}`) }).getByText("Attending")).toBeVisible();

    // …and on the planner's private transport overview, never on the public site.
    await page.goto("/portal/wedding/rsvps");
    await page.getByRole("tab", { name: /Transport/ }).click();
    await page.getByRole("searchbox", { name: "Search households or accommodation" }).fill(`Motel ${suffix}`);
    await expect(
        page
            .getByRole("row")
            .filter({ hasText: `Motel ${suffix}` })
            .getByText("Both ways"),
    ).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, "transport tab scrolls sideways").toBeLessThanOrEqual(0);
    await page.goto("/wedding");
    await expect(page.getByText(`Motel ${suffix}`)).toHaveCount(0);

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
        const signature = page.getByTestId("signature-botanicals").first();
        await expect(signature).toBeVisible();
        await expect(signature.locator("span").first()).toHaveCSS("background-image", /native-invitation-frame\.jpg/);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, `${path} scrolls sideways`).toBeLessThanOrEqual(0);
        // The preview banner belongs to the portal, so only the wedding site itself is checked.
        const results = await new AxeBuilder({ page }).include(".wedding-theme").exclude(".wedding-theme > p:first-of-type").analyze();
        expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    }

    await page.goto("/portal/wedding/website/preview");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Amelia & Aidan");
    if (isMobile) {
        await expect(page.getByTestId("hero-editorial-image")).toBeHidden();
        const heroBox = await page.getByTestId("wedding-hero").boundingBox();
        expect(heroBox && heroBox.height > heroBox.width).toBe(true);
        // The sticky RSVP bar appears once the hero has scrolled away, and the menu works without a page load.
        const bar = page.getByText("Will you join us?");
        await expect(bar).toBeHidden();
        await page.mouse.wheel(0, 1400);
        await expect(bar).toBeVisible();
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.getByLabel("Menu").click();
        await page.getByRole("link", { name: "Venue" }).click();
        await expect(page.getByRole("heading", { name: "Rhino Lodge", level: 2 })).toBeInViewport();
    } else {
        const imageBox = await page.getByTestId("hero-editorial-image").boundingBox();
        const copyBox = await page.getByTestId("hero-editorial-copy").boundingBox();
        expect(imageBox && copyBox && imageBox.x < copyBox.x && Math.abs(imageBox.y - copyBox.y) < 2).toBe(true);
        await page.getByRole("link", { name: "Explore our wedding" }).click();
        await expect(page.getByText("We are excited to be getting married and even more excited to share the day with you.")).toBeInViewport();
    }
    expect(errors).toEqual([]);
});

test("the mobile navigation drawer opens and navigates", async ({ page, isMobile }) => {
    test.skip(!isMobile, "mobile only");
    await page.goto("/portal/wedding");
    await page.getByRole("button", { name: "Open navigation" }).click();
    const drawer = page.getByRole("dialog", { name: "Navigation" });
    await expect(drawer).toBeVisible();
    await drawer.getByRole("link", { name: "Tasks" }).click();
    await expect(page).toHaveURL(/\/portal\/wedding\/tasks$/);
    await expect(page.getByRole("heading", { level: 1, name: "Tasks" })).toBeVisible();
});

test("dark mode works in the portal", async ({ page }) => {
    await page.goto("/portal/wedding");
    const toggle = page.getByRole("button", { name: "Toggle dark mode" }).last();
    if (!(await toggle.isVisible())) await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("button", { name: "Toggle dark mode" }).last().click();
    await expect(page.locator("html")).toHaveClass(/dark-mode/);
    await page.goto("/portal/wedding/guests");
    await expect(page.locator("html")).toHaveClass(/dark-mode/);
    // Restore.
    await page.evaluate(() => localStorage.removeItem("ui-theme"));
});

test("deletes a guest, restores it, then erases it with typed confirmation", async ({ page, request }, info) => {
    const name = `Rowan Erasable${info.project.name}`;
    await api(request, "post", "/api/portal/wedding/guests", { firstName: "Rowan", lastName: `Erasable${info.project.name}` });

    await page.goto("/portal/wedding/guests");
    await page.getByRole("searchbox", { name: "Search guests" }).fill(name);
    await page.getByRole("rowheader", { name: new RegExp(name) }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete guest" }).click();
    await expect(page.getByText("Guest deleted")).toBeVisible();

    await page.goto("/portal/settings/privacy");
    const row = page.getByRole("row", { name: new RegExp(name) });
    await row.getByRole("button", { name: "Restore" }).click();
    await expect(page.getByText(`${name} restored`)).toBeVisible();
    await expect(row).toBeHidden();

    // Delete again via the API, then erase from the UI.
    const guests = (await (await request.get("/api/portal/wedding/guests")).json()).guests as { id: string; firstName: string; lastName: string }[];
    const id = guests.find((g) => `${g.firstName} ${g.lastName}` === name)!.id;
    await request.delete(`/api/portal/wedding/guests/${id}`, { headers: { Origin: "http://localhost:8787" } });
    await page.reload();
    await page
        .getByRole("row", { name: new RegExp(name) })
        .getByRole("button", { name: "Erase" })
        .click();
    const dialog = page.getByRole("dialog");
    const erase = dialog.getByRole("button", { name: "Erase permanently" });
    await dialog.getByLabel(/Type .* to confirm/).fill("wrong name");
    await erase.click();
    await expect(page.getByText("Couldn't erase")).toBeVisible();
    await dialog.getByLabel(/Type .* to confirm/).fill(name);
    await erase.click();
    await expect(page.getByText("Permanently erased")).toBeVisible();
    await expect(page.getByRole("row", { name: new RegExp(name) })).toBeHidden();
});
