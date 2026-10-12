import { CalendarCheck01, Globe02, LayoutGrid01, Mail01, Receipt, Users01 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { MetricCard } from "@/portal/components/metric-card";
import { Notice } from "@/portal/components/notice";
import { PageHeader } from "@/portal/components/page-header";
import { formatNumber, pluralise } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";

export const PortalHomePage = ({ data }: { data: PageData<"portal-home"> }) => {
    const { user, flags, can } = usePortal();
    const name = user.name ?? user.email.split("@")[0];
    const { overview } = data;
    const followUps = [
        overview.pendingRsvps > 0 && { label: `${pluralise(overview.pendingRsvps, "event reply")} still pending`, href: "/portal/wedding/rsvps" },
        flags["module.planning"] &&
            overview.unseated > 0 && { label: `${pluralise(overview.unseated, "attending guest")} not seated`, href: "/portal/wedding/seating" },
        flags["module.planning"] &&
            overview.cateringUndecided > 0 && {
                label: `${pluralise(overview.cateringUndecided, "attending guest")} needs a meal decision`,
                href: "/portal/wedding/catering",
            },
        flags["module.communications"] &&
            overview.queuedMessages > 0 && { label: `${pluralise(overview.queuedMessages, "message")} scheduled`, href: "/portal/wedding/communications" },
        flags["module.communications"] &&
            overview.failedDeliveries > 0 && { label: `${pluralise(overview.failedDeliveries, "delivery")} failed`, href: "/portal/wedding/communications" },
        overview.revokedInvitationLinks > 0 && {
            label: `${pluralise(overview.revokedInvitationLinks, "invitation link")} revoked`,
            href: "/portal/wedding/households",
        },
    ].filter(Boolean) as { label: string; href: string }[];

    return (
        <>
            <PageHeader
                title={`Welcome, ${name}`}
                description="Your private planning workspace, with the next actions connected across the wedding workflow."
                breadcrumbs={[{ label: "Portal" }]}
            />

            {!flags["wedding.site.public"] && (
                <Notice color="brand" title="The public wedding website is still private">
                    Preview and refine it in Website. Publishing remains a separate deliberate action.
                </Notice>
            )}

            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-4">
                <MetricCard label="Guests" icon={Users01} value={formatNumber(overview.guests)} detail={`${formatNumber(overview.attending)} attending`} />
                <MetricCard label="Pending replies" icon={CalendarCheck01} value={formatNumber(overview.pendingRsvps)} detail="Across all event invitations" />
                <MetricCard
                    label="Active invitation links"
                    value={formatNumber(overview.activeInvitationLinks)}
                    detail={overview.revokedInvitationLinks ? `${overview.revokedInvitationLinks} revoked` : "None revoked"}
                />
                <MetricCard
                    label="Scheduled messages"
                    icon={Mail01}
                    value={formatNumber(overview.queuedMessages)}
                    detail={overview.failedDeliveries ? `${overview.failedDeliveries} failed deliveries` : "No failed deliveries"}
                />
            </div>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                <section aria-labelledby="quick-actions" className="flex flex-col gap-4 rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset">
                    <div>
                        <h2 id="quick-actions" className="text-md font-semibold text-primary">
                            Quick actions
                        </h2>
                        <p className="text-sm text-tertiary">Jump directly into the work that changes guest experience and planning totals.</p>
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <Button color="secondary" iconLeading={Users01} href="/portal/wedding/guests">
                            Manage guests
                        </Button>
                        <Button color="secondary" iconLeading={CalendarCheck01} href="/portal/wedding/rsvps">
                            Review RSVPs
                        </Button>
                        {flags["module.planning"] && (
                            <Button color="secondary" iconLeading={LayoutGrid01} href="/portal/wedding/seating">
                                Plan seating
                            </Button>
                        )}
                        {flags["module.planning"] && (
                            <Button color="secondary" iconLeading={Receipt} href="/portal/wedding/catering">
                                Check catering
                            </Button>
                        )}
                        {flags["module.communications"] && (
                            <Button color="secondary" iconLeading={Mail01} href="/portal/wedding/communications">
                                Prepare a message
                            </Button>
                        )}
                        <Button color="secondary" iconLeading={Globe02} href="/portal/wedding/website">
                            Edit website
                        </Button>
                    </div>
                </section>

                <section
                    aria-labelledby="workflow-followups"
                    className="flex flex-col gap-4 rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset"
                >
                    <div>
                        <h2 id="workflow-followups" className="text-md font-semibold text-primary">
                            Workflow follow-ups
                        </h2>
                        <p className="text-sm text-tertiary">RSVP changes flow into seating, catering and communications automatically.</p>
                    </div>
                    {followUps.length ? (
                        <ul className="flex flex-col divide-y divide-secondary">
                            {followUps.map((item) => (
                                <li key={item.label} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
                                    <span className="text-sm text-secondary">{item.label}</span>
                                    <Button size="sm" color="link-color" href={item.href}>
                                        Open
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="text-sm text-tertiary">No cross-workflow follow-ups need attention.</p>
                    )}
                </section>
            </div>

            {can("wedding.export") && (
                <section className="flex flex-col gap-3 rounded-xl bg-secondary p-5 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                        <h2 className="text-sm font-semibold text-secondary">Portable backup</h2>
                        <p className="text-sm text-tertiary">Download a complete JSON export of portal records. Treat it as sensitive personal data.</p>
                    </div>
                    <Button color="secondary" href="/api/portal/export/all.json" download>
                        Download JSON export
                    </Button>
                </section>
            )}
        </>
    );
};
