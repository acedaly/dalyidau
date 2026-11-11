import { DalyLogo } from "@/components/site/brand/daly-logo";
import { useSite } from "@/providers/site-content";
import { usePreviewHref, useSiteFrame } from "@/providers/site-frame";
import { cx } from "@/utils/cx";

export const SiteLogo = ({ className }: { className?: string }) => {
    const site = useSite();
    const { projects } = useSiteFrame();
    const home = usePreviewHref()("/");
    if (projects)
        return (
            // The projects-first design: the Daly logo, with the name for screen readers.
            <a
                href={home}
                className={cx("-ml-2 block rounded-md text-primary outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2", className)}
            >
                <DalyLogo className="h-11 w-auto" />
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
