import { Mail01, Rss01 } from "@untitledui/icons";
import { GitHub, Instagram, LinkedIn, X, YouTube } from "@/components/foundations/social-icons";
import { FooterSmall01 } from "@/components/marketing/footers/footer-small-01";
import { SiteLogo } from "@/components/site/site-logo";
import { useSite } from "@/providers/site-content";
import { usePreviewHref, useSiteFrame } from "@/providers/site-frame";
import { projectsMenus } from "@/shared/site-content";

const SOCIAL_ICONS = { github: GitHub, linkedin: LinkedIn, x: X, instagram: Instagram, youtube: YouTube } as const;

/** The projects-first design's footer: the wordmark and a line, the menu, the ways to follow along. */
const ProjectsFooter = () => {
    const site = useSite();
    const href = usePreviewHref();
    // The header's menu again (without Wedding), closed by Contact, which lives here and not in the header.
    const nav = projectsMenus(site.nav, false).footer;
    return (
        <footer className="border-t border-secondary">
            <div className="mx-auto flex max-w-container flex-col gap-10 px-4 py-12 md:px-8 md:py-16">
                <div className="flex flex-col gap-8 md:flex-row md:items-start md:justify-between">
                    <div className="flex max-w-sm flex-col gap-3">
                        <SiteLogo />
                        <p className="text-md text-tertiary">{site.description}</p>
                    </div>
                    <nav aria-label="Footer">
                        <ul className="grid grid-cols-2 gap-x-10 gap-y-3 sm:flex sm:gap-8">
                            {nav.map((item) => (
                                <li key={item.href}>
                                    <a
                                        href={href(item.href)}
                                        className="v2-link rounded-xs text-md font-medium text-secondary outline-focus-ring hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2"
                                    >
                                        {item.label}
                                    </a>
                                </li>
                            ))}
                        </ul>
                    </nav>
                </div>
                <div className="flex flex-col gap-4 border-t border-secondary pt-6 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-sm text-quaternary">
                        © {new Date().getFullYear()} {site.footerText ?? site.name}
                    </p>
                    <ul className="flex items-center gap-5" aria-label="Elsewhere">
                        {site.email && (
                            <li>
                                <a
                                    href={`mailto:${site.email}`}
                                    aria-label={`Email ${site.email}`}
                                    className="block rounded-xs text-fg-quaternary outline-focus-ring hover:text-fg-quaternary_hover focus-visible:outline-2 focus-visible:outline-offset-2"
                                >
                                    <Mail01 aria-hidden="true" className="size-5" />
                                </a>
                            </li>
                        )}
                        <li>
                            <a
                                href="/feed.xml"
                                aria-label="RSS feed"
                                className="block rounded-xs text-fg-quaternary outline-focus-ring hover:text-fg-quaternary_hover focus-visible:outline-2 focus-visible:outline-offset-2"
                            >
                                <Rss01 aria-hidden="true" className="size-5" />
                            </a>
                        </li>
                        {site.socials.map((social) => {
                            const Icon = SOCIAL_ICONS[social.kind];
                            return (
                                <li key={social.href}>
                                    <a
                                        href={social.href}
                                        rel="me noopener noreferrer"
                                        target="_blank"
                                        aria-label={social.label}
                                        className="block rounded-xs text-fg-quaternary outline-focus-ring hover:text-fg-quaternary_hover focus-visible:outline-2 focus-visible:outline-offset-2"
                                    >
                                        <Icon size={20} />
                                    </a>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            </div>
        </footer>
    );
};

export const SiteFooter = () => (useSiteFrame().projects ? <ProjectsFooter /> : <FooterSmall01 />);
