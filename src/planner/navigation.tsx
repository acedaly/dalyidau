// Wedding Planner's navigation: five tabs, at the bottom on phones (where thumbs are) and down the
// side from md up, in the manner of Untitled UI's nav items. Views change without a page load, but
// each has its own address, so links, the back button and the app's shortcuts all work.
import type { FC, ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { CheckDone01, DotsHorizontal, HeartRounded, Home02, LogOut01, Users01, Wallet02 } from "@untitledui/icons";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { ThemeToggle } from "@/components/site/theme-toggle";
import { usePortal } from "@/portal/portal-context";
import { PLANNER_VIEWS, type PlannerView } from "@/shared/planner/types";
import { cx } from "@/utils/cx";

interface NavigationValue {
    view: PlannerView;
    base: string;
    portalUrl: string;
    href: (view: PlannerView) => string;
    go: (view: PlannerView) => void;
}

const Context = createContext<NavigationValue | null>(null);

export const useNavigation = () => {
    const value = useContext(Context);
    if (!value) throw new Error("useNavigation must be used inside NavigationProvider");
    return value;
};

const viewFromPath = (path: string, base: string): PlannerView => {
    const rest = path.slice(base.length).replace(/^\//, "");
    return (PLANNER_VIEWS as readonly string[]).includes(rest) ? (rest as PlannerView) : "home";
};

export const NavigationProvider = ({ initial, base, portalUrl, children }: { initial: PlannerView; base: string; portalUrl: string; children: ReactNode }) => {
    const [view, setView] = useState(initial);
    const href = useCallback((target: PlannerView) => (target === "home" ? base || "/" : `${base}/${target}`), [base]);
    const go = useCallback(
        (target: PlannerView) => {
            if (target !== view) window.history.pushState(null, "", href(target));
            setView(target);
            window.scrollTo({ top: 0 });
        },
        [href, view],
    );
    useEffect(() => {
        const onPop = () => setView(viewFromPath(window.location.pathname, base));
        window.addEventListener("popstate", onPop);
        return () => window.removeEventListener("popstate", onPop);
    }, [base]);
    const value = useMemo(() => ({ view, base, portalUrl, href, go }), [view, base, portalUrl, href, go]);
    return <Context.Provider value={value}>{children}</Context.Provider>;
};

interface Tab {
    view: PlannerView;
    label: string;
    icon: FC<{ className?: string }>;
    /** Views reached from this tab that keep it highlighted. */
    includes?: PlannerView[];
}

export const useTabs = (): Tab[] => {
    const { can, isOn } = usePortal();
    return [
        { view: "home", label: "Home", icon: Home02 },
        { view: "guests", label: "Guests", icon: Users01 },
        ...(isOn("module.planning") ? [{ view: "tasks" as const, label: "Tasks", icon: CheckDone01 }] : []),
        ...(isOn("module.budget") && can("wedding.budget.view") ? [{ view: "budget" as const, label: "Budget", icon: Wallet02 }] : []),
        { view: "more", label: "More", icon: DotsHorizontal, includes: ["seating", "timeline", "suppliers"] },
    ];
};

/** Links that change the view in place, but still work as ordinary links (new tab, long-press). */
const TabLink = ({ tab, current, variant }: { tab: Tab; current: boolean; variant: "bar" | "rail" }) => {
    const { href, go } = useNavigation();
    const Icon = tab.icon;
    return (
        <a
            href={href(tab.view)}
            aria-current={current ? "page" : undefined}
            onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
                event.preventDefault();
                go(tab.view);
            }}
            className={cx(
                "outline-focus-ring transition duration-100 ease-linear focus-visible:outline-2 focus-visible:-outline-offset-2",
                variant === "bar"
                    ? "flex min-h-14 flex-1 flex-col items-center justify-center gap-1 rounded-lg text-xs font-medium"
                    : "flex items-center gap-3 rounded-md px-3 py-2 text-md font-semibold",
                current
                    ? variant === "bar"
                        ? "text-brand-secondary"
                        : "bg-active text-secondary_hover"
                    : variant === "bar"
                      ? "text-quaternary hover:text-tertiary_hover"
                      : "text-secondary hover:bg-primary_hover hover:text-secondary_hover",
            )}
        >
            <Icon
                aria-hidden="true"
                className={cx("size-6 shrink-0", variant === "rail" && "size-5", current ? "text-fg-brand-primary" : "text-fg-quaternary")}
            />
            {tab.label}
        </a>
    );
};

const Mark = () => (
    <span aria-hidden="true" className="flex size-9 items-center justify-center rounded-xl bg-brand-solid text-white shadow-xs-skeuomorphic">
        <HeartRounded className="size-5" />
    </span>
);

/** Bottom bar on phones; a rail beside the content from md up. */
export const PlannerNavigation = () => {
    const tabs = useTabs();
    const { view } = useNavigation();
    const { user } = usePortal();
    const isCurrent = (tab: Tab) => tab.view === view || !!tab.includes?.includes(view);

    return (
        <>
            <nav
                aria-label="Wedding Planner"
                className="fixed inset-x-0 bottom-0 z-40 border-t border-secondary bg-primary/95 px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
            >
                <div className="mx-auto flex max-w-lg items-stretch">
                    {tabs.map((tab) => (
                        <TabLink key={tab.view} tab={tab} current={isCurrent(tab)} variant="bar" />
                    ))}
                </div>
            </nav>

            <aside className="hidden md:fixed md:inset-y-0 md:left-0 md:flex md:w-60 md:flex-col md:gap-6 md:border-r md:border-secondary md:bg-primary md:px-4 md:py-6">
                <div className="flex items-center gap-3 px-1">
                    <Mark />
                    <span className="text-md font-semibold text-primary">Wedding Planner</span>
                </div>
                <nav aria-label="Wedding Planner" className="flex flex-col gap-1">
                    {tabs.map((tab) => (
                        <TabLink key={tab.view} tab={tab} current={isCurrent(tab)} variant="rail" />
                    ))}
                </nav>
                <div className="mt-auto flex items-center gap-2 border-t border-secondary pt-4">
                    <p className="min-w-0 flex-1 truncate text-sm text-tertiary">{user.name ?? user.email}</p>
                    <ThemeToggle className="shrink-0" />
                    <ButtonUtility size="sm" color="tertiary" tooltip="Sign out" icon={LogOut01} href="/cdn-cgi/access/logout" />
                </div>
            </aside>
        </>
    );
};

/** The phone header: the app's mark, and the account controls the rail holds on wider screens. */
export const PlannerHeader = () => (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 bg-secondary_alt/90 px-4 pt-[env(safe-area-inset-top)] backdrop-blur md:hidden">
        <div className="flex items-center gap-2.5">
            <Mark />
            <span className="text-md font-semibold text-primary">Wedding Planner</span>
        </div>
        <ThemeToggle className="shrink-0" />
    </header>
);
