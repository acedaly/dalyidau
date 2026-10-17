// Application page header: breadcrumbs, title, supporting text and actions. Follows Untitled UI's
// "page header" application pattern, built from Breadcrumbs and the shared typography tokens.
import type { ReactNode } from "react";
import { HomeLine } from "@untitledui/icons";
import { Breadcrumbs } from "@/components/application/breadcrumbs/breadcrumbs";
import { cx } from "@/utils/cx";

export interface Crumb {
    label: string;
    href?: string;
}

interface PageHeaderProps {
    title: string;
    description?: ReactNode;
    breadcrumbs?: Crumb[];
    actions?: ReactNode;
    /** Content under the title row, e.g. tabs. */
    children?: ReactNode;
    className?: string;
    homeHref?: string;
    homeLabel?: string;
}

export const PageHeader = ({
    title,
    description,
    breadcrumbs = [],
    actions,
    children,
    className,
    homeHref = "/portal",
    homeLabel = "All applications",
}: PageHeaderProps) => (
    <header className={cx("flex flex-col gap-5", className)}>
        {breadcrumbs.length > 0 && (
            <Breadcrumbs type="button" className="max-lg:hidden">
                {/* The item's aria-label lands on the list item, not the link, so the link carries hidden text. */}
                <Breadcrumbs.Item href={homeHref} icon={HomeLine}>
                    <span className="sr-only">{homeLabel}</span>
                </Breadcrumbs.Item>
                {breadcrumbs.map((crumb) => (
                    <Breadcrumbs.Item key={crumb.label} href={crumb.href}>
                        {crumb.label}
                    </Breadcrumbs.Item>
                ))}
            </Breadcrumbs>
        )}
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div className="flex min-w-0 flex-col gap-1 md:flex-1">
                <h1 className="text-display-xs font-semibold text-primary lg:text-display-sm">{title}</h1>
                {description && <div className="text-md text-tertiary">{description}</div>}
            </div>
            {actions && <div className="flex min-w-0 flex-wrap items-center gap-3 md:max-w-[70%] md:justify-end">{actions}</div>}
        </div>
        {children}
    </header>
);
