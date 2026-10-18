// The portal's application launcher. Compact, information-dense cards in the style of Untitled UI's
// application launcher grids: a featured icon, the name, a one- or two-line summary and any status,
// with the whole card as the link (a large, accessible touch target). The grid uses container
// queries, so the number of columns follows the width actually available beside the sidebar:
// one on small phones, two on large phones and tablets, three, then four on wide desktops.
import { ArrowUpRight, BookOpen01, Calendar, CheckDone01, HeartRounded, LayoutGrid01, Stars02 } from "@untitledui/icons";
import { BadgeWithDot } from "@/components/base/badges/badges";
import { FeaturedIcon } from "@/components/foundations/featured-icon/featured-icon";
import { Empty } from "@/portal/components/empty";
import { PageHeader } from "@/portal/components/page-header";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import { type ApplicationIcon, type PortalApplication, applicationById } from "@/shared/portal/applications";
import { cx } from "@/utils/cx";

const ICONS: Record<ApplicationIcon, typeof HeartRounded> = {
    wedding: HeartRounded,
    knowledge: BookOpen01,
    tasks: CheckDone01,
    calendar: Calendar,
    intelligence: Stars02,
};

export const ApplicationCard = ({ application }: { application: PortalApplication }) => {
    const { flags } = usePortal();
    const Icon = ICONS[application.icon];
    const statusEnabled = application.status ? flags[application.status.flag] : true;
    const status = application.status ? (statusEnabled ? application.status.enabledLabel : application.status.disabledLabel) : null;
    const summaryId = `app-${application.id}-summary`;

    return (
        <a
            href={application.baseRoute}
            aria-label={`Open ${application.name}`}
            aria-describedby={summaryId}
            title={application.description}
            data-application={application.id}
            className={cx(
                "group relative flex min-h-24 items-start gap-3 rounded-xl bg-primary p-4 shadow-xs ring-1 ring-secondary ring-inset",
                "transition duration-100 ease-linear hover:bg-primary_hover hover:ring-primary",
                "outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2",
            )}
        >
            <FeaturedIcon icon={Icon} color="brand" theme="light" size="md" className="shrink-0" />
            <div className="flex min-w-0 flex-1 flex-col gap-1 pr-5">
                <h2 className="truncate text-md font-semibold text-primary">{application.name}</h2>
                <p id={summaryId} className="line-clamp-2 text-sm text-tertiary">
                    {application.summary}
                </p>
                {status && (
                    <BadgeWithDot size="sm" type="modern" color={statusEnabled ? "success" : "gray"} className="mt-1 self-start">
                        {status}
                    </BadgeWithDot>
                )}
            </div>
            <ArrowUpRight
                aria-hidden="true"
                className="absolute top-4 right-4 size-4 text-fg-quaternary transition duration-100 ease-linear group-hover:text-fg-quaternary_hover"
            />
        </a>
    );
};

export const PortalHomePage = ({ data }: { data: PageData<"portal-home"> }) => {
    const { user } = usePortal();
    const name = user.name ?? user.email.split("@")[0];
    const applications = data.applications.map(applicationById).filter((application): application is PortalApplication => !!application);

    return (
        <>
            <PageHeader
                title="Applications"
                description={`Welcome, ${name}. Choose an application to continue.`}
                breadcrumbs={[{ label: "All applications" }]}
            />

            {applications.length > 0 ? (
                <div className="@container">
                    <section aria-label="Available applications" className="grid grid-cols-1 gap-3 @md:grid-cols-2 @3xl:grid-cols-3 @6xl:grid-cols-4">
                        {applications.map((application) => (
                            <ApplicationCard key={application.id} application={application} />
                        ))}
                    </section>
                </div>
            ) : (
                <div className="rounded-xl bg-primary px-6 py-16 shadow-xs ring-1 ring-secondary ring-inset">
                    <Empty
                        icon={LayoutGrid01}
                        title="No applications available"
                        description="Your account is active, but it has not been granted access to an enabled application. Ask a portal owner to review your permissions."
                    />
                </div>
            )}
        </>
    );
};
