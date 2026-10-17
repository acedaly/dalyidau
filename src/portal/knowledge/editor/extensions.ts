// The editor's schema. It must stay in step with the stored format in
// src/shared/knowledge/content.ts: every node and mark here is one the Worker accepts.
import { type Editor, Extension, type Range, mergeAttributes } from "@tiptap/core";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Mention } from "@tiptap/extension-mention";
import { Placeholder } from "@tiptap/extension-placeholder";
import { TableKit } from "@tiptap/extension-table";
import { PluginKey } from "@tiptap/pm/state";
import type { Extensions } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { Suggestion } from "@tiptap/suggestion";
import { AlignLeft, CheckSquare, Code02, Dotpoints01, Heading01, Heading02, Link03, List, Minus, Plus, Table, Type01 } from "@untitledui/icons";
import { objectHref, titleOf } from "../shared";
import { type MenuItem, renderSuggestionList } from "./suggestion-menu";

export interface EditorHooks {
    /** Objects whose titles match, for [[ links. */
    lookup: (query: string) => Promise<{ id: string; title: string; hint?: string }[]>;
    /** Creates a page with this title and returns it, for "[[New thing" with no match. */
    createPage: (title: string) => Promise<{ id: string; title: string }>;
    placeholder: string;
}

const insertLink = (editor: Editor, range: Range, target: { id: string; title: string }) =>
    editor
        .chain()
        .focus()
        .insertContentAt(range, [
            { type: "objectLink", attrs: { id: target.id, label: target.title } },
            { type: "text", text: " " },
        ])
        .run();

/** Links to other objects, typed as [[Title. Stored as objectLink nodes; rendered as ordinary links. */
const objectLinkExtension = (hooks: EditorHooks) =>
    Mention.extend({ name: "objectLink" }).configure({
        HTMLAttributes: {
            class: "rounded-sm bg-brand-primary px-1 py-0.5 font-medium text-brand-secondary no-underline decoration-transparent hover:underline hover:decoration-current",
        },
        renderText: ({ node }) => titleOf(node.attrs.label ?? ""),
        renderHTML: ({ node, options }) => [
            "a",
            mergeAttributes({ href: objectHref(node.attrs.id), "data-object-link": node.attrs.id }, options.HTMLAttributes),
            titleOf(node.attrs.label ?? ""),
        ],
        deleteTriggerWithBackspace: true,
        suggestion: {
            char: "[[",
            allowSpaces: true,
            // Links can follow a word directly ("see[[Project"), unlike / commands.
            allowedPrefixes: null,
            pluginKey: new PluginKey("objectLinkSuggestion"),
            debounce: 150,
            items: async ({ query }): Promise<MenuItem[]> => {
                const results = await hooks.lookup(query).catch(() => []);
                const items: MenuItem[] = results.map((r) => ({ id: r.id, title: titleOf(r.title), hint: r.hint, icon: Link03 }));
                const title = query.replace(/\]+$/, "").trim();
                if (title && !results.some((r) => r.title.toLowerCase() === title.toLowerCase()))
                    items.push({ id: `create:${title}`, title: `Create “${title}”`, hint: "New page", icon: Plus });
                return items;
            },
            command: ({ editor, range, props }) => {
                const item = props as MenuItem;
                if (item.id.startsWith("create:")) {
                    const title = item.id.slice("create:".length);
                    hooks
                        .createPage(title)
                        .then((created) => insertLink(editor, range, created))
                        .catch(() => undefined);
                    return;
                }
                insertLink(editor, range, { id: item.id, title: item.title });
            },
            render: renderSuggestionList("Link to an object", "Type a title to link to it"),
        },
    });

interface SlashCommand extends MenuItem {
    keywords: string;
    run: (editor: Editor, range: Range) => void;
}

