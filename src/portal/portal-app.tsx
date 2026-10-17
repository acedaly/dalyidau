import { ToastProvider } from "@/portal/components/toast";
import { KnowledgeCollectionPage } from "@/portal/knowledge/pages/knowledge-collection-page";
import { KnowledgeCollectionsPage } from "@/portal/knowledge/pages/knowledge-collections-page";
import { KnowledgeDailyPage } from "@/portal/knowledge/pages/knowledge-daily-page";
import { KnowledgeDiscoverPage } from "@/portal/knowledge/pages/knowledge-discover-page";
import { KnowledgeFavouritesPage } from "@/portal/knowledge/pages/knowledge-favourites-page";
import { KnowledgeHomePage } from "@/portal/knowledge/pages/knowledge-home-page";
import { KnowledgeListPage } from "@/portal/knowledge/pages/knowledge-list-page";
import { KnowledgeObjectPage } from "@/portal/knowledge/pages/knowledge-object-page";
import { KnowledgeSearchPage } from "@/portal/knowledge/pages/knowledge-search-page";
import { KnowledgeSettingsPage } from "@/portal/knowledge/pages/knowledge-settings-page";
import { KnowledgeTemplatePage } from "@/portal/knowledge/pages/knowledge-template-page";
import { KnowledgeTemplatesPage } from "@/portal/knowledge/pages/knowledge-templates-page";
import { KnowledgeTypesPage } from "@/portal/knowledge/pages/knowledge-types-page";
import { type ExtraNavSection, PortalSidebar } from "@/portal/layout/portal-sidebar";
import { AuditPage } from "@/portal/pages/audit-page";
import { BudgetPage } from "@/portal/pages/budget-page";
import { CateringPage } from "@/portal/pages/catering-page";
import { CommunicationsPage } from "@/portal/pages/communications-page";
import { DashboardPage } from "@/portal/pages/dashboard-page";
import { EventsPage } from "@/portal/pages/events-page";
import { GuestImportPage } from "@/portal/pages/guest-import-page";
import { GuestsPage } from "@/portal/pages/guests-page";
import { HouseholdsPage } from "@/portal/pages/households-page";
import { InvitationStudioPage } from "@/portal/pages/invitation-studio-page";
import { MessagePage } from "@/portal/pages/message-page";
import { PortalHomePage } from "@/portal/pages/portal-home-page";
import { PortalSettingsPage } from "@/portal/pages/portal-settings-page";
import { ProviderSettingsPage } from "@/portal/pages/provider-settings-page";
import { RsvpsPage } from "@/portal/pages/rsvps-page";
import { SeatingPage } from "@/portal/pages/seating-page";
import { WeddingSettingsPage } from "@/portal/pages/settings-page";
import { ForbiddenPage, NotFoundPage } from "@/portal/pages/status-pages";
import { SuppliersPage } from "@/portal/pages/suppliers-page";
import { TasksPage } from "@/portal/pages/tasks-page";
import { TextsPage } from "@/portal/pages/texts-page";
import { TimelinePage } from "@/portal/pages/timeline-page";
import { WebsitePage } from "@/portal/pages/website-page";
import { PortalProvider } from "@/portal/portal-context";
import { TasksCompletedPage } from "@/portal/tasks/pages/tasks-completed-page";
import { TasksFiltersPage } from "@/portal/tasks/pages/tasks-filters-page";
import { TasksLabelsPage } from "@/portal/tasks/pages/tasks-labels-page";
import { TasksActivityPage, TasksSearchPage, TasksSettingsPage } from "@/portal/tasks/pages/tasks-misc-pages";
import { TasksProjectPage } from "@/portal/tasks/pages/tasks-project-page";
import { TasksProjectsPage } from "@/portal/tasks/pages/tasks-projects-page";
import { TasksUpcomingPage } from "@/portal/tasks/pages/tasks-upcoming-page";
import { TasksViewPage } from "@/portal/tasks/pages/tasks-view-page";
import { ThemeProvider } from "@/providers/theme-provider";
import type { PortalPageData } from "@/shared/portal/types";

