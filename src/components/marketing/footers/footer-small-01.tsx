import { Rss01 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { GitHub, Instagram, LinkedIn, X, YouTube } from "@/components/foundations/social-icons";
import { SiteLogo } from "@/components/site/site-logo";
import { site } from "@/content/site";

const SOCIAL_ICONS = { github: GitHub, linkedin: LinkedIn, x: X, instagram: Instagram, youtube: YouTube } as const;

// Untitled UI PRO "footer-small-01": logo, a single row of links and the copyright line.
export const FooterSmall01 = () => {
    return (
        <footer className="border-t border-secondary bg-primary py-10 md:py-12">
            <div className="mx-auto max-w-container px-4 md:px-8">
                <div className="flex flex-col justify-between gap-8 lg:flex-row lg:items-center">
                    <div className="lg:w-48">
                        <SiteLogo />
                    </div>
                    <nav aria-label="Footer">
                        <ul className="grid grid-cols-2 gap-x-8 gap-y-3 sm:flex sm:flex-wrap sm:items-center">
                            {site.nav.map((item) => (
                                <li key={item.href} className="flex">
                                    <Button color="link-gray" size="md" href={item.href} className="max-h-5">
                                        {item.label}
                                    </Button>
                                </li>
                            ))}
                            <li className="flex">
                                <Button color="link-gray" size="md" href="/feed.xml" iconLeading={Rss01} className="max-h-5">
                                    RSS
                                </Button>
                            </li>
                            {site.socials.map((social) => {
                                const Icon = SOCIAL_ICONS[social.kind];
                                return (
                                    <li key={social.href} className="flex">
                                        <a
                                            href={social.href}
                                            rel="me noopener noreferrer"
                                            target="_blank"
                                            aria-label={social.label}
                                            className="rounded-xs text-fg-quaternary outline-focus-ring hover:text-fg-quaternary_hover focus-visible:outline-2 focus-visible:outline-offset-2"
                                        >
                                            <Icon size={20} />
                                        </a>
                                    </li>
                                );
                            })}
                        </ul>
                    </nav>
                    <p className="text-sm text-quaternary lg:w-48 lg:text-right">
                        © {new Date().getFullYear()} {site.name}
                    </p>
                </div>
            </div>
        </footer>
    );
};
