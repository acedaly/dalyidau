import { type APIRequestContext, type Page, expect, test } from "@playwright/test";

// Guest import and the household RSVP, end to end. Desktop and mobile share one database, so
// every name and Say I Do link carries the project name to keep the two runs independent.

const JSON_HEADERS = { Origin: "http://localhost:8787", "Content-Type": "application/json" };

const api = async (request: APIRequestContext, method: "post" | "put" | "get", path: string, data?: unknown) => {
    const response = method === "get" ? await request.get(path) : await request[method](path, { headers: JSON_HEADERS, data });
    expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
    return response.json();
};

/** Letters only (digits in a name are flagged as unusual), unique per run, so reruns don't collide. */
const runTag = (project: string) =>
    (project === "mobile" ? "mob" : "dsk") + Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => String.fromCharCode(97 + (b % 26))).join("");

const watchErrors = (page: Page) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && !m.text().includes("Failed to load resource") && errors.push(m.text()));
    return errors;
};

// Compared with the visual viewport too: a phone zooms out to fit a too-wide page, which makes
// innerWidth grow with it and hides the overflow.
const noOverflow = async (page: Page, where: string) =>
    expect(
        await page.evaluate(() => document.documentElement.scrollWidth - Math.min(window.innerWidth, window.visualViewport?.width ?? window.innerWidth)),
        where,
    ).toBeLessThanOrEqual(0);

/** A small Say I Do export with the real file's quirks: blank second line, trailing comma, one-word names, a lower-case surname, differing addresses. */
const sayIDoCsv = (tag: string) =>
    [
        "#,Guest Name,Attending,Plus One Allowed,Party Name,Mailing Address,Unique link",
        "",
        `"1","Robin${tag}","","No","The Happy Couple ${tag}","-","https://sayi.do/s/${tag}A",`,
        `"2","Jules${tag}","","No","The Happy Couple ${tag}","-","https://sayi.do/s/${tag}A",`,
        `"3","Hayden smith${tag}","","No","Hayden smith${tag} & Indigo Pretend${tag}","25 Brolga Drive Sanctuary Example nsw 2005","https://sayi.do/s/${tag}B",`,
        `"4","Indigo Pretend${tag}","","No","Hayden smith${tag} & Indigo Pretend${tag}","25 Brolga Drive Sanctuary Example ","https://sayi.do/s/${tag}B",`,
        `"5","Drew Fictional${tag}","Yes","No","Drew & Emery Fictional${tag}","P.O. Box 99 Sampleville NSW 2002","https://sayi.do/s/${tag}C",`,
        `"6","Emery Fictional${tag}","","No","Drew & Emery Fictional${tag}","7 Banksia Road Otherplace NSW 2003","https://sayi.do/s/${tag}C",`,
        "",
    ].join("\n");

