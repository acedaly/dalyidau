import { Plus } from "@untitledui/icons";
import { CalendarCalendarsPage } from "@/portal/calendar/pages/calendar-calendars-page";
import { CalendarFamilyPage } from "@/portal/calendar/pages/calendar-family-page";
import { CalendarHolidaysPage } from "@/portal/calendar/pages/calendar-holidays-page";
import { CalendarPlannerPage } from "@/portal/calendar/pages/calendar-planner-page";
import { CalendarSettingsPage } from "@/portal/calendar/pages/calendar-settings-page";
import { CalendarSubscriptionsPage } from "@/portal/calendar/pages/calendar-subscriptions-page";
import { CalendarViewPage } from "@/portal/calendar/pages/calendar-view-page";
import { CalendarYearPage } from "@/portal/calendar/pages/calendar-year-page";
import { LeavePage } from "@/portal/calendar/pages/leave-page";
import { LeavePlannerPage } from "@/portal/calendar/pages/leave-planner-page";
import { LeaveSettingsPage } from "@/portal/calendar/pages/leave-settings-page";
import { ToastProvider } from "@/portal/components/toast";
import { IntelligenceBriefingPage } from "@/portal/intelligence/pages/intelligence-briefing-page";
import { IntelligenceCaptureDetailPage } from "@/portal/intelligence/pages/intelligence-capture-detail-page";
import { IntelligenceCapturePage } from "@/portal/intelligence/pages/intelligence-capture-page";
import { IntelligenceHomePage } from "@/portal/intelligence/pages/intelligence-home-page";
import { IntelligenceInboxPage } from "@/portal/intelligence/pages/intelligence-inbox-page";
import { IntelligenceMeetingsPage } from "@/portal/intelligence/pages/intelligence-meetings-page";
import { IntelligenceSettingsPage } from "@/portal/intelligence/pages/intelligence-settings-page";
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
import { PortalProvider, usePortal } from "@/portal/portal-context";
import { GlobalQuickAdd } from "@/portal/tasks/global-quick-add";
import { TasksCompletedPage } from "@/portal/tasks/pages/tasks-completed-page";
import { TasksDashboardPage } from "@/portal/tasks/pages/tasks-dashboard-page";
import { TasksFiltersPage } from "@/portal/tasks/pages/tasks-filters-page";
import { TasksGoalPage, TasksGoalsPage } from "@/portal/tasks/pages/tasks-goals-page";
import { TasksLabelsPage } from "@/portal/tasks/pages/tasks-labels-page";
import { TasksMinePage } from "@/portal/tasks/pages/tasks-mine-page";
import { TasksActivityPage, TasksSearchPage, TasksSettingsPage } from "@/portal/tasks/pages/tasks-misc-pages";
import { TasksProjectPage } from "@/portal/tasks/pages/tasks-project-page";
import { TasksProjectsPage } from "@/portal/tasks/pages/tasks-projects-page";
import { TasksReportsPage } from "@/portal/tasks/pages/tasks-reports-page";
import { TasksRoutinesPage } from "@/portal/tasks/pages/tasks-routines-page";
import { TasksTemplatesPage } from "@/portal/tasks/pages/tasks-templates-page";
import { TasksUpcomingPage } from "@/portal/tasks/pages/tasks-upcoming-page";
import { TasksViewPage } from "@/portal/tasks/pages/tasks-view-page";
import { TasksWorkloadPage } from "@/portal/tasks/pages/tasks-workload-page";
import { requestQuickAdd } from "@/portal/tasks/quick-add-events";
import { TodayPage } from "@/portal/today/pages/today-page";
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
            return <TasksUpcomingPage key={`${data.mode}:${data.from}`} data={data} />;
        case "tasks-mine":
            return <TasksMinePage data={data} />;
        case "tasks-templates":
            return <TasksTemplatesPage data={data} />;
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
        case "tasks-dashboard":
            return <TasksDashboardPage data={data} />;
        case "tasks-goals":
            return <TasksGoalsPage data={data} />;
        case "tasks-goal":
            return <TasksGoalPage key={data.detail.goal.id} data={data} />;
        case "tasks-routines":
            return <TasksRoutinesPage data={data} />;
        case "tasks-workload":
            return <TasksWorkloadPage data={data} />;
        case "tasks-reports":
            return <TasksReportsPage data={data} />;
        case "calendar-view":
            return <CalendarViewPage key={`${data.view}:${data.anchor}`} data={data} />;
        case "calendar-year":
            return <CalendarYearPage data={data} />;
        case "calendar-family":
            return <CalendarFamilyPage data={data} />;
        case "calendar-calendars":
            return <CalendarCalendarsPage data={data} />;
        case "calendar-subscriptions":
            return <CalendarSubscriptionsPage data={data} />;
        case "calendar-holidays":
            return <CalendarHolidaysPage data={data} />;
        case "calendar-settings":
            return <CalendarSettingsPage data={data} />;
        case "calendar-planner":
            return <CalendarPlannerPage data={data} />;
        case "calendar-leave":
            return <LeavePage data={data} />;
        case "calendar-leave-planner":
            return <LeavePlannerPage data={data} />;
        case "calendar-leave-settings":
            return <LeaveSettingsPage data={data} />;
        case "intelligence-home":
            return <IntelligenceHomePage data={data} />;
        case "intelligence-inbox":
            return <IntelligenceInboxPage key={data.filter} data={data} />;
        case "intelligence-capture":
            return <IntelligenceCapturePage data={data} />;
        case "intelligence-capture-detail":
            return <IntelligenceCaptureDetailPage key={data.capture.id} data={data} />;
        case "intelligence-briefing":
            return <IntelligenceBriefingPage key={data.kind} data={data} />;
        case "intelligence-meetings":
            return <IntelligenceMeetingsPage data={data} />;
        case "intelligence-settings":
            return <IntelligenceSettingsPage data={data} />;
        case "today":
            return <TodayPage data={data} />;
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

/**
 * Quick Add for Tasks from anywhere in the portal. Tasks pages have their own (with the page's
 * defaults); every other page gets the portal-wide one. On phones a floating button opens it.
 */
const TasksCapture = ({ data }: { data: PortalPageData }) => {
    const { can } = usePortal();
    if (!can("tasks.use")) return null;
    const knowledge = data.route === "knowledge-object" && can("knowledge.use") ? { id: data.detail.object.id, title: data.detail.object.title } : null;
    return (
        <>
            {!data.route.startsWith("tasks-") && <GlobalQuickAdd knowledge={knowledge} />}
            <button
                type="button"
                onClick={requestQuickAdd}
                aria-label="Add task"
                aria-keyshortcuts="Q"
                className="fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-30 flex size-14 cursor-pointer items-center justify-center rounded-full bg-brand-solid text-white shadow-lg outline-focus-ring transition duration-100 ease-linear hover:bg-brand-solid_hover focus-visible:outline-2 focus-visible:outline-offset-2 lg:hidden print:hidden [body:has([data-bulk-bar])_&]:hidden"
            >
                <Plus aria-hidden="true" className="size-6" />
            </button>
        </>
    );
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
                            {/* Room for the floating Add task button on phones. */}
                            <div aria-hidden="true" className="h-16 lg:hidden" />
                        </div>
                    </main>
                </div>
                <TasksCapture data={data} />
            </ToastProvider>
        </PortalProvider>
    </ThemeProvider>
);
