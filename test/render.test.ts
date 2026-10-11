import { describe, expect, it } from "vitest";
import { pageWindow } from "../src/components/site/link-pagination";
import { parseMarkdownTable, renderBlocks } from "../worker/capacities/render";
import type { Block } from "../worker/capacities/types";
import { isValidSlug, safeUrl, slugify } from "../worker/lib/html";

const ctx = { siteUrl: "https://daly.id.au", postSlug: () => null, embed: () => null };
const text = (value: string, extra: Partial<Extract<Block, { type: "TextBlock" }>> = {}): Block => ({
    id: Math.random().toString(36),
    type: "TextBlock",
    tokens: [{ type: "TextToken", text: value, style: {} }],
    blocks: [],
    hierarchy: { key: "Base", val: 0 },
    ...extra,
});

describe("renderBlocks", () => {
    it("maps Capacities heading levels below the page title and builds a TOC", () => {
        const result = renderBlocks(
            [
                text("Intro", { hierarchy: { key: "H1", val: 1 } }),
                text("Detail", { hierarchy: { key: "H2", val: 2 } }),
                text("Intro", { hierarchy: { key: "H1", val: 1 } }),
            ],
            ctx,
        );
        expect(result.html).toBe('<h2 id="intro">Intro</h2><h3 id="detail">Detail</h3><h2 id="intro-2">Intro</h2>');
        expect(result.toc).toEqual([
            { id: "intro", text: "Intro", level: 2 },
            { id: "detail", text: "Detail", level: 3 },
            { id: "intro-2", text: "Intro", level: 2 },
        ]);
    });

    it("groups consecutive list items and separates list types", () => {
        const html = renderBlocks(
            [
                text("a", { list: { type: "bullet" } }),
                text("b", { list: { type: "bullet" } }),
                text("1", { list: { type: "numerical" } }),
                text("i", { list: { type: "roman" } }),
            ],
            ctx,
        ).html;
        expect(html).toBe('<ul><li>a</li><li>b</li></ul><ol><li>1</li></ol><ol type="i"><li>i</li></ol>');
    });

    it("escapes text and drops unsafe links", () => {
        const html = renderBlocks(
            [
                {
                    id: "x",
                    type: "TextBlock",
                    hierarchy: { key: "Base", val: 0 },
                    blocks: [],
                    tokens: [
                        { type: "TextToken", text: "<img src=x onerror=alert(1)>", style: { bold: true } },
                        { type: "LinkToken", text: "click", url: "javascript:alert(1)" },
                        { type: "LinkToken", text: "ok", url: "https://example.com/?a=1&b=2" },
                    ],
                },
            ],
            ctx,
        ).html;
        expect(html).toBe(
            '<p><strong>&lt;img src=x onerror=alert(1)&gt;</strong>click<a href="https://example.com/?a=1&amp;b=2" rel="noopener noreferrer" target="_blank">ok</a></p>',
        );
    });

    it("drops unresolved embeds and unsupported blocks", () => {
        const result = renderBlocks(
            [
                { id: "e", type: "EntityBlock", entityId: "private" },
                { id: "u", type: "unsupported", blockType: "Whiteboard" },
            ],
            ctx,
        );
        expect(result.html).toBe("");
        expect(result.skipped).toEqual(["Whiteboard"]);
    });

    it("counts words for reading time", () => {
        expect(renderBlocks([text("one two three"), text("four")], ctx).wordCount).toBe(4);
    });
});

describe("helpers", () => {
    it("slugifies titles", () => {
        expect(slugify("Small tools & big wins — “quotes”, <tags> and ünïcödé")).toBe("small-tools-and-big-wins-quotes-tags-and-unicode");
        expect(slugify("  It's   here!  ")).toBe("its-here");
        expect(isValidSlug("ok-slug-2")).toBe(true);
        expect(isValidSlug("../etc")).toBe(false);
    });

    it("allows only safe URL schemes", () => {
        expect(safeUrl("https://a.b/c")).toBe("https://a.b/c");
        expect(safeUrl("mailto:x@y.z")).toBe("mailto:x@y.z");
        expect(safeUrl("javascript:alert(1)")).toBeNull();
        expect(safeUrl("data:text/html,x")).toBeNull();
        expect(safeUrl("/relative")).toBeNull();
    });

    it("parses Markdown tables", () => {
        expect(parseMarkdownTable("# T\n\n| A | B |\n| --- | :-: |\n| **1** | [[Link]] |\n\nafter")).toEqual([
            ["A", "B"],
            ["1", "Link"],
        ]);
    });

    it("windows pagination", () => {
        expect(pageWindow(1, 5)).toEqual([1, 2, 3, 4, 5]);
        expect(pageWindow(10, 20)).toEqual([1, 2, null, 9, 10, 11, null, 19, 20]);
    });
});
