import { type APIRequestContext, type Page, expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

// The one-household UAT journey in a real browser: Invitation Studio → generate → its pending
// Communications draft → the exact email and send check listing one address. Nothing can be sent
// (the e2e Worker has no email provider). With CAPTURE=1 it also saves design previews and
// screenshots (fictional names only) to docs/design/assets/communications-studio/.

const JSON_HEADERS = { Origin: "http://localhost:8787", "Content-Type": "application/json" };
const CAPTURE = !!process.env.CAPTURE;
const ASSETS = "docs/design/assets/communications-studio";

const api = async <T>(request: APIRequestContext, method: "post" | "put" | "patch" | "get", path: string, data?: unknown): Promise<T> => {
    const response = await request[method](path, { headers: JSON_HEADERS, ...(data === undefined ? {} : { data }) });
    expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
    return response.json() as Promise<T>;
};

const watchErrors = (page: Page) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // Email previews render in a fully sandboxed iframe; Playwright's own frame scripts are blocked there.
    page.on(
        "console",
        (m) =>
            m.type() === "error" &&
            !m.text().includes("Failed to load resource") &&
            !m.text().includes("Blocked script execution in 'about:srcdoc'") &&
            errors.push(m.text()),
    );
    return errors;
};

const shot = async (page: Page, name: string) => {
    if (!CAPTURE) return;
    mkdirSync(ASSETS, { recursive: true });
    await page.screenshot({ path: `${ASSETS}/${name}.jpg`, fullPage: true, type: "jpeg", quality: 72 });
};

