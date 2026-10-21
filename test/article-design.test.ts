// The shared article design system: what Amplenote's writing conventions render to
// (docs/AMPLENOTE.md#rich-blocks), that both publishers produce the same markup for the same block,
// and that nothing in a note can get raw HTML onto the page. Every note here is invented.
import { describe, expect, it } from "vitest";
import { NOTE_IDS } from "../fixtures/amplenote/mock-api.mjs";
import { normaliseHeadingWall, quoteKind, renderMarkdown } from "../worker/amplenote/markdown";
import { renderBlocks } from "../worker/capacities/render";
import type { Block } from "../worker/capacities/types";

const ctx = {
    siteUrl: "https://daly.id.au",
    image: (url: string) => (url.includes("ok") ? { src: "/media/abc.png", width: 10, height: 5 } : null),
    noteSlug: (uuid: string) => (uuid === NOTE_IDS.garden ? "a-garden" : null),
};
const render = (md: string) => renderMarkdown(md, ctx);

describe("callouts", () => {
    it("reads [!NOTE]-style markers, with an optional title, even when Amplenote escapes the brackets", () => {
        expect(render("> [!NOTE]\n> Water early.").html).toBe(
            '<aside class="callout" data-tone="info"><p class="callout-title">Note</p><p>Water early.</p></aside>',
        );
        expect(render("> \\[!TIP\\] Before you start\n> Soak the seeds.").html).toBe(
            '<aside class="callout" data-tone="success"><p class="callout-title">Before you start</p><p>Soak the seeds.</p></aside>',
        );
        expect(render("> [!WARNING]\n> Hot.").html).toContain('data-tone="warning"');
        expect(render("> [!CAUTION]\n> Sharp.").html).toContain('data-tone="danger"');
        expect(render("> [!IMPORTANT]\n> Read this.").html).toContain('data-tone="brand"');
        expect(render("> [!CALLOUT]\n> Plain box.").html).toBe('<aside class="callout" data-tone="neutral"><p>Plain box.</p></aside>');
    });

    it("reads a bold label or a leading emoji", () => {
        expect(render("> **Warning:** the soil is wet").html).toBe(
            '<aside class="callout" data-tone="warning"><p class="callout-title">Warning</p><p>the soil is wet</p></aside>',
        );
        expect(render("> 💡 A small idea").html).toBe('<aside class="callout" data-tone="success"><p>A small idea</p></aside>');
    });

    it("leaves an ordinary quote, and an unknown marker, as a quote", () => {
        expect(render("> Just words.").html).toBe("<blockquote><p>Just words.</p></blockquote>");
        expect(quoteKind(["[!SOMETHING] x"]).kind).toEqual({ kind: "quote" });
        expect(render("> **Bold opening** of a quote").html).toBe("<blockquote><p><strong>Bold opening</strong> of a quote</p></blockquote>");
    });
});

describe("quotes", () => {
    it("makes a pull quote, with an attribution", () => {
        expect(render("> [!PULLQUOTE]\n> Less, but better.\n> — Someone *wise*").html).toBe(
            '<figure class="pullquote"><blockquote><p>Less, but better.</p></blockquote><figcaption>Someone <em>wise</em></figcaption></figure>',
        );
    });

    it("gives an ordinary quote its attribution", () => {
        expect(render("> Start where you are.\n> -- A gardener").html).toBe(
            '<figure class="quote"><blockquote><p>Start where you are.</p></blockquote><figcaption>A gardener</figcaption></figure>',
        );
        // A dash inside the text is not an attribution.
        expect(render("> One — two").html).toBe("<blockquote><p>One — two</p></blockquote>");
    });
});

describe("images", () => {
    it("captions an image with the italic line below it, or its title", () => {
        expect(render("![Beds](https://images.amplenote.com/ok.png)\n\n*The beds in **May***\n\nNext paragraph.").html).toBe(
            '<figure class="image"><img src="/media/abc.png" alt="Beds" width="10" height="5" loading="lazy" decoding="async"><figcaption>The beds in <strong>May</strong></figcaption></figure><p>Next paragraph.</p>',
        );
        expect(render('![Beds](https://images.amplenote.com/ok.png "From the gate")').html).toContain("<figcaption>From the gate</figcaption>");
    });

    it("doesn't take an italic paragraph that runs on as a caption", () => {
        const { html } = render("![Beds](https://images.amplenote.com/ok.png)\n\n*An aside*\nthat continues.");
        expect(html).toContain('decoding="async"></figure>');
        expect(html).toContain("<p><em>An aside</em> that continues.</p>");
    });
});