test("imports a Say I Do guest list after review, and re-importing changes nothing", async ({ page, request }, info) => {
    const tag = runTag(info.project.name);
    await api(request, "post", "/api/portal/wedding/events", { name: `Ceremony ${tag}` });
    const errors = watchErrors(page);
    const file = { name: `guestlist-${tag}.csv`, mimeType: "text/csv", buffer: Buffer.from(sayIDoCsv(tag)) };

    await page.goto("/portal/wedding/guests");
    await page.getByRole("link", { name: "Import" }).first().click();
    await expect(page.getByRole("heading", { level: 1, name: "Import guests" })).toBeVisible();
    await page.locator("input[type=file]").setInputFiles(file);

    await expect(page.getByText(`guestlist-${tag}.csv · Say I Do guest list`)).toBeVisible();
    const households = page.getByTestId("import-household");
    await expect(households.filter({ hasText: `Drew & Emery Fictional${tag}` })).toBeVisible();
    await noOverflow(page, "import review");

    // Lower-case surname: flagged, then fixed in bulk.
    const hayden = page.getByTestId("import-guest-5");
    await expect(hayden.getByText("Check the capitalisation.", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: /Fix capitalisation/ }).click();
    await expect(hayden.getByLabel("Last name")).toHaveValue(`Smith${tag}`);

    // Two different addresses in one party: choose the street address.
    const drew = households.filter({ hasText: `Drew & Emery Fictional${tag}` });
    await expect(drew.getByText("Guests in this party gave different addresses.")).toBeVisible();
    await drew.getByText("7 Banksia Road Otherplace NSW 2003", { exact: true }).click();
    await expect(drew.getByRole("radio", { name: /7 Banksia Road/ })).toBeChecked();

    // Only the explicit "Yes" is an RSVP; the empty Attending cells are not.
    await expect(page.getByTestId("import-guest-7").getByText("Said yes")).toBeVisible();
    await expect(page.getByTestId("import-guest-8").getByText("No RSVP yet")).toBeVisible();

    await expect(page.getByRole("button", { name: "Import 6 guests" })).toBeEnabled();
    await page.getByRole("button", { name: "Import 6 guests" }).click();
    await expect(page.getByText(`Imported “guestlist-${tag}.csv”`)).toBeVisible();
    await expect(page.getByRole("link", { name: "Download report (CSV)" })).toBeVisible();
    await expect(page.getByRole("rowheader", { name: `Hayden Smith${tag}` })).toBeVisible();

    // The same file again: matched, nothing to do, nothing duplicated.
    await page.getByRole("button", { name: "Import another file" }).click();
    await page.locator("input[type=file]").setInputFiles(file);
    await expect(page.getByText("This exact file was imported before")).toBeVisible();
    await expect(page.getByRole("button", { name: "Everything is up to date" })).toBeDisabled();

    const { guests } = await api(request, "get", "/api/portal/wedding/guests");
    expect(guests.filter((g: { lastName: string; firstName: string }) => `${g.firstName}${g.lastName}`.includes(tag))).toHaveLength(6);
    expect(errors).toEqual([]);
});

