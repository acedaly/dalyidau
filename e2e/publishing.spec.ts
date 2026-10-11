import { expect, test } from "@playwright/test";
import { mock, sync } from "./helpers";

const TRAINING_ID = "50000000-0000-4000-8000-000000000002";
const DRAFT_ID = "50000000-0000-4000-8000-000000000004";

test.describe.configure({ mode: "serial" });
test.skip(({ isMobile }) => isMobile, "state-changing tests run once");

test.afterAll(async () => {
    await mock("reset");
    await sync();
});

test("a draft becomes visible once it is marked Published, and disappears when unpublished", async ({ page }) => {
    expect((await page.goto("/blog/secret-draft"))?.status()).toBe(404);

    await mock("setStatus", DRAFT_ID, "Published");
    await sync();
    expect((await page.goto("/blog/secret-draft"))?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("A draft that must stay private");

    await mock("setStatus", DRAFT_ID, "Draft");
    await sync();
    expect((await page.goto("/blog/secret-draft"))?.status()).toBe(404);
});

test("edits appear after the next sync", async ({ page }) => {
    await mock("appendParagraph", TRAINING_ID, "Edited in Capacities just now.");
    await sync();
    await page.goto("/blog/running-a-good-training-session");
    await expect(page.getByText("Edited in Capacities just now.")).toBeVisible();
});

test("an outage keeps the site up with the last good content", async ({ page }) => {
    await mock("fail", "all");
    const result = await sync().catch((error: Error) => error);
    expect(String(result)).toMatch(/502/);
    expect((await page.goto("/blog/running-a-good-training-session"))?.status()).toBe(200);
    await mock("recover");
});
