import { ArrowUpRight, BookOpen01, HeartRounded, LayoutGrid01 } from "@untitledui/icons";
import { BadgeWithDot } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { FeaturedIcon } from "@/components/foundations/featured-icon/featured-icon";
import { Empty } from "@/portal/components/empty";
import { PageHeader } from "@/portal/components/page-header";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import { type PortalApplication, applicationById } from "@/shared/portal/applications";

const ICONS = { wedding: HeartRounded, knowledge: BookOpen01 } as const;

const ApplicationCard = ({ application }: { application: PortalApplication }) => {
    const { flags } = usePortal();
    const Icon = ICONS[application.icon];
    const statusEnabled = application.status ? flags[application.status.flag] : true;
    const status = application.status ? (statusEnabled ? application.status.enabledLabel : application.status.disabledLabel) : null;

    return (
        <article className="group flex min-h-72 flex-col rounded-2xl bg-primary p-5 shadow-xs ring-1 ring-secondary transition duration-150 ring-inset hover:-translate-y-0.5 hover:shadow-lg sm:p-6">
            <div className="flex items-start justify-between gap-4">
                <FeaturedIcon icon={Icon} color="brand" theme="gradient" size="xl" />
                {status && (
                    <BadgeWithDot size="sm" color={statusEnabled ? "success" : "gray"}>
                        {status}
                    </BadgeWithDot>
                )}
            </div>
            <div className="mt-8 flex flex-1 flex-col">
                <h2 className="text-xl font-semibold text-primary">{application.name}</h2>
                <p className="mt-2 max-w-xl text-sm leading-6 text-tertiary">{application.description}</p>
                <div className="mt-auto pt-8">
                    <Button href={application.baseRoute} size="md" iconTrailing={ArrowUpRight} className="w-full sm:w-auto">
                        Open application
                    </Button>
                </div>
            </div>
        </article>
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
                <section aria-label="Available applications" className="grid grid-cols-1 gap-5 lg:grid-cols-2 2xl:grid-cols-3">
                    {applications.map((application) => (
                        <ApplicationCard key={application.id} application={application} />
                    ))}
                </section>
            ) : (
                <div className="rounded-2xl bg-primary px-6 py-16 shadow-xs ring-1 ring-secondary ring-inset">
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
