// One wedding or administration screen, as Payload's admin shows it (poc/payload/src/views/wedding-screen.tsx):
// the page component for the route its loader returned, with the portal context and toasts it needs. The
// portal's own chrome (sidebar, header) was retired with /portal in Phase 3.
import { ToastProvider } from "@/portal/components/toast";
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
import type { PortalPageData } from "@/shared/portal/types";

export const PortalScreen = ({ data }: { data: PortalPageData }) => {
    switch (data.route) {
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
        case "forbidden":
            return <ForbiddenPage message={data.message} />;
        default:
            return <NotFoundPage />;
    }
};

/** A screen with the providers it needs, laid out as inside Payload. */
export const AdminScreen = ({ data }: { data: PortalPageData }) => (
    <PortalProvider value={data.context}>
        <ToastProvider>
            <div data-admin-screen className="mx-auto flex w-full max-w-container flex-col gap-8 px-4 py-8 lg:px-8">
                <PortalScreen data={data} />
            </div>
        </ToastProvider>
    </PortalProvider>
);
