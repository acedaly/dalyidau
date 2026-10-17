import { BubbleMenu } from "@tiptap/react/menus";
import { cx } from "@/utils/cx";
import { useEditorContext } from "./text-editor";
import { TextEditorAlignCenter, TextEditorAlignLeft, TextEditorBold, TextEditorItalic, TextEditorLink, TextEditorUnderline } from "./text-editor-extensions";

export interface TextEditorTooltipProps {
    /** Class name applied to TipTap's bubble menu — the floating bar that appears above the current text selection. */
    className?: string;
    /** Color scheme of the floating bar. `dark` applies the `dark-mode` class so it renders inverted against a light page. */
    theme?: "dark" | "light";
}

export const TextEditorTooltip = ({ className, theme = "dark" }: TextEditorTooltipProps) => {
    const { editor } = useEditorContext();

    return (
        <BubbleMenu
            editor={editor}
            className={cx(
                "z-10 flex origin-bottom flex-wrap gap-0.5 rounded-xl bg-primary p-1.5 shadow-lg ring-1 ring-secondary duration-100 animate-in fade-in ring-inset slide-in-from-bottom-0.5 zoom-in-95 md:flex-nowrap",
                theme === "dark" && "dark-mode",
                className,
            )}
        >
            <TextEditorBold />
            <TextEditorItalic />
            <TextEditorUnderline />
            <TextEditorAlignLeft />
            <TextEditorAlignCenter />
            <TextEditorLink />
        </BubbleMenu>
    );
};
