import { useSiteFrame, usePreviewHref } from "@/providers/site-frame";
import { useSite } from "@/providers/site-content";
import { cx } from "@/utils/cx";

export const SiteLogo = ({ className }: { className?: string }) => {
    const site = useSite();
    const { projects } = useSiteFrame();
    const home = usePreviewHref()("/");
    if (projects)
        return (
            // The projects-first design's wordmark: the initials and a sage full stop, with the name for screen readers.
            <a href={home} className={cx("rounded-md text-xl font-bold tracking-tight text-primary outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-4", className)}>
                <span aria-hidden="true">
                    {site.shortName}
                    <span className="text-fg-brand-primary">.</span>
                </span>
                <span className="sr-only">{site.name}</span>
            </a>
        );
    return (
        <a
            href="/"
            className={cx("group flex items-center gap-2.5 rounded-lg outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-4", className)}
        >
            <span
                aria-hidden="true"
                className="flex size-8 items-center justify-center rounded-lg bg-brand-solid text-xs font-bold tracking-wide text-white shadow-xs-skeuomorphic transition duration-100 ease-linear group-hover:bg-brand-solid_hover"
            >
                {site.shortName}
            </span>
            <span className="text-md font-semibold text-primary">{site.name}</span>
        </a>
    );
};
