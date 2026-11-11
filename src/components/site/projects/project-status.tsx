import { type ProjectStatus, projectStatusLabel } from "@/shared/site-content";
import { cx } from "@/utils/cx";

const DOT: Record<ProjectStatus, string> = {
    active: "bg-fg-brand-primary",
    experimental: "bg-[rgb(196_148_82)]",
    completed: "bg-fg-quaternary",
    archived: "bg-transparent ring-1 ring-fg-quaternary ring-inset",
};

/** A project's status: a small dot and its name, quiet enough to sit on any card. */
export const ProjectStatusLabel = ({ status, className }: { status: ProjectStatus; className?: string }) => (
    <span className={cx("inline-flex items-center gap-1.5 text-sm font-medium text-tertiary", className)}>
        <span aria-hidden="true" className={cx("size-1.5 rounded-full", DOT[status])} />
        {projectStatusLabel(status)}
    </span>
);

export const ProjectTags = ({ tags, className }: { tags: string[]; className?: string }) =>
    tags.length ? (
        <ul className={cx("flex flex-wrap gap-1.5", className)} aria-label="Technologies and topics">
            {tags.map((tag) => (
                <li key={tag} className="rounded-full border border-secondary px-2.5 py-0.5 text-xs font-medium text-secondary">
                    {tag}
                </li>
            ))}
        </ul>
    ) : null;
