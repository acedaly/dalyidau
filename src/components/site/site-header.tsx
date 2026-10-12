import { useRef } from "react";
import { Button as AriaButton, Dialog as AriaDialog, DialogTrigger as AriaDialogTrigger, Popover as AriaPopover } from "react-aria-components";
import { Button } from "@/components/base/buttons/button";
import { SiteLogo } from "@/components/site/site-logo";
import { ThemeToggle } from "@/components/site/theme-toggle";
import { site } from "@/content/site";
import { cx } from "@/utils/cx";

const isActive = (href: string, path: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));

// Adapted from the Untitled UI marketing header navigation.
export const SiteHeader = ({ path, weddingPublished }: { path: string; weddingPublished: boolean }) => {
    const headerRef = useRef<HTMLElement>(null);
    const navigation = weddingPublished ? [...site.nav, { label: "Wedding", href: "/wedding" }] : site.nav;

    return (
        <header
            ref={headerRef}
            className="sticky top-0 z-40 flex h-16 w-full items-center justify-center border-b border-secondary bg-primary/85 backdrop-blur-md max-md:has-aria-expanded:bg-primary md:h-18"
        >
            <div className="flex size-full max-w-container flex-1 items-center justify-between gap-4 pr-2 pl-4 md:px-8">
                <SiteLogo />

                <nav aria-label="Main" className="max-md:hidden">
                    <ul className="flex items-center gap-1">
                        {navigation.map((item) => {
                            const active = isActive(item.href, path);
                            return (
                                <li key={item.href}>
                                    <a
                                        href={item.href}
                                        aria-current={active ? "page" : undefined}
                                        className={cx(
                                            "flex rounded-lg px-3 py-2 text-md font-semibold outline-focus-ring transition duration-100 ease-linear hover:bg-primary_hover focus-visible:outline-2 focus-visible:outline-offset-2",
                                            active ? "text-primary" : "text-tertiary hover:text-secondary_hover",
                                        )}
                                    >
                                        {item.label}
                                    </a>
                                </li>
                            );
                        })}
                    </ul>
                </nav>

                <div className="flex items-center gap-1">
                    <ThemeToggle />

                    {/* Mobile menu */}
                    <AriaDialogTrigger>
                        <AriaButton
                            aria-label="Open navigation menu"
                            className={({ isFocusVisible, isHovered }) =>
                                cx(
                                    "group cursor-pointer rounded-lg p-2 md:hidden",
                                    isHovered && "bg-primary_hover",
                                    isFocusVisible && "outline-2 outline-offset-2 outline-focus-ring",
                                )
                            }
                        >
                            <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none">
                                <path
                                    className="hidden text-secondary group-aria-expanded:block"
                                    d="M18 6L6 18M6 6L18 18"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                />
                                <path
                                    className="text-secondary group-aria-expanded:hidden"
                                    d="M3 12H21M3 6H21M3 18H21"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                />
                            </svg>
                        </AriaButton>
                        <AriaPopover
                            triggerRef={headerRef}
                            className="w-full overflow-y-auto shadow-lg duration-150 ease-out md:hidden entering:animate-in entering:fade-in entering:slide-in-from-top-1"
                            offset={0}
                            containerPadding={0}
                            placement="bottom left"
                        >
                            <AriaDialog aria-label="Navigation" className="outline-hidden">
                                <nav aria-label="Mobile" className="w-full border-b border-secondary bg-primary">
                                    <ul className="flex flex-col gap-0.5 py-3">
                                        {navigation.map((item) => (
                                            <li key={item.href}>
                                                <a
                                                    href={item.href}
                                                    aria-current={isActive(item.href, path) ? "page" : undefined}
                                                    className="flex items-center px-4 py-3 text-md font-semibold text-primary outline-focus-ring hover:bg-primary_hover focus-visible:outline-2 focus-visible:-outline-offset-2 aria-[current=page]:text-brand-secondary"
                                                >
                                                    {item.label}
                                                </a>
                                            </li>
                                        ))}
                                    </ul>
                                    {site.email && (
                                        <div className="border-t border-secondary px-4 py-5">
                                            <Button href={`mailto:${site.email}`} color="secondary" size="lg" className="w-full">
                                                Get in touch
                                            </Button>
                                        </div>
                                    )}
                                </nav>
                            </AriaDialog>
                        </AriaPopover>
                    </AriaDialogTrigger>
                </div>
            </div>
        </header>
    );
};
