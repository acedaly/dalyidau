// Sample Capacities space used by the local mock API and the test suite.
// Shapes follow https://api.capacities.io/openapi.json (v1.0.0). Never deployed.

export const STRUCTURE_ID = "b1060000-0000-4000-8000-000000000001";
const STATUS_ID = "b1060000-0000-4000-8000-0000000000a1";
const SLUG_ID = "b1060000-0000-4000-8000-0000000000a2";
const SUBTITLE_ID = "b1060000-0000-4000-8000-0000000000a3";
const SUMMARY_ID = "b1060000-0000-4000-8000-0000000000a4";
const CATEGORY_ID = "b1060000-0000-4000-8000-0000000000a5";
const IMAGE_ID = "b1060000-0000-4000-8000-0000000000a6";
const PUBLISH_ID = "b1060000-0000-4000-8000-0000000000a7";
const UPDATED_ID = "b1060000-0000-4000-8000-0000000000a8";
const FEATURED_ID = "b1060000-0000-4000-8000-0000000000a9";
const CONTENT_ID = "b1060000-0000-4000-8000-0000000000aa";

export const IDS = {
    notebook: "50000000-0000-4000-8000-000000000001",
    training: "50000000-0000-4000-8000-000000000002",
    tools: "50000000-0000-4000-8000-000000000003",
    draft: "50000000-0000-4000-8000-000000000004",
    archived: "50000000-0000-4000-8000-000000000005",
    noStatus: "50000000-0000-4000-8000-000000000006",
    privatePerson: "60000000-0000-4000-8000-000000000001",
    privateNote: "60000000-0000-4000-8000-000000000002",
    tagSystems: "70000000-0000-4000-8000-000000000001",
    tagWriting: "70000000-0000-4000-8000-000000000002",
    tagCapacities: "70000000-0000-4000-8000-000000000003",
    tagLearning: "70000000-0000-4000-8000-000000000004",
    imgNotebook: "80000000-0000-4000-8000-000000000001",
    imgTraining: "80000000-0000-4000-8000-000000000002",
    imgTools: "80000000-0000-4000-8000-000000000003",
    imgInline: "80000000-0000-4000-8000-000000000004",
    video: "90000000-0000-4000-8000-000000000001",
    weblink: "90000000-0000-4000-8000-000000000002",
    table: "90000000-0000-4000-8000-000000000003",
};

const label = (id, name) => ({ id, name });
const STATUS = { draft: label("draft", "Draft"), published: label("published", "Published"), archived: label("archived", "Archived") };

export const structures = () => ({
    structures: [
        {
            id: STRUCTURE_ID,
            title: "Blog Post",
            pluralName: "Blog Posts",
            propertyDefinitions: [
                { id: "title", name: "", type: "title", writable: true },
                { id: STATUS_ID, name: "Status", type: "label", writable: true, multiple: false, labelSet: Object.values(STATUS) },
                { id: SLUG_ID, name: "Slug", type: "text", writable: true },
                { id: SUBTITLE_ID, name: "Subtitle", type: "text", writable: true },
                { id: SUMMARY_ID, name: "Summary", type: "text", writable: true },
                {
                    id: CATEGORY_ID,
                    name: "Category",
                    type: "label",
                    writable: true,
                    multiple: false,
                    labelSet: [label("systems", "Systems"), label("training", "Training"), label("notes", "Notes")],
                },
                { id: "tags", name: "Tags", type: "entity", writable: true },
                { id: IMAGE_ID, name: "Featured Image", type: "entity", writable: true },
                { id: PUBLISH_ID, name: "Publish Date", type: "date", writable: true },
                { id: UPDATED_ID, name: "Updated Date", type: "date", writable: true },
                { id: FEATURED_ID, name: "Featured", type: "boolean", writable: true },
                { id: "lastUpdated", name: "Last updated", type: "lastUpdatedAt", writable: false },
            ],
            collections: [],
        },
        {
            id: "RootPage",
            title: "Page",
            pluralName: "Pages",
            propertyDefinitions: [{ id: "title", name: "", type: "title", writable: true }],
            collections: [],
        },
    ],
});

