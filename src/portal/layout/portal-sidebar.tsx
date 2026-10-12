// Portal navigation, adapted from Untitled UI PRO "sidebar-sections-subheadings": grouped items with
// subheadings, a fixed desktop sidebar and a slide-in drawer on mobile. Changes from the original:
// our own logo and items, items filtered by role and feature flags, and an account footer built from
// AvatarLabelGroup in place of the demo account switcher (which loads remote avatars).
import type { FC, HTMLAttributes } from "react";
import {
    BarChartSquare02,
    Building07,
    Calendar,
    CalendarCheck01,
    CheckDone01,
    ClipboardCheck,
    Clock,
    X as CloseIcon,
    Globe02,
    LayoutGrid01,
    LogOut01,
    Mail01,
    Menu02,
    Receipt,
    Settings01,
    ShieldTick,
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
    /** Extra paths that should highlight this item. */
    match?: RegExp;
}

const SECTIONS: { label: string; items: NavEntry[] }[] = [
    {
        label: "Wedding",
        items: [
            { label: "Dashboard", href: "/portal/wedding", icon: BarChartSquare02 },
            { label: "Guests", href: "/portal/wedding/guests", icon: Users01 },
            { label: "Households", href: "/portal/wedding/households", icon: Building07 },
            { label: "RSVPs", href: "/portal/wedding/rsvps", icon: CalendarCheck01 },
            { label: "Events", href: "/portal/wedding/events", icon: Calendar },
            {
                label: "Communications",
                href: "/portal/wedding/communications",
                icon: Mail01,
                flag: "module.communications",
                match: /^\/portal\/wedding\/communications/,
            },
            { label: "Website", href: "/portal/wedding/website", icon: Globe02 },
        ],
    },
    {
        label: "Planning",
        items: [
            { label: "Seating", href: "/portal/wedding/seating", icon: LayoutGrid01, flag: "module.planning" },
            { label: "Catering", href: "/portal/wedding/catering", icon: Receipt, flag: "module.planning" },
            { label: "Tasks", href: "/portal/wedding/tasks", icon: CheckDone01, flag: "module.planning" },
            { label: "Timeline", href: "/portal/wedding/timeline", icon: Clock, flag: "module.planning" },
            { label: "Budget", href: "/portal/wedding/budget", icon: Wallet02, flag: "module.budget", permission: "wedding.budget.view" },
            { label: "Suppliers", href: "/portal/wedding/suppliers", icon: ClipboardCheck, flag: "module.budget", permission: "wedding.budget.view" },
        ],
    },
    {
        label: "Portal",
        items: [
            { label: "Settings", href: "/portal/settings", icon: Settings01, match: /^\/portal\/settings/ },
            { label: "Audit log", href: "/portal/audit", icon: ShieldTick, permission: "portal.audit.view" },
        ],
    },
];

const SIDEBAR_WIDTH = 280;

const Logo = () => (
    <a href="/portal/wedding" className="group flex items-center gap-2.5 rounded-lg outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-4">
        <span
            aria-hidden="true"
            className="flex size-8 items-center justify-center rounded-lg bg-brand-solid text-xs font-bold tracking-wide text-white shadow-xs-skeuomorphic"
        >
            {site.shortName}
        </span>
        <span className="flex flex-col leading-tight">
            <span className="text-sm font-semibold text-primary">Wedding portal</span>
            <span className="text-xs text-tertiary">{site.name}</span>
        </span>
    </a>
);

const SidebarContent = ({ path }: { path: string }) => {
    const { user, can, isOn } = usePortal();
    const displayName = user.name ?? user.email.split("@")[0];

    return (
        <aside
            style={{ "--width": `${SIDEBAR_WIDTH}px` } as React.CSSProperties}
            className="flex h-full w-full max-w-full flex-col justify-between overflow-auto bg-primary pt-4 shadow-xs ring-secondary ring-inset lg:w-(--width) lg:rounded-xl lg:ring-1"
        >
            <div className="flex items-center justify-between gap-5 px-4 lg:pl-5">
                <Logo />
            </div>

            <nav aria-label="Portal" className="mt-6 md:mt-5">
                <ul>
                    {SECTIONS.map((section) => {
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
                                            <NavItemBase icon={item.icon} href={item.href} type="link" current={item.href === path || !!item.match?.test(path)}>
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

export const PortalSidebar = ({ path }: { path: string }) => (
    <>
        {/* Mobile header and drawer */}
        <AriaDialogTrigger>
            <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-secondary bg-primary p-3 pl-4 lg:hidden">
                <Logo />
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
                                <SidebarContent path={path} />
                            </AriaDialog>
                        </AriaModal>
                    </>
                )}
            </AriaModalOverlay>
        </AriaDialogTrigger>

        {/* Desktop sidebar */}
        <div className="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:z-30 lg:flex lg:py-1 lg:pl-1">
            <SidebarContent path={path} />
        </div>
        {/* Reserves the sidebar's width, because the real sidebar is fixed. */}
        <div style={{ paddingLeft: SIDEBAR_WIDTH + 4 }} className="invisible hidden lg:sticky lg:top-0 lg:bottom-0 lg:left-0 lg:block" />
    </>
);
