import AxeBuilder from "@axe-core/playwright";
import { type APIRequestContext, type Page, expect, test } from "@playwright/test";

// Daly Knowledge in a real browser. The e2e Worker acts as an owner on localhost (see
// portal.spec.ts). Both projects share one database, so every title includes the project name.

const JSON_HEADERS = { Origin: "http://localhost:8787", "Content-Type": "application/json" };

const watchErrors = (page: Page) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && !m.text().includes("Failed to load resource") && errors.push(m.text()));
    return errors;
};

const personalSpace = async (request: APIRequestContext) => {
    const response = await request.get("/api/portal/knowledge/spaces");
    expect(response.ok()).toBe(true);
    const { spaces } = (await response.json()) as { spaces: { id: string; kind: string }[] };
    return spaces.find((s) => s.kind === "personal")!.id;
};

const createObject = async (request: APIRequestContext, spaceId: string, data: Record<string, unknown>) => {
    const response = await request.post(`/api/portal/knowledge/spaces/${spaceId}/objects`, { headers: JSON_HEADERS, data });
    expect(response.ok(), await response.text()).toBe(true);
    return ((await response.json()) as { object: { id: string; version: number } }).object;
};

/** The editor saves after a pause; wait until the badge says so. */
const saved = (page: Page) => expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 10_000 });

test("every Knowledge page loads without errors, fits the screen and passes axe", async ({ page, request }, info) => {
    const errors = watchErrors(page);
    const spaceId = await personalSpace(request);
    const object = await createObject(request, spaceId, { title: `Layout check ${info.project.name}`, tags: ["layout"] });
    for (const path of [
        "/portal",
        "/portal/knowledge",
        "/portal/knowledge/inbox",
        "/portal/knowledge/all",
        "/portal/knowledge/search?q=layout",
        "/portal/knowledge/types",
        "/portal/knowledge/archive",
        "/portal/knowledge/trash",
        "/portal/knowledge/settings",
        `/portal/knowledge/o/${object.id}`,
    ]) {
        await page.goto(path);
        await expect(page.getByRole("main")).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, path).toBeLessThanOrEqual(0);
        // The non-production environment banner is excluded: it never appears in production.
        const results = await new AxeBuilder({ page }).include("main").exclude("main p.bg-warning-primary").analyze();
        const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
        expect(serious.map((v) => `${path} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    }
    expect(errors).toEqual([]);
});

test("captures to the Inbox, writes with links and finds it again", async ({ page, request }, info) => {
    const errors = watchErrors(page);
    const suffix = info.project.name;
    const spaceId = await personalSpace(request);
    const target = await createObject(request, spaceId, { title: `Quokka project ${suffix}` });

    // Capture without deciding where it goes.
    await page.goto("/portal/knowledge");
    await page.getByLabel("Capture a thought, link or note").fill(`Idea from the train ${suffix}\nSomething to think about`);
    await page.getByLabel("Capture a thought, link or note").press("Enter");
    await expect(page.getByText("Captured to the Inbox")).toBeVisible();

    await page.goto("/portal/knowledge/inbox");
    await page.getByRole("link", { name: `Idea from the train ${suffix}` }).click();
    await expect(page.getByLabel("Title")).toHaveValue(`Idea from the train ${suffix}`);

    // Write in the editor: a heading from the / menu, then a [[ link.
    const editor = page.locator(".ProseMirror");
    // Caret to the end of the text through the DOM selection, which ProseMirror follows; key
    // shortcuts for "end of document" differ between platforms.
    await editor.getByText("Something to think about").click();
    await editor.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element.querySelector("p:last-of-type")!);
        range.collapse(false);
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(range);
    });
    await page.keyboard.press("Enter");
    await page.keyboard.type("/head");
    await expect(page.getByRole("listbox", { name: "Insert" })).toBeVisible();
    await page.keyboard.press("Enter");
    await page.keyboard.type("Next steps");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Talk to [[Quokka");
    await expect(page.getByRole("option", { name: new RegExp(`Quokka project ${suffix}`) })).toBeVisible();
    await page.keyboard.press("Enter");
    await page.keyboard.type("about it.");
    await expect(editor.locator("h1, h2")).toContainText("Next steps");
    await expect(editor.locator("a[data-object-link]")).toHaveText(`Quokka project ${suffix}`);
    await saved(page);

    // It's mine now: done processing takes it out of the Inbox.
    await page.getByRole("button", { name: "Done processing" }).click();
    await saved(page);

    // Everything survived a reload, and the link shows up as a backlink on the other side.
    await page.reload();
    await expect(page.locator(".ProseMirror")).toContainText("about it.");
    await page.locator("a[data-object-link]").click();
    await expect(page).toHaveURL(new RegExp(`/portal/knowledge/o/${target.id}$`));
    const backlinks = page.getByRole("complementary", { name: "Details" }).locator("section", { has: page.getByRole("heading", { name: /^Backlinks/ }) });
    await expect(backlinks.getByRole("link", { name: `Idea from the train ${suffix}` })).toBeVisible();

    // Search finds it by a word in the text, highlighted, and the keyboard can open it.
    await page.goto(`/portal/knowledge/search?q=${encodeURIComponent(`think ${suffix}`)}`);
    await expect(page.locator("mark").first()).toBeVisible();
    await page.getByLabel("Search", { exact: true }).focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Title")).toHaveValue(`Idea from the train ${suffix}`);
    expect(errors).toEqual([]);
});

test("never overwrites a newer save, and recovers from the trash", async ({ page, request }, info) => {
    const spaceId = await personalSpace(request);
    const object = await createObject(request, spaceId, { title: `Shared agenda ${info.project.name}` });
    await page.goto(`/portal/knowledge/o/${object.id}`);
    await expect(page.locator(".ProseMirror")).toBeVisible();

    // Someone else saves first (here, the API in another "tab").
    const other = await request.patch(`/api/portal/knowledge/objects/${object.id}`, {
        headers: JSON_HEADERS,
        data: { version: object.version, title: "Changed elsewhere" },
    });
    expect(other.ok()).toBe(true);

    await page.getByLabel("Title").fill(`Shared agenda ${info.project.name} (mine)`);
    await expect(page.getByText("Someone else saved a newer version")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "Keep my changes" }).click();
    await saved(page);
    await page.reload();
    await expect(page.getByLabel("Title")).toHaveValue(`Shared agenda ${info.project.name} (mine)`);

    // Their version is in the history.
    await page.getByRole("button", { name: "History" }).click();
    const history = page.getByRole("dialog", { name: "Version history" });
    await expect(history.getByRole("list", { name: "Versions" }).getByRole("listitem")).toHaveCount(3);
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Move to trash" }).click();
    await expect(page.getByText("This is in the trash")).toBeVisible();
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(page.getByText("This is in the trash")).toBeHidden();
});