describe("link cards", () => {
    it("turns a link on its own line into a card, and leaves links within text alone", () => {
        expect(render("[The RHS guide](https://www.rhs.org.uk/vegetables)").html).toBe(
            '<p class="link-card"><a href="https://www.rhs.org.uk/vegetables" rel="noopener noreferrer" target="_blank"><span class="link-card-title">The RHS guide</span><span class="link-card-host">rhs.org.uk</span></a></p>',
        );
        expect(render("https://example.com/notes/").html).toContain('<span class="link-card-title">example.com/notes</span>');
        expect(render("See [this](https://example.com) for more.").html).not.toContain("link-card");
    });

    it("cards a published note as another article, and never a private one or an unsafe link", () => {
        expect(render(`[My garden](https://www.amplenote.com/notes/${NOTE_IDS.garden})`).html).toContain(
            '<a href="/blog/a-garden"><span class="link-card-title">My garden</span><span class="link-card-host">Also on this blog</span>',
        );
        const hidden = render(`[Secret](https://www.amplenote.com/notes/${NOTE_IDS.private})`).html;
        expect(hidden).toBe("<p>Secret</p>");
        expect(render("[x](javascript:alert(1))").html).toBe("<p>x</p>");
        expect(render("[home](https://daly.id.au/about)").html).not.toContain("link-card");
    });
});

describe("pasted notes where every paragraph is a heading", () => {
    const sentence = (n: number) => `### Paragraph number ${n} goes on for a while, as paragraphs usually do in an article.`;
    const wall = [
        "## **An invented article title**",
        "### **First section**",
        sentence(1),
        sentence(2),
        sentence(3),
        "### **Second section**",
        sentence(4),
        sentence(5),
        sentence(6),
        sentence(7),
        "### **A closing thought that ends with a full stop.**",
    ];

    it("turns sentences back into paragraphs and keeps short bold lines as section headings", () => {
        const { html, toc } = render(wall.join("\n"));
        expect(html).toContain('<h3 id="first-section"><strong>First section</strong></h3><p>Paragraph number 1');
        expect(html).toContain('<h3 id="second-section">');
        expect(html).toContain("<p><strong>A closing thought that ends with a full stop.</strong></p>");
        expect(html.match(/<h4/g)).toBeNull();
        expect(toc.map((t) => t.text)).toEqual(["An invented article title", "First section", "Second section"]);
    });

    it("keeps a paragraph that starts like a list as a paragraph", () => {
        const lines = normaliseHeadingWall([...wall, "### 1. This line starts with a number but is really a paragraph of text."]);
        expect(lines).toContain("1\\. This line starts with a number but is really a paragraph of text.");
        expect(render(lines.join("\n")).html).toContain("<p>1. This line starts");
    });

    it("leaves a note written normally exactly as it is", () => {
        const normal = ["# Intro", "Text.", "## Detail", "More text.", "### A", "### B", "### C", "### D", "### E", "### F", "### G", "### H"];
        expect(normaliseHeadingWall(normal)).toEqual(normal);
        const outline = ["# One", "body", "## Two", "body", "## Three", "body"];
        expect(normaliseHeadingWall(outline)).toEqual(outline);
    });

    it("ignores headings inside code", () => {
        const code = ["```md", ...wall, "```"];
        expect(normaliseHeadingWall(code)).toEqual(code);
    });
});

describe("safety", () => {
    it("never lets raw HTML or scripts through a callout, caption, attribution, card or table", () => {
        const md = [
            "> [!NOTE] <img src=x onerror=alert(1)>",
            "> <script>alert(1)</script>body",
            "",
            "![a](https://images.amplenote.com/ok.png)",
            "",
            "*<iframe src=//evil></iframe>caption*",
            "",
            "> quote",
            "> — <svg onload=alert(1)>",
            "",
            '[<b>x</b>](https://example.com/"onmouseover=alert(1))',
            "",
            "| <a href=javascript:x>c</a> |",
            "|-|",
            "| d |",
        ].join("\n");
        const { html } = render(md);
        expect(html).not.toMatch(/<script|<img src=x|onerror|<iframe|<svg|onload|<b>|javascript:|"onmouseover/);
        expect(html).toContain('<aside class="callout" data-tone="info">');
    });
});

describe("one design system for both publishers", () => {
    it("renders a Capacities callout, pull quote, code and table with the same markup as Amplenote", () => {
        const blocks = [
            { type: "TextBlock", tokens: [{ type: "TextToken", text: "Boxed" }], colorTheme: "bg-blue" },
            { type: "TextBlock", tokens: [{ type: "TextToken", text: "Big words" }], quote: { layout: "standout" } },
            { type: "CodeBlock", text: "x < 1", lang: "JS" },
        ] as unknown as Block[];
        const capacities = renderBlocks(blocks, { siteUrl: "https://daly.id.au", postSlug: () => null, embed: () => null }).html;
        expect(capacities).toBe(
            '<aside class="callout" data-tone="info"><p>Boxed</p></aside><figure class="pullquote"><blockquote><p>Big words</p></blockquote></figure><pre data-lang="js"><code class="language-js">x &lt; 1</code></pre>',
        );
        const amplenote = render("> [!CALLOUT]\n> Boxed\n\n> [!PULLQUOTE]\n> Big words\n\n```JS\nx < 1\n```").html;
        expect(amplenote).toBe(capacities.replace('data-tone="info"', 'data-tone="neutral"'));
    });
});
