import type { ReactNode } from "react";
import { cx } from "@/utils/cx";

interface ContentDividerProps {
    /** Selects the divider layout — a rule on either side of the content, top and bottom rules around it, or a filled band behind it. */
    type: "single-line" | "dual-line" | "background-fill";
    /** The content sitting in the divider, typically a short label or a button. */
    children: ReactNode;
    /** Additional class name for the divider wrapper. */
    className?: string;
}

export const ContentDivider = ({ type, children, className }: ContentDividerProps) => {
    const styles = {
        "single-line": "flex items-center gap-x-2",
        "dual-line": "flex justify-center gap-x-2 border-y border-secondary py-3",
        "background-fill": "flex justify-center gap-x-2 rounded-lg bg-secondary py-2",
    };

    return (
        <div className={cx("w-full shrink-0", styles[type], className)}>
            {type === "single-line" && <div className="h-px flex-1 bg-border-secondary" />}
            {children}
            {type === "single-line" && <div className="h-px flex-1 bg-border-secondary" />}
        </div>
    );
};
