import AxeBuilder from "@axe-core/playwright";
import { type APIRequestContext, type Page, expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

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

const spaceTypes = async (request: APIRequestContext, spaceId: string) => {
    const response = await request.get(`/api/portal/knowledge/spaces/${spaceId}/types`);
    expect(response.ok(), await response.text()).toBe(true);
    return ((await response.json()) as { types: { id: string; name: string }[] }).types;
};

test("every Knowledge page loads without errors, fits the screen and passes axe", async ({ page, request }, info) => {
    const errors = watchErrors(page);
    const spaceId = await personalSpace(request);
    const object = await createObject(request, spaceId, { title: `Layout check ${info.project.name}`, tags: ["layout"] });
    for (const path of [
        "/portal",
        "/portal/knowledge",
        "/portal/knowledge/daily",
        "/portal/knowledge/inbox",
        "/portal/knowledge/all",
        "/portal/knowledge/favourites",
        "/portal/knowledge/collections",
        "/portal/knowledge/templates",
        "/portal/knowledge/discover",
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

test("writes one daily note, navigates between days and keeps the content", async ({ page, request }, info) => {
    const spaceId = await personalSpace(request);
    const date = info.project.name === "desktop" ? "2026-10-16" : "2026-10-15";
    const content = `Daily browser note ${info.project.name}`;

    await page.goto(`/portal/knowledge/daily/${date}`);
    const editor = page.locator(".ProseMirror");
    await expect(editor).toBeVisible();
    await editor.fill(content);
    await saved(page);

    const first = await request.get(`/api/portal/knowledge/spaces/${spaceId}/daily/${date}`);
    expect(first.ok()).toBe(true);
    const firstId = ((await first.json()) as { note: { object: { id: string } } }).note.object.id;

    await page.getByRole("link", { name: "Previous day" }).click();
    await expect(page).toHaveURL(new RegExp(`/daily/`));
    await page.getByRole("link", { name: "Next day" }).click();
    await expect(editor).toContainText(content);
    await page.reload();
    await expect(page.locator(".ProseMirror")).toContainText(content);

    const creates = await Promise.all(Array.from({ length: 3 }, () => request.post(`/api/portal/knowledge/spaces/${spaceId}/daily/${date}`, { headers: JSON_HEADERS })));
    expect(creates.every((response) => response.ok())).toBe(true);
    const ids = await Promise.all(creates.map(async (response) => ((await response.json()) as { object: { id: string } }).object.id));
    expect(new Set([firstId, ...ids]).size).toBe(1);
});

test("creates, renames, reorders and deletes a collection without deleting its notes", async ({ page, request }, info) => {
    const suffix = info.project.name;
    const spaceId = await personalSpace(request);
    const objects = await Promise.all(
        ["Venue", "Catering", "Music"].map((title) => createObject(request, spaceId, { title: `${title} collection ${suffix}` })),
    );
    const collectionName = `Launch collection ${suffix}`;

    await page.goto("/portal/knowledge/collections");
    await page.getByRole("button", { name: "New collection" }).first().click();
    const createDialog = page.getByRole("dialog", { name: "New collection" });
    await createDialog.getByLabel("Name").fill(collectionName);
    await createDialog.getByLabel("Description").fill("Fictional browser-test notes");
    await createDialog.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("heading", { name: collectionName, level: 1 })).toBeVisible();

    const picker = page.getByLabel("Add an object to this collection");
    const ordered = page.locator('ol[aria-label="Objects in this collection"]');
    for (const title of ["Venue", "Catering", "Music"].map((name) => `${name} collection ${suffix}`)) {
        await picker.fill(title);
        await page.getByRole("option", { name: new RegExp(title) }).click();
        await expect(ordered.locator("a").filter({ hasText: title })).toBeVisible();
    }

    await page.getByRole("button", { name: `Move Music collection ${suffix} up` }).click();
    await expect.poll(async () => ordered.getByRole("link").allTextContents()).toEqual([
        `Venue collection ${suffix}`,
        `Music collection ${suffix}`,
        `Catering collection ${suffix}`,
    ]);
    const cateringRow = ordered.getByRole("listitem").filter({ hasText: `Catering collection ${suffix}` });
    await cateringRow.getByRole("button", { name: "Pin to the top" }).click();
    await expect.poll(async () => ordered.getByRole("link").allTextContents()).toEqual([
        `Catering collection ${suffix}`,
        `Venue collection ${suffix}`,
        `Music collection ${suffix}`,
    ]);
    await page.getByRole("button", { name: `Remove Venue collection ${suffix} from this collection` }).click();
    await expect(page.getByRole("link", { name: `Venue collection ${suffix}` })).toBeHidden();

    await page.getByRole("button", { name: "Rename" }).click();
    const rename = page.getByRole("dialog", { name: "Rename collection" });
    await rename.getByLabel("Name").fill(`${collectionName} renamed`);
    await rename.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("heading", { name: `${collectionName} renamed`, level: 1 })).toBeVisible();

    await page.getByRole("button", { name: "Delete collection" }).click();
    await page.getByRole("dialog", { name: "Delete this collection?" }).getByRole("button", { name: "Delete collection" }).click();
    await expect(page).toHaveURL(/\/portal\/knowledge\/collections/);
    for (const object of objects) expect((await request.get(`/api/portal/knowledge/objects/${object.id}`)).ok()).toBe(true);
});

test("creates a template, makes an independent note from it and preserves the template", async ({ page, request }, info) => {
    const suffix = info.project.name;
    const spaceId = await personalSpace(request);
    const [type] = await spaceTypes(request, spaceId);
    expect(type).toBeTruthy();
    const templateName = `Meeting template ${suffix}`;
    const objectTitle = `Meeting from template ${suffix}`;

    await page.goto("/portal/knowledge/templates");
    await page.getByRole("button", { name: "New template" }).first().click();
    const createDialog = page.getByRole("dialog", { name: "New template" });
    await createDialog.getByLabel("Name").fill(templateName);
    await createDialog.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("heading", { name: templateName, level: 1 })).toBeVisible();
    const templateUrl = page.url();

    await page.getByLabel("Title of new objects").fill(objectTitle);
    await page.locator(".ProseMirror").fill("Purpose\n\nActions");
    const defaultToggle = page.getByRole("switch", { name: new RegExp("Default for") });
    if ((await defaultToggle.getAttribute("aria-checked")) !== "true") await defaultToggle.check({ force: true });
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Template saved")).toBeVisible();

    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByRole("menuitem", { name: new RegExp(templateName) }).click();
    await expect(page.getByLabel("Title")).toHaveValue(objectTitle);
    await expect(page.locator(".ProseMirror")).toContainText("Purpose");
    await page.locator(".ProseMirror").fill(`Changed note only ${suffix}`);
    await saved(page);

    await page.goto(templateUrl);
    await expect(page.locator(".ProseMirror")).toContainText("Purpose");
    await expect(page.locator(".ProseMirror")).not.toContainText(`Changed note only ${suffix}`);
});

test("keeps favourites and saved views, explains discovery and downloads portable exports", async ({ page, request }, info) => {
    const suffix = info.project.name;
    const spaceId = await personalSpace(request);
    const tag = `browser-${suffix}`;
    const favouriteTitle = `Favourite export ${suffix}`;
    const relatedTitle = `Related export ${suffix}`;
    const favourite = await createObject(request, spaceId, { title: favouriteTitle, tags: [tag] });
    await createObject(request, spaceId, { title: relatedTitle, tags: [tag] });
    await createObject(request, spaceId, { title: `Outside saved view ${suffix}`, tags: [`other-${suffix}`] });

    await page.goto(`/portal/knowledge/o/${favourite.id}`);
    await page.getByRole("button", { name: "Add to favourites" }).click();
    await expect(page.getByText("Added to your favourites")).toBeVisible();
    await page.goto("/portal/knowledge/favourites");
    await expect(page.getByRole("main").locator("a").filter({ hasText: favouriteTitle }).first()).toBeVisible();

    await page.goto(`/portal/knowledge/all?tag=${encodeURIComponent(tag)}`);
    await expect(page.getByRole("main").locator("a").filter({ hasText: favouriteTitle }).first()).toBeVisible();
    await expect(page.getByRole("main").locator("a").filter({ hasText: `Outside saved view ${suffix}` })).toBeHidden();
    await page.getByRole("button", { name: "Save view" }).click();
    const saveDialog = page.getByRole("dialog", { name: "Save this view" });
    const viewName = `Browser view ${suffix}`;
    await saveDialog.getByLabel("Name").fill(viewName);
    await Promise.all([page.waitForNavigation(), saveDialog.getByRole("button", { name: "Save view" }).click()]);
    await expect(page).toHaveURL(/\?saved=kvw_/);
    await expect(page.getByRole("heading", { name: viewName, level: 1 })).toBeVisible();
    const savedUrl = page.url();
    await page.goto("/portal/knowledge");
    await page.goto(savedUrl);
    await expect(page.getByRole("main").locator("a").filter({ hasText: favouriteTitle }).first()).toBeVisible();
    await expect(page.getByRole("main").locator("a").filter({ hasText: `Outside saved view ${suffix}` })).toBeHidden();

    await page.getByRole("button", { name: "Rename view" }).click();
    const renameDialog = page.getByRole("dialog", { name: "Rename saved view" });
    const renamed = `${viewName} renamed`;
    await renameDialog.getByLabel("Name").fill(renamed);
    await Promise.all([page.waitForNavigation(), renameDialog.getByRole("button", { name: "Save" }).click()]);
    await expect(page.getByRole("heading", { name: renamed, level: 1 })).toBeVisible();

    await page.goto("/portal/knowledge/discover");
    const orphanRow = page.getByRole("main").getByRole("listitem").filter({ has: page.locator("a").filter({ hasText: favouriteTitle }) }).first();
    await orphanRow.getByRole("button", { name: "Suggest links" }).click();
    await expect(orphanRow.getByRole("link", { name: relatedTitle })).toBeVisible();
    await expect(orphanRow.getByText(new RegExp(`Shares the tag ${tag}|Shares 1 tag`))).toBeVisible();

    await page.goto(`/portal/knowledge/o/${favourite.id}`);
    await page.getByRole("button", { name: "More actions" }).click();
    const markdownPromise = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: "Export as Markdown" }).click();
    const markdown = await markdownPromise;
    expect((await readFile((await markdown.path())!, "utf8"))).toContain(`# ${favouriteTitle}`);

    await page.goto("/portal/knowledge/settings");
    const jsonPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download JSON" }).click();
    const jsonDownload = await jsonPromise;
    const manifest = JSON.parse(await readFile((await jsonDownload.path())!, "utf8")) as { format: string; objects: { title: string }[] };
    expect(manifest.format).toBe("daly.knowledge.export.v1");
    expect(manifest.objects.some((object) => object.title === favouriteTitle)).toBe(true);

    const zipPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download ZIP" }).click();
    const zipDownload = await zipPromise;
    const zip = await readFile((await zipDownload.path())!);
    expect(zip.subarray(0, 4).toString("hex")).toBe("504b0304");
});
