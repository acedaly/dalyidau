import type { ReactNode } from "react";

export const SectionHeader = ({
    eyebrow,
    title,
    description,
    action,
    id,
}: {
    eyebrow?: string;
    title: string;
    description?: string;
    action?: ReactNode;
    id?: string;
}) => (
    <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
        <div className="flex max-w-3xl flex-col gap-3">
            {eyebrow && <p className="text-sm font-semibold text-brand-secondary md:text-md">{eyebrow}</p>}
            <h2 id={id} className="text-display-xs font-semibold text-primary md:text-display-sm">
                {title}
            </h2>
            {description && <p className="text-lg text-tertiary md:text-xl">{description}</p>}
        </div>
        {action}
    </div>
);
