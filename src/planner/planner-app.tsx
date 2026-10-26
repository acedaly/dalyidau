// Wedding Planner: the installable phone app for the wedding (docs/PLANNER.md). A calm, single
// column of cards with tabs at the bottom, over the same API, roles and audit log as the portal.
import { ToastProvider } from "@/portal/components/toast";
import { PortalProvider } from "@/portal/portal-context";
import { ThemeProvider } from "@/providers/theme-provider";
import type { PlannerPageData, PlannerView } from "@/shared/planner/types";
import { NavigationProvider, PlannerHeader, PlannerNavigation, useNavigation } from "./navigation";
import { BudgetView } from "./views/budget-view";
import { GuestsView } from "./views/guests-view";
import { HomeView } from "./views/home-view";
import { MoreView, SeatingView, SuppliersView, TimelineView } from "./views/more-view";
import { TasksView } from "./views/tasks-view";

const VIEWS: Record<PlannerView, () => React.ReactNode> = {
    home: HomeView,
    guests: GuestsView,
    tasks: TasksView,
    budget: BudgetView,
    more: MoreView,
    seating: SeatingView,
    timeline: TimelineView,
    suppliers: SuppliersView,
};

const CurrentView = () => {
    const { view } = useNavigation();
    const View = VIEWS[view];
    return <View />;
};

export const PlannerApp = ({ data }: { data: PlannerPageData }) => (
    <ThemeProvider>
        <PortalProvider value={data.context}>
            <ToastProvider>
                <NavigationProvider initial={data.view} base={data.base} portalUrl={data.portalUrl}>
                    <a
                        href="#main"
                        className="sr-only z-50 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary shadow-lg ring-1 ring-primary focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
                    >
                        Skip to content
                    </a>
                    <div className="min-h-dvh bg-secondary_alt md:pl-60">
                        <PlannerHeader />
                        <PlannerNavigation />
                        {data.context.environment !== "production" && (
                            <p className="bg-warning-primary px-4 py-2 text-xs font-medium text-warning-primary">
                                {data.context.environment} environment: changes here don't affect the live data.
                            </p>
                        )}
                        <main
                            id="main"
                            className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 pt-2 pb-[calc(6rem+env(safe-area-inset-bottom))] md:px-8 md:pt-8 md:pb-12"
                        >
                            <CurrentView />
                        </main>
                    </div>
                </NavigationProvider>
            </ToastProvider>
        </PortalProvider>
    </ThemeProvider>
);
