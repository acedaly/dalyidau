import AxeBuilder from "@axe-core/playwright";
import { type APIRequestContext, type Page, expect, test } from "@playwright/test";
import { NAB_FILE_A, NAB_FILE_B } from "../fixtures/finance/fixtures";

// Household Finance (Milestone 11.1) in a real browser, desktop and Pixel 7: importing a NAB export
// through the review screen, the same file again being recognised as already imported, the balance
// matching the bank, categorising one transaction and then the others from the same merchant, and
// every page fitting the screen and passing axe. Both projects share one database, so each makes
// its own account (named for the project). All data is invented (fixtures/finance/fixtures.ts).

const BASE = "http://localhost:8787";
const JSON_HEADERS = { Origin: BASE, "Content-Type": "application/json" };
const F = `${BASE}/api/portal/finance`;

const send = async (request: APIRequestContext, method: "post" | "patch", path: string, data: unknown) => {
    const response = await request[method](path, { headers: JSON_HEADERS, data });
    expect(response.ok(), `${path}: ${await response.text()}`).toBe(true);
    return response.json();
};
const watchErrors = (page: Page) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && !m.text().includes("Failed to load resource") && errors.push(m.text()));
    return errors;
};
const fits = async (page: Page, label: string) => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${label}: horizontal scroll`).toBeLessThanOrEqual(0);
    const results = await new AxeBuilder({ page }).include("main").exclude("main p.bg-warning-primary").analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious.map((v) => `${label} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
};

async function newAccount(request: APIRequestContext, name: string) {
    const { account } = await send(request, "post", `${F}/accounts`, {
        name,
        institution: "NAB",
        kind: "transaction",
        numberHint: "4321",
        openingBalanceCents: 250000,
        openingBalanceOn: "2026-09-01",
        visibility: "shared",
    });
    return account.id as string;
}

/** Stages and commits a file through the API (for setting up, not the journey under test). */
async function importByApi(request: APIRequestContext, accountId: string, text: string) {
    const { inspection } = await send(request, "post", `${F}/imports/inspect`, { accountId, text });
    const { detail } = await send(request, "post", `${F}/imports`, { accountId, filename: "setup.csv", text, mapping: inspection.mapping });
    await send(request, "post", `${F}/imports/${detail.summary.id}/commit`, { version: detail.summary.version });
}

const upload = async (page: Page, name: string, text: string) =>
    page.locator('input[type="file"]').setInputFiles({ name, mimeType: "text/csv", buffer: Buffer.from(text, "utf8") });

test("import a NAB export: review, commit, recognise it again, and the balance matches the bank", async ({ page, request }, info) => {
    const errors = watchErrors(page);
    const accountId = await newAccount(request, `Everyday (${info.project.name})`);

    await page.goto(`/portal/finance/import?account=${accountId}`);
    await expect(page.getByRole("heading", { level: 1, name: "Import transactions" })).toBeVisible();
    await fits(page, "import");
    await upload(page, "nab-september.csv", NAB_FILE_A);
    await expect(page.getByRole("heading", { name: "Recognised as NAB" })).toBeVisible();
    await fits(page, "import with preview");
    await page.getByRole("button", { name: "Review the rows" }).click();

    await expect(page).toHaveURL(/\/portal\/finance\/import\/fim_[a-z0-9]{14}$/);
    await expect(page.getByRole("heading", { level: 1, name: "Review import" })).toBeVisible();
    await fits(page, "review");
    await page.screenshot({ path: `test-results/finance-review-${info.project.name}.png`, fullPage: true });
    await page.getByRole("button", { name: "Import 8 transactions" }).click();
    await expect(page.getByText("Imported 8 transactions").first()).toBeVisible();

    // The same file again: everything is already there.
    await page.goto(`/portal/finance/import?account=${accountId}`);
    await upload(page, "nab-september.csv", NAB_FILE_A);
    await expect(page.getByText("This file was imported before")).toBeVisible();
    await page.getByRole("button", { name: "Review the rows" }).click();
    await expect(page.getByRole("button", { name: "Import 0 transactions" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel import" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel import" }).click();
    await expect(page).toHaveURL(/\/portal\/finance\/import$/);

    await page.goto(`/portal/finance/accounts/${accountId}`);
    await expect(page.getByText("$4,954.16").first()).toBeVisible();
    await expect(page.getByText("Matches the bank").first()).toBeVisible();
    await fits(page, "account");
    expect(errors).toEqual([]);
});

test("categorise one transaction, then the others from the same merchant", async ({ page, request }, info) => {
    const accountId = await newAccount(request, `Joint (${info.project.name})`);
    await importByApi(request, accountId, NAB_FILE_A);
    await importByApi(request, accountId, NAB_FILE_B);

    await page.goto(`/portal/finance/transactions?account=${accountId}&from=2026-09-01&to=2026-09-30`);
    await expect(page.getByRole("heading", { level: 1, name: "Transactions" })).toBeVisible();
    await fits(page, "transactions");
    await page.getByRole("button", { name: /Category for Woolworths on 18 Sept/ }).click();
    await page.getByRole("listbox").getByRole("option", { name: "Food & drink · Groceries" }).click();
    // The other uncategorised Woolworths transactions the owner can see (other tests' accounts share this database).
    await expect(page.getByText(/^Categorise \d+ more from Woolworths\?$/)).toBeVisible();
    await page.getByRole("button", { name: /^Categorise \d+ as Groceries$/ }).click();
    await expect(page.getByText(/^Categorised \d+ more as Groceries$/)).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: /Category for Woolworths on 2 Sept/ })).toContainText("Groceries");

    // Two likely transfers are offered (savings and card are in other projects' data, so just check the section renders).
    await expect(page.locator("#transfers")).toBeVisible();
});

test("every Household Finance page loads, fits the screen and passes axe", async ({ page, request }, info) => {
    const errors = watchErrors(page);
    const accountId = await newAccount(request, `Pages (${info.project.name})`);
    await importByApi(request, accountId, NAB_FILE_A);
    const { inspection } = await send(request, "post", `${F}/imports/inspect`, { accountId, text: NAB_FILE_B });
    const { detail } = await send(request, "post", `${F}/imports`, { accountId, filename: "october.csv", text: NAB_FILE_B, mapping: inspection.mapping });

    await page.goto("/portal");
    await page.locator('[data-application="finance"]').click();
    await expect(page).toHaveURL(/\/portal\/finance$/);
    for (const path of [
        "/portal/finance",
        "/portal/finance?from=2026-09-01&to=2026-09-30",
        "/portal/finance/transactions?from=2026-09-01&to=2026-09-30",
        "/portal/finance/accounts",
        `/portal/finance/accounts/${accountId}`,
        "/portal/finance/import",
        `/portal/finance/import/${detail.summary.id}`,
        "/portal/finance/settings",
    ]) {
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
        await fits(page, path);
    }
    await page.goto("/portal/finance?from=2026-09-01&to=2026-09-30");
    await page.screenshot({ path: `test-results/finance-overview-${info.project.name}.png`, fullPage: true });
    // The review screen lists rows it couldn't read, with the reason.
    await page.goto(`/portal/finance/import/${detail.summary.id}`);
    await page.getByRole("tab", { name: /Can't be read/ }).click();
    await expect(page.getByText("The amount is zero")).toBeVisible();
    expect(errors).toEqual([]);
});
