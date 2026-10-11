import { site } from "@/content/site";
import { cx } from "@/utils/cx";

export const SiteLogo = ({ className }: { className?: string }) => (
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