test("a household opens its invitation link, replies in part, then finishes; the dashboard tracks it", async ({ page, request, isMobile }, info) => {
    const tag = runTag(info.project.name);
    const event = (await api(request, "post", "/api/portal/wedding/events", { name: `Reception ${tag}`, startsAt: "2027-10-23T17:00" })).item;
    const household = (await api(request, "post", "/api/portal/wedding/households", { name: `The Partial Family ${tag}` })).item;
    for (const [firstName, lastName] of [
        ["Alex", `Partial-${tag}`],
        ["Sam", `Partial-${tag}`],
        ["Jo", `O'Partial ${tag}`],
    ])
        await api(request, "post", "/api/portal/wedding/guests", { firstName, lastName, householdId: household.id, events: [event.id] });
    const issued = (await api(request, "post", `/api/portal/wedding/households/${household.id}/invitation`, { action: "restore" })).household;
    await api(request, "put", "/api/portal/flags/wedding.site.public", { enabled: true });
    await api(request, "put", "/api/portal/flags/rsvp.native", { enabled: true });
    const errors = watchErrors(page);

    try {
        await page.goto(`/wedding/rsvp${new URL(issued.invitationUrl).search}`);
        await expect(page.getByRole("heading", { name: "Who's coming?" })).toBeVisible();
        // Everyone named on the invitation, by full name.
        for (const name of [`Alex Partial-${tag}`, `Sam Partial-${tag}`, `Jo O'Partial ${tag}`])
            await expect(page.getByRole("heading", { name })).toBeVisible();
        await noOverflow(page, "attendance");

        const person = (name: string) => page.getByRole("listitem").filter({ has: page.getByRole("heading", { name }) });
        // Tap the visible label (as a guest would) and check it took.
        const choose = async (name: string, choice: "accept" | "decline") => {
            const label = choice === "accept" ? (isMobile ? "Accepts" : "Joyfully accepts") : isMobile ? "Declines" : "Regretfully declines";
            await person(name).getByText(label, { exact: true }).click();
            await expect(person(name).getByRole("radio", { name: label })).toBeChecked();
        };
        await choose(`Alex Partial-${tag}`, "accept");
        await choose(`Sam Partial-${tag}`, "decline");
        await page.getByRole("button", { name: "Continue" }).click();
        await expect(page.getByText("We still need an answer for Jo.")).toBeVisible();
        await page.getByRole("button", { name: "Reply now and answer for Jo later" }).click();
        // Details, then the optional transport step: skipped entirely this time.
        await page.getByRole("button", { name: "Continue" }).click();
        await expect(page.getByRole("heading", { name: "Getting there and staying" })).toBeVisible();
        await noOverflow(page, "travel");
        await page.getByRole("button", { name: "Review my RSVP" }).click();

        const summary = page.getByRole("region", { name: "Household summary" });
        await expect(summary.getByRole("listitem").filter({ hasText: "Coming" })).toContainText("1");
        await expect(summary.getByRole("listitem").filter({ hasText: "Can't make it" })).toContainText("1");
        await expect(summary.getByRole("listitem").filter({ hasText: "Not answered" })).toContainText("1");
        await noOverflow(page, "review");
        await page.getByRole("button", { name: "Send our RSVP" }).click();
        await expect(page.getByRole("heading", { name: "Thank you" })).toBeVisible();
        await expect(page.getByText("We still need an answer for Jo.")).toBeVisible();

        let rows = (await api(request, "get", "/api/portal/wedding/households/overview")).households;
        expect(rows.find((h: { id: string }) => h.id === household.id).response).toMatchObject({ status: "partial", answered: 2, invited: 3 });

        // Back with the same link to finish.
        await page.getByRole("button", { name: "Finish our RSVP" }).click();
        await choose(`Jo O'Partial ${tag}`, "accept");
        await page.getByRole("button", { name: "Continue" }).click();
        await page.getByRole("button", { name: "Continue" }).click();
        // Two of the family are coming: both can go home on the bus, only one needs it there.
        await page.getByText("Yes — both ways", { exact: true }).click();
        const outbound = page.getByRole("textbox", { name: "How many of you need the bus to the wedding?" });
        await expect(outbound).toHaveValue("2");
        await page.getByRole("button", { name: /^Decrease/ }).first().click();
        await expect(outbound).toHaveValue("1");
        await expect(page.getByRole("button", { name: /^Decrease/ }).first()).toBeDisabled();
        await expect(page.getByRole("textbox", { name: "How many of you need the bus home after the reception?" })).toHaveValue("2");
        await noOverflow(page, "travel counts");
        await page.getByRole("button", { name: "Review my RSVP" }).click();
        await expect(page.getByText("1 passenger to the wedding, 2 passengers home")).toBeVisible();
        await page.getByRole("button", { name: "Send our RSVP" }).click();
        await expect(page.getByText(`celebrate with Alex and Jo`)).toBeVisible();
        rows = (await api(request, "get", "/api/portal/wedding/households/overview")).households;
        expect(rows.find((h: { id: string }) => h.id === household.id).response.status).toBe("complete");
        const transport = await api(request, "get", "/api/portal/wedding/travel");
        expect(transport.households.find((h: { householdId: string }) => h.householdId === household.id)).toMatchObject({
            attending: 2,
            outbound: 1,
            return: 2,
            travel: { bus: "both" },
        });
        expect(errors).toEqual([]);

        // The dashboard: completion next to attendance, a copyable link, and generation without sending.
        await page.goto("/portal/wedding/households");
        await page.getByRole("searchbox", { name: "Search households or guests" }).fill(`The Partial Family ${tag}`);
        const row = page.getByRole("row", { name: new RegExp(`The Partial Family ${tag}`) });
        await expect(row.getByText("Complete", { exact: true })).toBeVisible();
        await expect(row.getByRole("button", { name: `Copy invitation link for The Partial Family ${tag}` })).toBeVisible();
        await row.getByRole("checkbox").check({ force: true });
        await expect(row.getByRole("checkbox")).toBeChecked();
        await page.getByRole("button", { name: "Generate invitations" }).click();
        await expect(page.getByText("Invitations ready for 1 household")).toBeVisible();
        await expect(row.getByText("Ready")).toBeVisible();
        // Sending stays off until it's approved; nothing was sent.
        await expect(page.getByText("Sending is switched off until it's approved.", { exact: false })).toBeVisible();
        await noOverflow(page, "households");
    } finally {
        await api(request, "put", "/api/portal/flags/rsvp.native", { enabled: false });
        await api(request, "put", "/api/portal/flags/wedding.site.public", { enabled: false });
    }
});
