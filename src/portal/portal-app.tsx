import { AssetsCapturePage } from "@/portal/assets/pages/assets-capture-page";
import { AssetsDocumentsPage } from "@/portal/assets/pages/assets-documents-page";
import { AssetsInsurancePage } from "@/portal/assets/pages/assets-insurance-page";
import { AssetsItemPage } from "@/portal/assets/pages/assets-item-page";
import { AssetsLabelsPage } from "@/portal/assets/pages/assets-labels-page";
import { AssetsListPage } from "@/portal/assets/pages/assets-list-page";
import { AssetsMaintenancePage } from "@/portal/assets/pages/assets-maintenance-page";
import { AssetsOverviewPage } from "@/portal/assets/pages/assets-overview-page";
import { AssetsLocationPage, AssetsPropertyPage } from "@/portal/assets/pages/assets-property-page";
import { AssetsRegisterPage } from "@/portal/assets/pages/assets-register-page";
import { AssetsReportsPage } from "@/portal/assets/pages/assets-reports-page";
import { AssetsSearchPage } from "@/portal/assets/pages/assets-search-page";
import { AssetsSettingsPage } from "@/portal/assets/pages/assets-settings-page";
import { AssetsWarrantiesPage } from "@/portal/assets/pages/assets-warranties-page";
import { CalendarCalendarsPage } from "@/portal/calendar/pages/calendar-calendars-page";
import { CalendarFamilyPage } from "@/portal/calendar/pages/calendar-family-page";
import { CalendarHolidaysPage } from "@/portal/calendar/pages/calendar-holidays-page";
import { CalendarSettingsPage } from "@/portal/calendar/pages/calendar-settings-page";
import { CalendarSubscriptionsPage } from "@/portal/calendar/pages/calendar-subscriptions-page";
import { CalendarViewPage } from "@/portal/calendar/pages/calendar-view-page";
import { CalendarYearPage } from "@/portal/calendar/pages/calendar-year-page";
import { LeavePage } from "@/portal/calendar/pages/leave-page";
import { LeavePlannerPage } from "@/portal/calendar/pages/leave-planner-page";
import { LeaveSettingsPage } from "@/portal/calendar/pages/leave-settings-page";
import { CentreAnalyticsPage } from "@/portal/centre/pages/centre-analytics-page";
import { CentreAssistantPage } from "@/portal/centre/pages/centre-assistant-page";
import { CentreBriefingsPage } from "@/portal/centre/pages/centre-briefings-page";
import { CentreChangesPage } from "@/portal/centre/pages/centre-changes-page";
import { CentreCorrelationsPage } from "@/portal/centre/pages/centre-correlations-page";
import { CentreHazardsPage } from "@/portal/centre/pages/centre-hazards-page";
import { CentreHistoryPage } from "@/portal/centre/pages/centre-history-page";
import { CentreMapPage } from "@/portal/centre/pages/centre-map-page";
import { CentreOverviewPage } from "@/portal/centre/pages/centre-overview-page";
import { CentreRecordPage } from "@/portal/centre/pages/centre-record-page";
import { CentreRecordsPage } from "@/portal/centre/pages/centre-records-page";
import { CentreReplayPage } from "@/portal/centre/pages/centre-replay-page";
import { CentreReportPage } from "@/portal/centre/pages/centre-report-page";
import { CentreReportsPage } from "@/portal/centre/pages/centre-reports-page";
import { CentreRulesPage } from "@/portal/centre/pages/centre-rules-page";
import { CentreSettingsPage } from "@/portal/centre/pages/centre-settings-page";
import { CentreSourcesPage } from "@/portal/centre/pages/centre-sources-page";
import { CentreTimelinePage } from "@/portal/centre/pages/centre-timeline-page";
import { CentreWallboardEditorPage } from "@/portal/centre/pages/centre-wallboard-editor-page";
import { CentreWallboardsPage } from "@/portal/centre/pages/centre-wallboards-page";
import { CentreWatchesPage } from "@/portal/centre/pages/centre-watches-page";
import { ToastProvider } from "@/portal/components/toast";
import { FinanceAccountPage } from "@/portal/finance/pages/finance-account-page";
import { FinanceAccountsPage } from "@/portal/finance/pages/finance-accounts-page";
import { FinanceImportPage } from "@/portal/finance/pages/finance-import-page";
import { FinanceImportReviewPage } from "@/portal/finance/pages/finance-import-review-page";
import { FinanceOverviewPage } from "@/portal/finance/pages/finance-overview-page";
import { FinanceSettingsPage } from "@/portal/finance/pages/finance-settings-page";
import { FinanceTransactionsPage } from "@/portal/finance/pages/finance-transactions-page";
import { IntelligenceBriefingPage } from "@/portal/intelligence/pages/intelligence-briefing-page";
import { IntelligenceHomePage } from "@/portal/intelligence/pages/intelligence-home-page";
import { IntelligenceSettingsPage } from "@/portal/intelligence/pages/intelligence-settings-page";
import { PortalSidebar } from "@/portal/layout/portal-sidebar";
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
        case "calendar-leave":
            return <LeavePage data={data} />;
        case "calendar-leave-planner":
            return <LeavePlannerPage data={data} />;
        case "calendar-leave-settings":
            return <LeaveSettingsPage data={data} />;
        case "intelligence-home":
            return <IntelligenceHomePage data={data} />;
        case "intelligence-briefing":
            return <IntelligenceBriefingPage key={data.kind} data={data} />;
        case "intelligence-settings":
            return <IntelligenceSettingsPage data={data} />;
        case "centre-overview":
            return <CentreOverviewPage data={data} />;
        case "centre-map":
            return <CentreMapPage data={data} />;
        case "centre-records":
            return <CentreRecordsPage data={data} />;
        case "centre-record":
            return <CentreRecordPage key={data.record.id} data={data} />;
        case "centre-hazards":
            return <CentreHazardsPage key={data.tab} data={data} />;
        case "centre-history":
            return <CentreHistoryPage data={data} />;
        case "centre-briefings":
            return <CentreBriefingsPage data={data} />;
        case "centre-watches":
            return <CentreWatchesPage data={data} />;
        case "centre-wallboards":
            return <CentreWallboardsPage data={data} />;
        case "centre-sources":
            return <CentreSourcesPage data={data} />;
        case "centre-settings":
            return <CentreSettingsPage data={data} />;
        case "centre-changes":
            return <CentreChangesPage data={data} />;
        case "centre-timeline":
            return <CentreTimelinePage data={data} />;
        case "centre-replay":
            return <CentreReplayPage data={data} />;
        case "centre-analytics":
            return <CentreAnalyticsPage data={data} />;
        case "centre-correlations":
            return <CentreCorrelationsPage data={data} />;
        case "centre-rules":
            return <CentreRulesPage data={data} />;
        case "centre-reports":
            return <CentreReportsPage data={data} />;
        case "centre-report":
            return <CentreReportPage key={data.summary.id} data={data} />;
        case "centre-assistant":
            return <CentreAssistantPage data={data} />;
        case "centre-wallboard":
            return <CentreWallboardEditorPage key={data.wallboard.id} data={data} />;
        case "assets-overview":
            return <AssetsOverviewPage data={data} />;
        case "assets-list":
            return <AssetsListPage key={data.section} data={data} />;
        case "assets-item":
            return <AssetsItemPage key={data.detail.asset.id} data={data} />;
        case "assets-property":
            return <AssetsPropertyPage data={data} />;
        case "assets-location":
            return <AssetsLocationPage key={data.location.id} data={data} />;
        case "assets-maintenance":
            return <AssetsMaintenancePage data={data} />;
        case "assets-insurance":
            return <AssetsInsurancePage data={data} />;
        case "assets-warranties":
            return <AssetsWarrantiesPage data={data} />;
        case "assets-documents":
            return <AssetsDocumentsPage data={data} />;
        case "assets-reports":
            return <AssetsReportsPage data={data} />;
        case "assets-register":
            return <AssetsRegisterPage data={data} />;
        case "assets-settings":
            return <AssetsSettingsPage data={data} />;
        case "assets-capture":
            return <AssetsCapturePage data={data} />;
        case "assets-labels":
            return <AssetsLabelsPage data={data} />;
        case "assets-search":
            return <AssetsSearchPage data={data} />;
        case "finance-overview":
            return <FinanceOverviewPage data={data} />;
        case "finance-transactions":
            return <FinanceTransactionsPage data={data} />;
        case "finance-accounts":
            return <FinanceAccountsPage data={data} />;
        case "finance-account":
            return <FinanceAccountPage key={data.account.id} data={data} />;
        case "finance-import":
            return <FinanceImportPage data={data} />;
        case "finance-import-review":
            return <FinanceImportReviewPage key={data.detail.summary.id} data={data} />;
        case "finance-settings":
            return <FinanceSettingsPage data={data} />;
        case "today":
            return <TodayPage data={data} />;
        case "forbidden":
            return <ForbiddenPage message={data.message} />;
        default:
            return <NotFoundPage />;
    }
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
                        <PortalSidebar path={path} />
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