// Block helpers
let n = 0;
const bid = () => `b10c0000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const t = (text, style = {}) => ({ type: "TextToken", text, style });
const b = (text) => t(text, { bold: true });
const i = (text) => t(text, { italic: true });
const link = (text, url) => ({ type: "LinkToken", text, url });
const ref = (text, entityId) => ({ type: "LinkToken", text, entityId });
const code = (text) => ({ type: "CodeToken", text });
const tokens = (parts) => parts.map((part) => (typeof part === "string" ? t(part) : part));
const block = (parts, extra = {}) => ({
    id: bid(),
    type: "TextBlock",
    tokens: tokens(parts),
    blocks: [],
    hierarchy: { key: "Base", val: 0 },
    list: null,
    toggle: null,
    ...extra,
});
const p = (...parts) => block(parts);
const h = (level, text) => block([text], { hierarchy: { key: `H${level}`, val: level } });
const li = (type, parts, children = []) => ({ ...block(Array.isArray(parts) ? parts : [parts], { list: { type } }), blocks: children });
const todo = (done, text) => block([text], { todo: { isDone: done } });
const quote = (layout, ...parts) => block(parts, { quote: { layout } });
const callout = (color, ...parts) => block(parts, { colorTheme: `bg-${color}` });
const codeBlock = (lang, text) => ({ id: bid(), type: "CodeBlock", lang, text });
const hr = () => ({ id: bid(), type: "HorizontalLineBlock" });
const embed = (entityId) => ({ id: bid(), type: "EntityBlock", entityId });
const toggle = (summary, children) => ({ ...block([summary], { toggle: { isOpen: false } }), blocks: children });
const grid = (...columns) => ({ id: bid(), type: "GridBlock", columns, dividers: [], gridLayout: "columns" });

const date = (iso) => ({ type: "date", date: { dateResolution: "day", start: iso, end: null } });
const entity = (...ids) => ({ type: "entity", entity: ids.map((id) => ({ id })) });

const post = ({ id, title, status, slug, subtitle, summary, category, tags = [], image, publish, updated, featured = false, lastUpdated, blocks }) => ({
    id,
    structureId: STRUCTURE_ID,
    collections: [],
    properties: {
        title: { type: "title", title: { value: title } },
        [STATUS_ID]: { type: "label", label: status ? [status] : [] },
        [SLUG_ID]: { type: "text", text: { value: slug ?? null } },
        [SUBTITLE_ID]: { type: "text", text: { value: subtitle ?? null } },
        [SUMMARY_ID]: { type: "text", text: { value: summary ?? null } },
        [CATEGORY_ID]: { type: "label", label: category ? [category] : [] },
        tags: entity(...tags),
        [IMAGE_ID]: entity(...(image ? [image] : [])),
        [PUBLISH_ID]: publish ? date(publish) : { type: "date", date: { dateResolution: "day", start: null, end: null } },
        [UPDATED_ID]: updated ? date(updated) : { type: "date", date: { dateResolution: "day", start: null, end: null } },
        [FEATURED_ID]: { type: "boolean", boolean: { value: featured } },
        createdAt: { type: "createdAt", createdAt: { value: "2026-09-01T00:00:00.000Z" } },
        lastUpdated: { type: "lastUpdatedAt", lastUpdatedAt: { value: lastUpdated ?? "2026-10-01T00:00:00.000Z" } },
    },
    blocks: { [CONTENT_ID]: blocks },
});

export const createSpace = (baseUrl) => {
    n = 0;
    const objects = new Map();
    const add = (object) => objects.set(object.id, object);

    add(
        post({
            id: IDS.notebook,
            title: "Publishing straight from my notebook",
            status: STATUS.published,
            slug: "publishing-from-my-notebook",
            subtitle: "How this blog goes from a Capacities note to a web page without me touching a deploy button.",
            summary: "A sample article showing how a Capacities Blog Post becomes a page on this site: properties, formatting, images and all.",
            category: label("systems", "Systems"),
            tags: [IDS.tagSystems, IDS.tagCapacities, IDS.tagWriting],
            image: IDS.imgNotebook,
            publish: "2026-10-08T00:00:00.000Z",
            updated: "2026-10-10T00:00:00.000Z",
            featured: true,
            blocks: [
                p(
                    "This is ",
                    i("sample content"),
                    " used to develop and test the site. It exercises every kind of formatting the publishing pipeline supports, so it doubles as a style guide.",
                ),
                h(1, "Why write in a notebook first"),
                p(
                    "Drafts live where the thinking happens. When a note is ready, flipping its ",
                    b("Status"),
                    " to ",
                    code("Published"),
                    " is the only step left.",
                ),
                callout("blue", "Only objects of the ", b("Blog Post"), " type, explicitly marked Published, ever reach the public site."),
                h(2, "What the sync does"),
                li("numerical", "Lists Blog Post objects through the Capacities API."),
                li("numerical", "Fetches each one and checks its Status."),
                li(
                    "numerical",
                    ["Renders the body to HTML and stores it in ", link("Cloudflare D1", "https://developers.cloudflare.com/d1/"), "."],
                    [li("bullet", "Images are copied into R2."), li("bullet", "Private references are dropped.")],
                ),
                h(2, "Formatting that survives the trip"),
                p(
                    "Text can be ",
                    b("bold"),
                    ", ",
                    i("italic"),
                    ", ",
                    t("struck through", { strikethrough: true }),
                    " or ",
                    { type: "TextToken", text: "highlighted", style: {}, color: "bg-yellow" },
                    ". Links to ",
                    ref("other published posts", IDS.training),
                    " stay links. Links to ",
                    ref("private notes", IDS.privateNote),
                    " turn into plain text.",
                ),
                quote("normal", "The best system is the one you actually use."),
                embed(IDS.imgInline),
                codeBlock("typescript", 'const status = readStatus(object, schema);\nif (status.kind !== "published") return; // fail closed'),
                embed(IDS.table),
                h(3, "Embeds"),
                embed(IDS.video),
                embed(IDS.weblink),
                embed(IDS.privatePerson),
                toggle("Open for a tangent", [p("Toggles become native details elements, so they work without JavaScript.")]),
                todo(true, "Write the post"),
                todo(false, "Share it"),
                hr(),
                quote("standout", "Write once, publish everywhere you need to."),
                p("That's the whole loop."),
            ],
        }),
    );

    add(
        post({
            id: IDS.training,
            title: "Notes on running a good training session",
            status: STATUS.published,
            slug: "running-a-good-training-session",
            summary: "A sample article in the Training category, used to test category filtering and related posts.",
            category: label("training", "Training"),
            tags: [IDS.tagLearning],
            image: IDS.imgTraining,
            publish: "2026-09-20T00:00:00.000Z",
            blocks: [
                p("Sample content. Short articles still need a clear structure."),
                h(1, "Before the session"),
                li("bullet", "Know the outcome you want."),
                li("bullet", "Check the room and the gear."),
                h(1, "During"),
                p("Keep it practical. Ask more than you tell."),
                grid([p("Left column: plan.")], [p("Right column: review.")]),
                h(1, "After"),
                p("Write down what worked while it's fresh. See also ", ref("publishing from my notebook", IDS.notebook), "."),
            ],
        }),
    );

    add(
        post({
            id: IDS.tools,
            title: "Small tools & big wins — “quotes”, <tags> and ünïcödé",
            status: STATUS.published,
            slug: null,
            summary: "Sample article with special characters in the title and body, used to check escaping. <script>alert('x')</script>",
            category: label("systems", "Systems"),
            tags: [IDS.tagSystems],
            image: IDS.imgTools,
            publish: "2026-09-05T00:00:00.000Z",
            blocks: [
                p("Characters like <, >, & and \"quotes\" must render as text: <script>alert('boom')</script>"),
                p(
                    "A ",
                    link("javascript link", "javascript:alert(1)"),
                    " must not become a link. Neither should a ",
                    link("data URL", "data:text/html,hi"),
                    ".",
                ),
                callout("yellow", "Café, naïve, 東京, and emoji 🚀 all render."),
                li("alphabetical", "Alpha"),
                li("alphabetical", "Beta"),
                { id: bid(), type: "unsupported", blockType: "SomeFutureBlock" },
            ],
        }),
    );

    add(
        post({
            id: IDS.draft,
            title: "A draft that must stay private",
            status: STATUS.draft,
            slug: "secret-draft",
            publish: "2026-10-01T00:00:00.000Z",
            blocks: [p("PRIVATE DRAFT CONTENT")],
        }),
    );
    add(
        post({
            id: IDS.archived,
            title: "An archived post",
            status: STATUS.archived,
            slug: "archived-post",
            publish: "2026-08-01T00:00:00.000Z",
            blocks: [p("PRIVATE ARCHIVED CONTENT")],
        }),
    );
    add(post({ id: IDS.noStatus, title: "No status set", status: null, slug: "no-status", blocks: [p("PRIVATE NO STATUS CONTENT")] }));

    // Referenced objects
    add({
        id: IDS.privatePerson,
        structureId: "c0ffee00-0000-4000-8000-000000000001",
        collections: [],
        properties: { title: { type: "title", title: { value: "PRIVATE PERSON NAME" } } },
    });
    add({ id: IDS.privateNote, structureId: "RootPage", collections: [], properties: { title: { type: "title", title: { value: "PRIVATE NOTE TITLE" } } } });
    for (const [key, name] of [
        ["tagSystems", "Systems thinking"],
        ["tagWriting", "Writing"],
        ["tagCapacities", "Capacities"],
        ["tagLearning", "Learning"],
    ]) {
        add({ id: IDS[key], structureId: "RootTag", collections: [], properties: { title: { type: "title", title: { value: name } } } });
    }
    const image = (id, file, type, title, description) => ({
        id,
        structureId: "MediaImage",
        collections: [],
        properties: { title: { type: "title", title: { value: title } }, description: { type: "text", text: { value: description } } },
        files: [{ url: `${baseUrl}/__files/${file}`, fileType: type, expirationDate: "2099-01-01T00:00:00.000Z" }],
    });
    add(image(IDS.imgNotebook, "cover-notebook.jpg", "image/jpeg", "Purple and blue gradient", null));
    add(image(IDS.imgTraining, "cover-training.jpg", "image/jpeg", "IMG_2041.jpg", "Dark gradient"));
    add(image(IDS.imgTools, "cover-tools.jpg", "image/jpeg", "Green gradient", null));
    add(image(IDS.imgInline, "inline-diagram.png", "image/png", "Soft lilac shapes", "A sample inline image with a caption."));
    add({
        id: IDS.video,
        structureId: "MediaWebResource",
        collections: [],
        properties: {
            title: { type: "title", title: { value: "A sample video" } },
            url: { type: "url", url: { value: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } },
        },
    });
    add({
        id: IDS.weblink,
        structureId: "MediaWebResource",
        collections: [],
        properties: {
            title: { type: "title", title: { value: "Capacities API documentation" } },
            url: { type: "url", url: { value: "https://developers.capacities.io/" } },
        },
    });
    add({ id: IDS.table, structureId: "RootSimpleTable", collections: [], properties: { title: { type: "title", title: { value: "Comparison" } } } });

    const markdown = new Map([
        [
            IDS.table,
            "# Comparison\n\n| Step | Where | Manual? |\n| --- | --- | --- |\n| Write | Capacities | Yes |\n| Publish | Status property | One click |\n| Deploy | Cloudflare | **No** |\n",
        ],
    ]);

    return { objects, markdown };
};
