// Building blocks for the Portal settings sections: a card in the style of the General tab's
// sections, a list of links to settings kept in each application, and a yes/no status row.
import type { FC, ReactNode } from "react";
import { ChevronRight } from "@untitledui/icons";
import { BadgeWithDot } from "@/components/base/badges/badges";
import { FeaturedIcon } from "@/components/foundations/featured-icon/featured-icon";
import { cx } from "@/utils/cx";

export const SettingsCard = ({
    id,
    icon,
    title,
    description,
    actions,
    className,
    children,
}: {
    id: string;
    icon: FC<{ className?: string }>;
    title: string;
    description?: ReactNode;
    actions?: ReactNode;
    className?: string;
    children?: ReactNode;
}) => (
    <section aria-labelledby={`${id}-heading`} className={cx("rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset sm:p-6", className)}>
        <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-4">
                <FeaturedIcon icon={icon} color="gray" theme="modern" size="lg" className="shrink-0" />
                <div className="min-w-0">
                    <h2 id={`${id}-heading`} className="text-md font-semibold text-primary">
                        {title}
                    </h2>
                    {description && <p className="mt-1 text-sm text-tertiary">{description}</p>}
                </div>
            </div>
            {actions}
        </div>
        {children && <div className="mt-6 flex flex-col gap-4">{children}</div>}
    </section>
);

export interface SettingsLink {
    label: string;
    description: string;
    href: string;
}

export const SettingsLinks = ({ links, label }: { links: SettingsLink[]; label: string }) => (
    <ul aria-label={label} className="flex flex-col divide-y divide-secondary rounded-lg ring-1 ring-secondary ring-inset">
        {links.map((link) => (
            <li key={link.href}>
                <a
                    href={link.href}
                    className="group flex items-center justify-between gap-4 px-4 py-3 outline-focus-ring transition duration-100 ease-linear first:rounded-t-lg last:rounded-b-lg hover:bg-primary_hover focus-visible:outline-2 focus-visible:-outline-offset-2"
                >
                    <span className="min-w-0">
                        <span className="block text-sm font-medium text-primary">{link.label}</span>
                        <span className="block text-sm text-tertiary">{link.description}</span>
                    </span>
                    <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary group-hover:text-fg-quaternary_hover" />
                </a>
            </li>
        ))}
    </ul>
);

export const StatusRow = ({ label, value, ok, detail }: { label: string; value: string; ok: boolean; detail?: string }) => (
    <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
        <dt className="min-w-0">
            <span className="block text-sm font-medium text-primary">{label}</span>
            {detail && <span className="block text-sm text-tertiary">{detail}</span>}
        </dt>
        <dd className="shrink-0">
            <BadgeWithDot size="sm" type="pill-color" color={ok ? "success" : "gray"}>
                {value}
            </BadgeWithDot>
        </dd>
    </div>
);
