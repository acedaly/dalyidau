// Portal navigation, adapted from Untitled UI PRO "sidebar-sections-subheadings": grouped items with
// subheadings, a fixed desktop sidebar and a slide-in drawer on mobile. Changes from the original:
// our own logo and items, items filtered by role and feature flags, and an account footer built from
// AvatarLabelGroup in place of the demo account switcher (which loads remote avatars).
import type { FC, HTMLAttributes } from "react";
import {
    Archive,
    BarChartSquare02,
    BookOpen01,
    Building07,
    Calendar,
    CalendarCheck01,
    CalendarDate,
    CheckDone01,
    ClipboardCheck,
    Clock,
    X as CloseIcon,
    Compass03,
    File06,
    FolderClosed,
    Globe02,
    HeartRounded,
    HomeLine,
    Inbox01,
    LayersThree01,
    LayoutGrid01,
    LogOut01,
    Mail01,
    Menu02,
    Receipt,
    SearchLg,
    Settings01,
    ShieldTick,
    Star01,
    Trash01,
    Users01,
    Wallet02,
} from "@untitledui/icons";
import {
    Button as AriaButton,
    Dialog as AriaDialog,
    DialogTrigger as AriaDialogTrigger,
    Modal as AriaModal,
    ModalOverlay as AriaModalOverlay,
} from "react-aria-components";
import { NavItemBase } from "@/components/application/app-navigation/base-components/nav-item";
import { AvatarLabelGroup } from "@/components/base/avatar/avatar-label-group";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { ThemeToggle } from "@/components/site/theme-toggle";
import { site } from "@/content/site";
import { initials } from "@/portal/lib/format";
import { usePortal } from "@/portal/portal-context";
import { type ApplicationIcon, type NavigationIcon, applicationForPath } from "@/shared/portal/applications";
import type { FlagKey } from "@/shared/portal/flags";
import { ROLE_LABELS } from "@/shared/portal/permissions";
import type { Permission } from "@/shared/portal/permissions";
import { cx } from "@/utils/cx";

interface NavEntry {
    label: string;
    href: string;
    icon: FC<HTMLAttributes<HTMLOrSVGElement>>;
    permission?: Permission;
    flag?: FlagKey;
    active?: "exact" | "prefix";
}

const ICONS: Record<NavigationIcon, FC<HTMLAttributes<HTMLOrSVGElement>>> = {
    dashboard: BarChartSquare02,
    guests: Users01,
    households: Building07,
    rsvps: CalendarCheck01,
    events: Calendar,
    communications: Mail01,
    invitations: Mail01,
    website: Globe02,
    seating: LayoutGrid01,
    catering: Receipt,
    tasks: CheckDone01,
    timeline: Clock,
    budget: Wallet02,
    suppliers: ClipboardCheck,
    settings: Settings01,
    home: HomeLine,
    inbox: Inbox01,
    knowledge: BookOpen01,
    search: SearchLg,
    types: LayersThree01,
    archive: Archive,
    trash: Trash01,
    daily: CalendarDate,
    favourites: Star01,
    collections: FolderClosed,
    templates: File06,
    discover: Compass03,
};

/** Sections a page adds to its application's navigation, e.g. Knowledge's favourites and collections. */
export interface ExtraNavSection {
    label: string;
    /** Placed after the application section with this label. */
    after: string;
    items: { label: string; href: string; icon: NavigationIcon }[];
}

const APPLICATION_ICONS: Record<ApplicationIcon, FC<HTMLAttributes<HTMLOrSVGElement>>> = { wedding: HeartRounded, knowledge: BookOpen01 };

/** Knowledge pages show one space at a time; its navigation keeps you in the space you're in. */
const withSpace = (href: string) => {
    if (typeof window === "undefined" || !href.startsWith("/portal/knowledge")) return href;
    const space = new URLSearchParams(window.location.search).get("space");
    return space ? `${href}?space=${encodeURIComponent(space)}` : href;
};

const portalSections = (path: string, extra: ExtraNavSection[]): { label: string; items: NavEntry[] }[] => {
    const application = applicationForPath(path);
    return [
        {
            label: "Applications",
            items: [{ label: "All Applications", href: "/portal", icon: LayoutGrid01 }],
        },
        ...(application
            ? application.navigation.flatMap((section) => [
                  { label: section.label, items: section.items.map((item) => ({ ...item, icon: ICONS[item.icon] })) },
                  ...extra
                      .filter((e) => e.after === section.label && e.items.length)
                      .map((e) => ({ label: e.label, items: e.items.map((item) => ({ ...item, icon: ICONS[item.icon] })) })),
              ])
            : []),
        {
            label: "Portal",
            items: [
                { label: "Portal settings", href: "/portal/settings", icon: Settings01, active: "prefix" },
                { label: "Audit log", href: "/portal/audit", icon: ShieldTick, permission: "portal.audit.view" },
            ],
        },
    ];
};

const SIDEBAR_WIDTH = 280;

const Logo = ({ path }: { path: string }) => {
    const application = applicationForPath(path);
    return (
        <a
            href="/portal"
            aria-label="All Applications"
            className="group flex items-center gap-2.5 rounded-lg outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-4"
        >
            <span
                aria-hidden="true"
                className="flex size-8 items-center justify-center rounded-lg bg-brand-solid text-xs font-bold tracking-wide text-white shadow-xs-skeuomorphic"
            >
                {site.shortName}
            </span>
            <span className="flex flex-col leading-tight">
                <span className="text-sm font-semibold text-primary">Daly Portal</span>
                <span className="text-xs text-tertiary">{application?.name ?? site.name}</span>
            </span>
        </a>
    );
};