const Page = ({ data }: { data: PortalPageData }) => {
    switch (data.route) {
        case "portal-home":
            return <PortalHomePage data={data} />;
        case "dashboard":
            return <DashboardPage data={data} />;
        case "guests":
            return <GuestsPage data={data} />;
        case "guest-import":
            return <GuestImportPage data={data} />;
        case "households":
            return <HouseholdsPage data={data} />;
        case "events":
            return <EventsPage data={data} />;
        case "rsvps":
            return <RsvpsPage data={data} />;
        case "communications":
            return <CommunicationsPage data={data} />;
        case "invitation-studio":
            return <InvitationStudioPage data={data} />;
        case "provider-settings":
            return <ProviderSettingsPage data={data} />;
        case "message":
            return <MessagePage data={data} />;
        case "texts":
            return <TextsPage data={data} />;
        case "tasks":
            return <TasksPage data={data} />;
        case "timeline":
            return <TimelinePage data={data} />;
        case "seating":
            return <SeatingPage data={data} />;
        case "catering":
            return <CateringPage data={data} />;
        case "budget":
            return <BudgetPage data={data} />;
        case "suppliers":
            return <SuppliersPage data={data} />;
        case "website":
            return <WebsitePage data={data} />;
        case "wedding-settings":
            return <WeddingSettingsPage data={data} />;
        case "portal-settings":
            return <PortalSettingsPage data={data} />;
        case "audit":
            return <AuditPage data={data} />;
        case "knowledge-home":
            return <KnowledgeHomePage data={data} />;
        case "knowledge-list":
            return <KnowledgeListPage data={data} />;
        case "knowledge-object":
            return <KnowledgeObjectPage key={data.detail.object.id} data={data} />;
        case "knowledge-daily":
            return <KnowledgeDailyPage key={data.date} data={data} />;
        case "knowledge-collections":
            return <KnowledgeCollectionsPage data={data} />;
        case "knowledge-collection":
            return <KnowledgeCollectionPage key={data.collection.id} data={data} />;
        case "knowledge-favourites":
            return <KnowledgeFavouritesPage data={data} />;
        case "knowledge-templates":
            return <KnowledgeTemplatesPage data={data} />;
        case "knowledge-template":
            return <KnowledgeTemplatePage key={data.template.id} data={data} />;
        case "knowledge-discover":
            return <KnowledgeDiscoverPage data={data} />;
        case "knowledge-search":
            return <KnowledgeSearchPage data={data} />;
        case "knowledge-types":
            return <KnowledgeTypesPage data={data} />;
        case "knowledge-settings":
            return <KnowledgeSettingsPage data={data} />;
        case "tasks-view":
            return <TasksViewPage key={data.view} data={data} />;
        case "tasks-upcoming":
            return <TasksUpcomingPage data={data} />;
        case "tasks-completed":
            return <TasksCompletedPage data={data} />;
        case "tasks-project":
            return <TasksProjectPage key={data.project.id} data={data} />;
        case "tasks-projects":
            return <TasksProjectsPage data={data} />;
        case "tasks-labels":
            return <TasksLabelsPage data={data} />;
        case "tasks-filters":
            return <TasksFiltersPage data={data} />;
        case "tasks-search":
            return <TasksSearchPage data={data} />;
        case "tasks-activity":
            return <TasksActivityPage data={data} />;
        case "tasks-settings":
            return <TasksSettingsPage data={data} />;
        case "forbidden":
            return <ForbiddenPage message={data.message} />;
        default:
            return <NotFoundPage />;
    }
};

/** Knowledge pages add the space's own favourites and collections to the navigation; Tasks pages add active projects. */
const extraNavigation = (data: PortalPageData): ExtraNavSection[] => {
    if (data.route.startsWith("tasks-") && "inboxId" in data) {
        const active = data.projects.filter((p) => !p.isInbox && p.status === "active").slice(0, 10);
        return [
            { label: "Projects", after: "Organise", items: active.map((p) => ({ label: p.name, href: `/portal/tasks/p/${p.id}`, icon: "project" as const })) },
        ];
    }
    if (!("nav" in data) || !data.nav) return [];
    const MAX = 6;
    return [
        {
            label: "Favourites",
            after: "Knowledge",
            items: data.nav.favourites
                .slice(0, MAX)
                .map((f) => ({ label: f.title || "Untitled", href: `/portal/knowledge/o/${f.id}`, icon: "favourites" as const })),
        },
        {
            label: "Collections",
            after: "Library",
            items: data.nav.collections.slice(0, MAX).map((c) => ({ label: c.name, href: `/portal/knowledge/c/${c.id}`, icon: "collections" as const })),
        },
    ];
};

export const PortalApp = ({ data, path }: { data: PortalPageData; path: string }) => (
    <ThemeProvider>
        <PortalProvider value={data.context}>
            <ToastProvider>
                <a
                    href="#main"
                    className="sr-only z-50 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary shadow-lg ring-1 ring-primary focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
                >
                    Skip to content
                </a>
                <div className="flex min-h-dvh flex-col bg-primary lg:flex-row lg:bg-secondary print:block print:bg-primary">
                    <div className="contents print:hidden">
                        <PortalSidebar path={path} extra={extraNavigation(data)} />
                    </div>
                    <main id="main" className="min-w-0 flex-1 lg:pt-1 lg:pr-1 lg:pb-1 print:p-0">
                        <div className="min-h-full bg-primary lg:rounded-xl lg:shadow-xs lg:ring-1 lg:ring-secondary print:shadow-none print:ring-0">
                            {data.context.environment !== "production" && (
                                <p className="border-b border-secondary bg-warning-primary px-4 py-2 text-xs font-medium text-warning-primary lg:rounded-t-xl lg:px-8 print:hidden">
                                    {data.context.environment} environment: changes here don't affect the live data.
                                </p>
                            )}
                            <div className="mx-auto flex w-full max-w-container flex-col gap-8 px-4 py-8 lg:px-8 lg:pt-8 lg:pb-12 print:max-w-none print:p-0">
                                <Page data={data} />
                            </div>
                        </div>
                    </main>
                </div>
            </ToastProvider>
        </PortalProvider>
    </ThemeProvider>
);
