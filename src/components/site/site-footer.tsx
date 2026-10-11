import { Rss01 } from "@untitledui/icons";
import { GitHub, Instagram, LinkedIn, X, YouTube } from "@/components/foundations/social-icons";
import { site } from "@/content/site";

const SOCIAL_ICONS = { github: GitHub, linkedin: LinkedIn, x: X, instagram: Instagram, youtube: YouTube } as const;

export const SiteFooter = () => (
    <footer className="border-t border-secondary bg-primary py-10 md:py-12">
        <div className="mx-auto flex max-w-container flex-col gap-6 px-4 md:flex-row md:items-center md:justify-between md:px-8">
            <p className="text-md text-quaternary">
                © {new Date().getFullYear()} {site.name}. {site.location}.
            </p>
            <nav aria-label="Footer">
                <ul className="flex flex-wrap items-center gap-x-6 gap-y-3">
                    {site.nav.map((item) => (
                        <li key={item.href}>
                            <a
                                href={item.href}
                                className="text-md font-semibold text-tertiary outline-focus-ring hover:text-tertiary_hover focus-visible:rounded focus-visible:outline-2 focus-visible:outline-offset-2"
                            >
                                {item.label}
                            </a>
                        </li>
                    ))}
                    <li>
                        <a
                            href="/feed.xml"
                            className="flex items-center gap-1.5 text-md font-semibold text-tertiary outline-focus-ring hover:text-tertiary_hover focus-visible:rounded focus-visible:outline-2 focus-visible:outline-offset-2"
                        >
                            <Rss01 aria-hidden="true" className="size-4" />
                            RSS
                        </a>
                    </li>
                    {site.socials.map((social) => {
                        const Icon = SOCIAL_ICONS[social.kind as keyof typeof SOCIAL_ICONS];
                        return (
                            <li key={social.href}>
                                <a
                                    href={social.href}
                                    rel="me noopener noreferrer"
                                    target="_blank"
                                    aria-label={social.label}
                                    className="text-fg-quaternary hover:text-fg-quaternary_hover"
                                >
                                    {Icon ? <Icon size={20} /> : social.label}
                                </a>
                            </li>
                        );
                    })}
                </ul>
            </nav>
        </div>
    </footer>
);