const SidebarContent = ({ path, extra }: { path: string; extra: ExtraNavSection[] }) => {
    const { user, can, isOn } = usePortal();
    const displayName = user.name ?? user.email.split("@")[0];
    const application = applicationForPath(path);
    const ActiveIcon = application ? APPLICATION_ICONS[application.icon] : HeartRounded;
    const sections = portalSections(path, extra);

    return (
        <aside
            style={{ "--width": `${SIDEBAR_WIDTH}px` } as React.CSSProperties}
            className="flex h-full w-full max-w-full flex-col justify-between overflow-auto bg-primary pt-4 shadow-xs ring-secondary ring-inset lg:w-(--width) lg:rounded-xl lg:ring-1"
        >
            <div className="flex items-center justify-between gap-5 px-4 lg:pl-5">
                <Logo path={path} />
            </div>

            {application && (
                <div className="mx-4 mt-5 flex items-center gap-3 rounded-lg bg-brand-primary px-3 py-2.5 ring-1 ring-brand_alt ring-inset">
                    <ActiveIcon aria-hidden="true" className="size-5 shrink-0 text-fg-brand-primary" />
                    <span className="min-w-0">
                        <span className="block text-xs font-medium text-brand-secondary">Active application</span>
                        <span className="block truncate text-sm font-semibold text-primary">{application.name}</span>
                    </span>
                </div>
            )}

            <nav aria-label="Portal" className="mt-6 md:mt-5">
                <ul>
                    {sections.map((section) => {
                        const items = section.items.filter((item) => (!item.permission || can(item.permission)) && (!item.flag || isOn(item.flag)));
                        if (items.length === 0) return null;
                        return (
                            <li key={section.label}>
                                <div className="px-5 pb-1">
                                    <p className="text-xs font-bold text-quaternary uppercase">{section.label}</p>
                                </div>
                                <ul className="px-4 pb-5">
                                    {items.map((item) => (
                                        <li key={item.href} className="py-0.25">
                                            <NavItemBase
                                                icon={item.icon}
                                                href={item.href.includes("?") ? item.href : withSpace(item.href)}
                                                type="link"
                                                current={item.href === path || (item.active === "prefix" && path.startsWith(`${item.href}/`))}
                                            >
                                                {item.label}
                                            </NavItemBase>
                                        </li>
                                    ))}
                                </ul>
                            </li>
                        );
                    })}
                </ul>
            </nav>

            <div className="mt-auto flex items-center gap-2 border-t border-secondary px-4 py-4">
                <AvatarLabelGroup size="sm" initials={initials(displayName)} title={displayName} subtitle={`${ROLE_LABELS[user.role].label} · ${user.email}`} />
                <ThemeToggle className="shrink-0" />
                <ButtonUtility size="sm" color="tertiary" tooltip="Sign out" icon={LogOut01} href="/cdn-cgi/access/logout" />
            </div>
        </aside>
    );
};

export const PortalSidebar = ({ path, extra = [] }: { path: string; extra?: ExtraNavSection[] }) => (
    <>
        {/* Mobile header and drawer */}
        <AriaDialogTrigger>
            <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-secondary bg-primary p-3 pl-4 lg:hidden">
                <Logo path={path} />
                <AriaButton
                    aria-label="Open navigation"
                    className="group flex items-center justify-center rounded-lg bg-primary p-2 text-fg-secondary outline-focus-ring hover:bg-primary_hover hover:text-fg-secondary_hover focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                    <Menu02 className="size-6" />
                </AriaButton>
            </header>
            <AriaModalOverlay
                isDismissable
                className={({ isEntering, isExiting }) =>
                    cx(
                        "fixed inset-0 z-50 cursor-pointer bg-overlay/70 pr-16 backdrop-blur-md lg:hidden",
                        isEntering && "duration-300 ease-in-out animate-in fade-in",
                        isExiting && "duration-200 ease-in-out animate-out fade-out",
                    )
                }
            >
                {({ state }) => (
                    <>
                        <AriaButton
                            aria-label="Close navigation"
                            onPress={() => state.close()}
                            className="fixed top-2.5 right-3 flex cursor-pointer items-center justify-center rounded-lg p-2 text-fg-white/70 outline-focus-ring hover:bg-white/10 hover:text-fg-white focus-visible:outline-2 focus-visible:outline-offset-2"
                        >
                            <CloseIcon className="size-6" />
                        </AriaButton>
                        <AriaModal className="w-full max-w-74 cursor-auto will-change-transform">
                            <AriaDialog aria-label="Navigation" className="h-dvh outline-hidden focus:outline-hidden">
                                <SidebarContent path={path} extra={extra} />
                            </AriaDialog>
                        </AriaModal>
                    </>
                )}
            </AriaModalOverlay>
        </AriaDialogTrigger>

        {/* Desktop sidebar */}
        <div className="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:z-30 lg:flex lg:py-1 lg:pl-1">
            <SidebarContent path={path} extra={extra} />
        </div>
        {/* Reserves the sidebar's width, because the real sidebar is fixed. */}
        <div style={{ paddingLeft: SIDEBAR_WIDTH + 4 }} className="invisible hidden lg:sticky lg:top-0 lg:bottom-0 lg:left-0 lg:block" />
    </>
);