test("a single household goes from Invitation Studio to a reviewable draft addressed to them alone", async ({ page, request }, info) => {
    const errors = watchErrors(page);
    const suffix = info.project.name;
    const event = await api<{ item: { id: string } }>(request, "post", "/api/portal/wedding/events", {
        name: `Ceremony ${suffix}`,
        startsAt: "2027-10-23T14:00",
    });
    const home = await api<{ item: { id: string } }>(request, "post", "/api/portal/wedding/households", { name: `The Example Household ${suffix}` });
    const other = await api<{ item: { id: string } }>(request, "post", "/api/portal/wedding/households", { name: `The Sample Family ${suffix}` });
    for (const [firstName, email, householdId] of [
        ["Fred", `fred.${suffix}@example.com`, home.item.id],
        ["Ann", null, home.item.id],
        ["Sam", `sam.${suffix}@example.com`, other.item.id],
    ] as const)
        await api(request, "post", "/api/portal/wedding/guests", {
            firstName,
            lastName: firstName === "Sam" ? "Sample" : `Example-${suffix}`,
            email,
            householdId,
            events: [event.item.id],
        });

    await page.goto("/portal/wedding/invitations");
    await page.getByRole("checkbox", { name: `The Example Household ${suffix}` }).check({ force: true });
    await page.getByRole("checkbox", { name: "Email", exact: true }).check({ force: true });
    await page.getByRole("button", { name: "Preview every version" }).click();
    await page.getByRole("button", { name: "Email", exact: true }).click();
    const email = page.frameLocator('iframe[title^="Email to"]').first();
    await expect(email.getByText("View Invitation & RSVP")).toBeVisible();
    await expect(email.getByText("WITH PLEASURE, FOR")).toBeVisible();
    // Not captured: this view shows a real signed link (repository files never contain one).

    await page.getByRole("button", { name: "Generate (do not send)" }).click();
    const review = page.getByRole("link", { name: "Review and send" }).first();
    await expect(review).toBeVisible();
    await review.click();
    await expect(page).toHaveURL(/\/portal\/wedding\/communications\/msg_/);
    await expect(page.getByRole("heading", { name: "Send check" })).toBeVisible();
    const sendingTo = page.getByText(`fred.${suffix}@example.com`);
    await expect(sendingTo.first()).toBeVisible();
    await expect(page.getByText(`sam.${suffix}@example.com`)).toHaveCount(0);
    await expect(page.getByText("Email delivery is off", { exact: true })).toBeVisible();
    await shot(page, `message-send-check-${suffix}`);

    await page.goto("/portal/wedding/communications");
    await expect(page.getByRole("heading", { name: "Communications Studio" })).toBeVisible();
    await shot(page, `communications-studio-${suffix}`);
    await page.getByRole("button", { name: "Create" }).first().click();
    await expect(page.getByRole("radio", { name: "Specific people" })).toBeChecked();
    await expect(page.getByText("Choose at least one household or guest.")).toBeVisible();
    // Choose the one household, then capture the panel once its slide-in has finished.
    await page.getByRole("button", { name: "Search households" }).click();
    await page.getByRole("option", { name: new RegExp(`Fred & Ann Example-${suffix}`) }).click();
    await expect(page.getByText(/^1 household selected/)).toBeVisible();
    await page.getByRole("heading", { name: "1. Recipients" }).click({ force: true });
    await expect(page.getByText(`fred.${suffix}@example.com`)).toBeVisible();
    await page.waitForTimeout(400);
    if (CAPTURE) await page.screenshot({ path: `${ASSETS}/compose-specific-${suffix}.jpg`, type: "jpeg", quality: 72 });

    await page.goto("/portal/wedding");
    await expect(page.getByRole("heading", { name: "Contact details" })).toBeVisible();
    await shot(page, `dashboard-${suffix}`);
    expect(errors).toEqual([]);

    if (CAPTURE && suffix === "desktop") {
        // The exact emails and printable output, rendered from the same endpoints the portal uses.
        const preview = async (category: string, body: string, subject: string, householdId: string | null) =>
            api<{ html: string }>(request, "post", "/api/portal/wedding/messages/preview", { category, channel: "email", subject, body, householdId });
        // Signed links are replaced before anything is saved: samples never carry a real token.
        const sanitise = (html: string) => html.replace(/invite=[A-Za-z0-9._~-]+/g, "invite=SAMPLE-LINK-NOT-VALID");
        const write = async (name: string, html: string, width: number) => {
            await page.setViewportSize({ width, height: 900 });
            await page.setContent(sanitise(html).replaceAll("https://wedding.daly.id.au", "http://localhost:8787"));
            await page.waitForLoadState("networkidle");
            await page.screenshot({ path: `${ASSETS}/${name}.jpg`, fullPage: true, type: "jpeg", quality: 80 });
        };
        const invitation = await preview(
            "invitation",
            "Dear {{greeting_names}},\n\nWe would love you to join us as we celebrate our wedding.\n\n{{invitation_card}}\n\nWith love,\n{{couple_names}}",
            "You're invited to {{couple_names}}'s wedding",
            home.item.id,
        );
        await write("email-invitation-desktop", invitation.html, 720);
        await write("email-invitation-mobile", invitation.html, 390);
        writeFileSync(`${ASSETS}/email-invitation.html`, sanitise(invitation.html));
        const std = await preview(
            "save_the_date",
            "Dear {{greeting_names}},\n\nWe're getting married, and we'd love you to save the date.\n\n{{couple_names}}\n{{wedding_date}}\n{{venue}}\n\nA formal invitation will follow. In the meantime, you'll find everything at {{website_link}}.\n\nWith love,\n{{couple_names}}",
            "Save the date",
            home.item.id,
        );
        await write("email-save-the-date-desktop", std.html, 720);
        const thanks = await preview(
            "thank_you",
            "Dear {{greeting_names}},\n\n{{thank_you_message}}\n\n{{personal_note}}\n\nWith love,\n{{couple_names}}",
            "Thank you",
            home.item.id,
        );
        await write("email-thank-you-desktop", thanks.html, 720);
        for (const [name, path, data] of [
            ["save-the-date-sample.pdf", "/api/portal/wedding/studio/cards.pdf", { kind: "save_the_date", householdIds: [home.item.id], sample: true }],
            ["thank-you-sample.pdf", "/api/portal/wedding/studio/cards.pdf", { kind: "thank_you", householdIds: [home.item.id], sample: true }],
        ] as const) {
            const response = await request.post(path, { headers: JSON_HEADERS, data });
            expect(response.ok()).toBe(true);
            writeFileSync(`${ASSETS}/${name}`, await response.body());
        }
    }
});
