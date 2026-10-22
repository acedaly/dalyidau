import type { FC, ReactNode } from "react";

/** A titled panel: a heading row (with an optional icon and action) above its content. */
export const Card = ({
    title,
    icon: Icon,
    action,
    children,
}: {
    title: string;
    icon?: FC<{ className?: string }>;
    action?: ReactNode;
    children: ReactNode;
}) => (
    // Clipped: the empty state's decorative pattern is wider than a narrow card.
    <section className="flex flex-col overflow-hidden rounded-xl bg-primary shadow-xs ring-1 ring-secondary ring-inset">
        <div className="flex items-center justify-between gap-3 border-b border-secondary px-4 py-3.5 sm:px-5">
            <h2 className="flex items-center gap-2 text-md font-semibold text-primary">
                {Icon && <Icon aria-hidden="true" className="size-4 text-fg-quaternary" />}
                {title}
            </h2>
            {action}
        </div>
        {children}
    </section>
);