const SLASH_COMMANDS: SlashCommand[] = [
    { id: "text", title: "Text", icon: Type01, keywords: "paragraph", run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run() },
    { id: "h1", title: "Heading 1", icon: Heading01, keywords: "title big", run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 1 }).run() },
    { id: "h2", title: "Heading 2", icon: Heading02, keywords: "subtitle", run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 2 }).run() },
    { id: "h3", title: "Heading 3", icon: Heading02, keywords: "section", run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 3 }).run() },
    {
        id: "bullets",
        title: "Bullet list",
        icon: Dotpoints01,
        keywords: "unordered ul",
        run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run(),
    },
    { id: "numbers", title: "Numbered list", icon: List, keywords: "ordered ol", run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run() },
    {
        id: "tasks",
        title: "Checklist",
        icon: CheckSquare,
        keywords: "todo task checkbox",
        run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run(),
    },
    { id: "quote", title: "Quote", icon: AlignLeft, keywords: "blockquote", run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run() },
    { id: "code", title: "Code block", icon: Code02, keywords: "pre", run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run() },
    { id: "divider", title: "Divider", icon: Minus, keywords: "rule hr line", run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run() },
    {
        id: "table",
        title: "Table",
        icon: Table,
        keywords: "grid",
        run: (e, r) => e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    },
    {
        id: "link",
        title: "Link to an object",
        hint: "Or type [[",
        icon: Link03,
        keywords: "mention reference",
        run: (e, r) => e.chain().focus().deleteRange(r).insertContent("[[").run(),
    },
];

const slashCommands = Extension.create({
    name: "slashCommands",
    addProseMirrorPlugins() {
        return [
            Suggestion<MenuItem, MenuItem>({
                editor: this.editor,
                char: "/",
                pluginKey: new PluginKey("slashCommands"),
                // Only at the start of a line or after a space, so URLs and dates don't open the menu.
                allowedPrefixes: [" "],
                items: ({ query }) => {
                    const q = query.toLowerCase();
                    return SLASH_COMMANDS.filter((c) => !q || c.title.toLowerCase().includes(q) || c.keywords.includes(q));
                },
                command: ({ editor, range, props }) => SLASH_COMMANDS.find((c) => c.id === props.id)?.run(editor, range),
                render: renderSuggestionList("Insert", "No matching blocks"),
            }),
        ];
    },
});

export const knowledgeExtensions = (hooks: EditorHooks): Extensions => [
    StarterKit.configure({
        heading: { levels: [1, 2, 3, 4] },
        blockquote: { HTMLAttributes: { class: "my-3.5 border-l-4 border-secondary pl-4" } },
        bulletList: { HTMLAttributes: { class: "list-disc ml-7" } },
        orderedList: { HTMLAttributes: { class: "list-decimal ml-7" } },
        codeBlock: { HTMLAttributes: { class: "my-3 rounded-lg bg-secondary p-4 font-mono text-sm text-secondary" } },
        code: { HTMLAttributes: { class: "rounded-sm bg-secondary px-1 py-0.5 font-mono text-sm" } },
        horizontalRule: { HTMLAttributes: { class: "my-6 border-secondary" } },
        link: {
            openOnClick: false,
            autolink: true,
            defaultProtocol: "https",
            protocols: ["https", "http", "mailto"],
            // Matches what the Worker stores: http(s), mailto and paths on this site.
            isAllowedUri: (url) => /^(https?:|mailto:)/i.test(url) || /^\/(?![/\\])/.test(url),
            HTMLAttributes: { class: "text-brand-secondary underline", rel: "noopener noreferrer nofollow" },
        },
    }),
    TaskList.configure({ HTMLAttributes: { class: "ml-1 flex flex-col gap-1 [&_li]:flex [&_li]:items-start [&_li]:gap-2 [&_li>label]:mt-1" } }),
    TaskItem.configure({ nested: true }),
    TableKit.configure({
        table: {
            resizable: false,
            HTMLAttributes: {
                class: "my-3 w-full border-collapse text-sm [&_td]:border [&_td]:border-secondary [&_td]:p-2 [&_th]:border [&_th]:border-secondary [&_th]:bg-secondary [&_th]:p-2 [&_th]:text-left",
            },
        },
    }),
    Placeholder.configure({
        placeholder: ({ node }) => (node.type.name === "paragraph" ? hooks.placeholder : ""),
        emptyEditorClass:
            "first:before:text-placeholder first:before:float-left first:before:content-[attr(data-placeholder)] first:before:pointer-events-none first:before:h-0",
    }),
    objectLinkExtension(hooks),
    slashCommands,
];
