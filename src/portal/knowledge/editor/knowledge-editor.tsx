// The Knowledge document editor: Untitled UI PRO's TextEditor with Knowledge's own schema, a
// formatting toolbar, "/" commands and "[[" links. Loaded lazily, so pages that don't edit
// documents don't download the editor.
import type { FC, HTMLAttributes } from "react";
import { useMemo, useRef } from "react";
import { type Editor, useEditorState } from "@tiptap/react";
import { AlignLeft, CheckSquare, Code02, FlipBackward, FlipForward, Heading01, Heading02, Link03, List, Minus, Table } from "@untitledui/icons";
import { TextEditor, useEditorContext } from "@/components/base/text-editor/text-editor";
import { EditorButton } from "@/components/base/text-editor/text-editor-button";
import {
    TextEditorBold,
    TextEditorBulletList,
    TextEditorItalic,
    TextEditorLink,
    TextEditorUnderline,
} from "@/components/base/text-editor/text-editor-extensions";
import { Tooltip } from "@/components/base/tooltip/tooltip";
import type { DocNode } from "@/shared/knowledge/content";
import { cx } from "@/utils/cx";
import { type EditorHooks, knowledgeExtensions } from "./extensions";

export interface KnowledgeEditorProps extends EditorHooks {
    initial: DocNode;
    editable: boolean;
    onChange: (doc: DocNode) => void;
    /** Called once the editor exists, e.g. to focus it on a new object. */
    onReady?: (editor: Editor) => void;
}

const Divider = () => (
    <div className="p-1.5" aria-hidden="true">
        <div className="h-full w-px rounded-full bg-border-primary" />
    </div>
);

interface BlockButtonProps {
    label: string;
    icon: FC<HTMLAttributes<HTMLOrSVGElement>>;
    isActive?: (editor: Editor) => boolean;
    isEnabled?: (editor: Editor) => boolean;
    run: (editor: Editor) => void;
}

/** A toolbar button in the style of the PRO toolbar's own buttons. */
const BlockButton = ({ label, icon: Icon, isActive, isEnabled, run }: BlockButtonProps) => {
    const { editor, isDisabled } = useEditorContext();
    const state = useEditorState({
        editor,
        selector: ({ editor: e }) => ({ active: isActive?.(e) ?? false, enabled: isEnabled?.(e) ?? true }),
    });
    return (
        <Tooltip title={label}>
            <EditorButton aria-label={label} isDisabled={isDisabled || !state.enabled} isActive={state.active} onClick={() => run(editor)}>
                <Icon className="size-4" aria-hidden="true" />
            </EditorButton>
        </Tooltip>
    );
};

const Toolbar = () => (
    <div
        role="toolbar"
        aria-label="Formatting"
        className="sticky top-14 z-10 -mx-1 flex flex-wrap gap-0.5 rounded-lg bg-primary/95 p-1 ring-1 ring-secondary backdrop-blur-sm lg:top-2"
    >
        <BlockButton
            label="Heading 1"
            icon={Heading01}
            isActive={(e) => e.isActive("heading", { level: 1 })}
            run={(e) => e.chain().focus().toggleHeading({ level: 1 }).run()}
        />
        <BlockButton
            label="Heading 2"
            icon={Heading02}
            isActive={(e) => e.isActive("heading", { level: 2 })}
            run={(e) => e.chain().focus().toggleHeading({ level: 2 }).run()}
        />
        <Divider />
        <Tooltip title="Bold ⌘B">
            <TextEditorBold />
        </Tooltip>
        <Tooltip title="Italic ⌘I">
            <TextEditorItalic />
        </Tooltip>
        <Tooltip title="Underline ⌘U">
            <TextEditorUnderline />
        </Tooltip>
        <Tooltip title="Web link ⌘K">
            <TextEditorLink />
        </Tooltip>
        <BlockButton label="Link to an object ([[)" icon={Link03} run={(e) => e.chain().focus().insertContent("[[").run()} />
        <Divider />
        <Tooltip title="Bullet list">
            <TextEditorBulletList />
        </Tooltip>
        <BlockButton label="Numbered list" icon={List} isActive={(e) => e.isActive("orderedList")} run={(e) => e.chain().focus().toggleOrderedList().run()} />
        <BlockButton label="Checklist" icon={CheckSquare} isActive={(e) => e.isActive("taskList")} run={(e) => e.chain().focus().toggleTaskList().run()} />
        <BlockButton label="Quote" icon={AlignLeft} isActive={(e) => e.isActive("blockquote")} run={(e) => e.chain().focus().toggleBlockquote().run()} />
        <BlockButton label="Code block" icon={Code02} isActive={(e) => e.isActive("codeBlock")} run={(e) => e.chain().focus().toggleCodeBlock().run()} />
        <BlockButton label="Divider" icon={Minus} run={(e) => e.chain().focus().setHorizontalRule().run()} />
        <BlockButton label="Table" icon={Table} run={(e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} />
        <Divider />
        <BlockButton label="Undo ⌘Z" icon={FlipBackward} isEnabled={(e) => e.can().undo()} run={(e) => e.chain().focus().undo().run()} />
        <BlockButton label="Redo ⇧⌘Z" icon={FlipForward} isEnabled={(e) => e.can().redo()} run={(e) => e.chain().focus().redo().run()} />
    </div>
);

/** ProseMirror needs at least one block; a new object's empty document has none. */
const editorContent = (doc: DocNode) => (doc.content?.length ? doc : { type: "doc", content: [{ type: "paragraph" }] });

export default function KnowledgeEditor({ initial, editable, onChange, onReady, lookup, createPage, placeholder }: KnowledgeEditorProps) {
    // The hooks change identity on every render of the page; the editor is created once.
    const hooks = useRef({ lookup, createPage, placeholder });
    hooks.current = { lookup, createPage, placeholder };
    const extensions = useMemo(
        () =>
            knowledgeExtensions({
                lookup: (q) => hooks.current.lookup(q),
                createPage: (title) => hooks.current.createPage(title),
                placeholder: hooks.current.placeholder,
            }),
        [],
    );

    return (
        <TextEditor.Root
            extensions={extensions}
            content={editorContent(initial)}
            isDisabled={!editable}
            placeholder={placeholder}
            onUpdate={({ editor }) => onChange(editor.getJSON() as DocNode)}
            onCreate={({ editor }) => onReady?.(editor)}
            editorProps={{
                // Object links are atoms you can't put a cursor inside, so a click follows them.
                handleClick: (_view, _pos, event) => {
                    const link = (event.target as HTMLElement | null)?.closest?.("a[data-object-link]");
                    if (!link) return false;
                    event.preventDefault();
                    window.location.assign(link.getAttribute("href")!);
                    return true;
                },
            }}
            className="gap-4"
            inputClassName={cx(
                "prose min-h-[45vh] max-w-none resize-none overflow-visible rounded-none bg-transparent p-0 text-md shadow-none ring-0 focus:ring-0",
                "[&_li[data-checked=true]>div]:text-quaternary [&_li[data-checked=true]>div]:line-through [&_ul[data-type=taskList]]:list-none [&_ul[data-type=taskList]]:pl-0",
                // Read-only documents aren't dimmed: they're for reading.
                !editable && "cursor-auto opacity-100",
            )}
        >
            {editable && <Toolbar />}
            <TextEditor.Content />
        </TextEditor.Root>
    );
}
