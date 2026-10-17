import { type RefAttributes } from "react";
import { Tooltip } from "@/components/base/tooltip/tooltip";
import { cx } from "@/utils/cx";
import {
    TextEditorAlignCenter,
    TextEditorAlignLeft,
    TextEditorBold,
    TextEditorBulletList,
    TextEditorColor,
    TextEditorFontFamily,
    TextEditorFontSize,
    TextEditorGenerate,
    TextEditorImage,
    TextEditorItalic,
    TextEditorLink,
    TextEditorUnderline,
} from "./text-editor-extensions";

export interface TextEditorToolbarProps extends RefAttributes<HTMLDivElement> {
    /** Class name applied to the toolbar container that holds the control buttons. */
    className?: string;
    /** Which set of controls to render. `simple` shows bold, italic, underline, color, left and center align, and bullet list; `advanced` adds font family and size selects plus link, image and generate. Right and justify align are available as standalone components but are not in either toolbar. */
    type?: "simple" | "advanced";
    /** Whether to style the toolbar as a detached floating bar with its own background, padding and shadow. In the `advanced` toolbar it also drops the font family and size selects. */
    floating?: boolean;
    /** Whether to hide the font size select. Only applies to the non-floating `advanced` toolbar, the only place that select is rendered. */
    hideFontSize?: boolean;
}

export const TextEditorToolbar = ({ className, ref, type = "simple", floating = false, hideFontSize }: TextEditorToolbarProps) => {
    if (type === "simple") {
        return (
            <div
                className={cx(
                    "flex w-max flex-wrap gap-0.5 md:flex-nowrap",
                    floating && "rounded-lg bg-primary p-1 shadow-lg ring-1 ring-secondary_alt",
                    className,
                )}
            >
                <Tooltip title="Bold ⌘B">
                    <TextEditorBold />
                </Tooltip>
                <Tooltip title="Italic ⌘I">
                    <TextEditorItalic />
                </Tooltip>
                <Tooltip title="Underline ⌘U">
                    <TextEditorUnderline />
                </Tooltip>

                <div className="p-1.5">
                    <div className="h-full w-px rounded-full bg-border-primary" />
                </div>

                <TextEditorColor />

                <div className="p-1.5">
                    <div className="h-full w-px rounded-full bg-border-primary" />
                </div>

                <Tooltip title="Left align">
                    <TextEditorAlignLeft />
                </Tooltip>
                <Tooltip title="Center align">
                    <TextEditorAlignCenter />
                </Tooltip>
                <Tooltip title="Bullet list">
                    <TextEditorBulletList />
                </Tooltip>
            </div>
        );
    }

    return (
        <div
            ref={ref}
            className={cx(
                "flex w-max flex-col items-start justify-center gap-2 md:flex-row md:items-center md:justify-start md:gap-3",
                floating && "rounded-xl bg-primary p-2 shadow-lg ring-1 ring-secondary_alt",
                className,
            )}
        >
            {!floating && (
                <div className="flex gap-2">
                    <TextEditorFontFamily />
                    {!hideFontSize && <TextEditorFontSize />}
                </div>
            )}

            <div className="flex flex-wrap gap-0.5 md:flex-nowrap">
                <Tooltip title="Bold ⌘B">
                    <TextEditorBold />
                </Tooltip>
                <Tooltip title="Italic ⌘I">
                    <TextEditorItalic />
                </Tooltip>
                <Tooltip title="Underline ⌘U">
                    <TextEditorUnderline />
                </Tooltip>

                <div className="p-1.5">
                    <div className="h-full w-px rounded-full bg-border-primary" />
                </div>

                <TextEditorColor />

                <div className="p-1.5">
                    <div className="h-full w-px rounded-full bg-border-primary" />
                </div>

                <Tooltip title="Left align">
                    <TextEditorAlignLeft />
                </Tooltip>
                <Tooltip title="Center align">
                    <TextEditorAlignCenter />
                </Tooltip>
                <Tooltip title="Bullet list">
                    <TextEditorBulletList />
                </Tooltip>

                <div className="p-1.5">
                    <div className="h-full w-px rounded-full bg-border-primary" />
                </div>

                <Tooltip title="Link ⌘K">
                    <TextEditorLink />
                </Tooltip>
                <Tooltip title="Insert image">
                    <TextEditorImage />
                </Tooltip>

                <div className="p-1.5">
                    <div className="h-full w-px rounded-full bg-border-primary" />
                </div>

                <Tooltip title="Generate">
                    <TextEditorGenerate />
                </Tooltip>
            </div>
        </div>
    );
};
