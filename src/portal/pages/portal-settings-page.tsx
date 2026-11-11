// Portal settings: everything shared across the portal's applications. Feature switches are changed
// only here (Features); the other sections show what applies to each area and link to the
// settings each application keeps for itself. Wedding details and guest fields stay in Wedding
// Planner. Which sections someone sees comes from settings-sections.ts, which the worker also uses.
import { useState } from "react";
import { Key01, LayoutGrid01, Link03, Palette, ShieldTick, User01, Users01 } from "@untitledui/icons";
import { Tabs } from "@/components/application/tabs/tabs";
import { Badge } from "@/components/base/badges/badges";
import { Select } from "@/components/base/select/select";
import { FeaturedIcon } from "@/components/foundations/featured-icon/featured-icon";
import { Notice } from "@/portal/components/notice";
import { PageHeader } from "@/portal/components/page-header";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import { FeaturesPanel } from "@/portal/settings/features-panel";
import { PeoplePanel } from "@/portal/settings/people-panel";
import { PrivacyPanel } from "@/portal/settings/privacy-panel";
import { SettingsCard, type SettingsLink, SettingsLinks, StatusRow } from "@/portal/settings/settings-card";
import { WebsitePanel } from "@/portal/settings/website-panel";
import { type ApplicationId, applicationById, availableApplications, canAccessApplication } from "@/shared/portal/applications";
import { ROLES, ROLE_LABELS } from "@/shared/portal/permissions";
import { adminPathForPortal } from "@/shared/portal/admin-paths";
import { PORTAL_SETTINGS_SECTIONS, type PortalSettingsTab, portalSettingsPath, visibleSettingsTabs } from "@/shared/portal/settings-sections";
import type { PortalIntegrations } from "@/shared/portal/types";

type Data = PageData<"portal-settings">;

const useCanOpen = () => {
    const { user } = usePortal();
    return (id: ApplicationId) => {
        const application = applicationById(id);
        return !!application && canAccessApplication(user, application);
    };
};

const GeneralTab = () => {
    const { user } = usePortal();

    return (
        <div className="grid max-w-5xl grid-cols-1 gap-6 lg:grid-cols-2">
            <section aria-labelledby="identity-heading" className="rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset sm:p-6">
                <div className="flex items-start gap-4">
                    <FeaturedIcon icon={User01} color="gray" theme="modern" size="lg" />
                    <div className="min-w-0">
                        <h2 id="identity-heading" className="text-md font-semibold text-primary">
                            Identity
                        </h2>
                        <p className="mt-1 text-sm break-all text-tertiary">{user.email}</p>
                    </div>
                </div>
                <dl className="mt-6 flex flex-col divide-y divide-secondary text-sm">
                    <div className="flex items-center justify-between gap-4 py-3 first:pt-0">
                        <dt className="text-tertiary">Role</dt>
                        <dd className="font-medium text-primary">{ROLE_LABELS[user.role].label}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-4 py-3 last:pb-0">
                        <dt className="text-tertiary">Authentication</dt>
                        <dd className="flex items-center gap-2 font-medium text-primary">
                            <Key01 aria-hidden="true" className="size-4 text-fg-success-primary" /> Cloudflare Access
                        </dd>
                    </div>
                </dl>
            </section>

            <section aria-labelledby="appearance-heading" className="rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset sm:p-6">
                <div className="flex items-center justify-between gap-4">
                    <div className="flex items-start gap-4">
                        <FeaturedIcon icon={Palette} color="gray" theme="modern" size="lg" />
                        <div>
                            <h2 id="appearance-heading" className="text-md font-semibold text-primary">
                                Appearance
                            </h2>
                            <p className="mt-1 text-sm text-tertiary">
                                Light or dark mode follows the admin&apos;s own setting: your account menu → Account → Theme.
                            </p>
                        </div>
                    </div>
                </div>
            </section>
        </div>
    );
};

const AccessTab = ({ data }: { data: Data }) => {
    const { user } = usePortal();
    const applications = availableApplications(user);

    return (
        <div className="flex max-w-5xl flex-col gap-6">
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <SettingsCard id="applications" icon={LayoutGrid01} title="Application access" description="Applications available to your current role.">
                    <ul className="flex flex-col divide-y divide-secondary">
                        {applications.map((application) => (
                            <li key={application.id} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
                                <span className="text-sm font-medium text-primary">{application.name}</span>
                                <Badge size="sm" color="success">
                                    Allowed
                                </Badge>
                            </li>
                        ))}
                    </ul>
                    <div className="flex flex-wrap gap-2" aria-label="Your permissions">
                        {user.permissions.map((permission) => (
                            <Badge key={permission} size="sm" color="gray">
                                {permission}
                            </Badge>
                        ))}
                    </div>
                </SettingsCard>
                {/* Owners see the same guide inside People and roles, below. */}
                {!data.users && (
                    <SettingsCard
                        id="role-guide"
                        icon={ShieldTick}
                        title="Roles"
                        description="What each role can do. Every page and change is checked against it on the server."
                    >
                        <dl className="flex flex-col divide-y divide-secondary">
                            {ROLES.map((role) => (
                                <div key={role} className="flex flex-col gap-0.5 py-3 first:pt-0 last:pb-0">
                                    <dt className="flex items-center gap-2 text-sm font-medium text-primary">
                                        {ROLE_LABELS[role].label}
                                        {role === user.role && (
                                            <Badge size="sm" color="brand">
                                                You
                                            </Badge>
                                        )}
                                    </dt>
                                    <dd className="text-sm text-tertiary">{ROLE_LABELS[role].description}</dd>
                                </div>
                            ))}
                        </dl>
                    </SettingsCard>
                )}
            </div>
            {data.users ? <PeoplePanel initial={data.users} /> : <Notice title="People and roles">Only owners can add people or change their roles.</Notice>}
        </div>
    );
};

const ProviderRows = ({ integrations }: { integrations: PortalIntegrations }) => (
    <dl className="flex flex-col divide-y divide-secondary">
        <StatusRow
            label="Email provider"
            detail="Used by guest email. Sending also needs its own switch."
            value={integrations.email ?? "Not set up"}
            ok={!!integrations.email}
        />
        <StatusRow label="SMS provider" value={integrations.sms ?? "Not set up"} ok={!!integrations.sms} />
        <StatusRow
            label="Delivery webhooks"
            detail="Delivery reports and SMS replies are accepted only with the webhook secret."
            value={integrations.webhooks ? "Secret set" : "Not set up"}
            ok={integrations.webhooks}
        />
    </dl>
);

const SecurityTab = ({ data, tabs }: { data: Data; tabs: PortalSettingsTab[] }) => {
    const { can, isOn } = usePortal();
    const canOpen = useCanOpen();
    const links: SettingsLink[] = [
        ...(can("portal.settings.manage") && canOpen("wedding") && isOn("module.communications")
            ? [
                  {
                      label: "Email & SMS settings",
                      description: "Provider checks, approved test recipients and sending.",
                      href: "/portal/wedding/communications/providers",
                  },
              ]
            : []),
        ...(can("portal.audit.view") ? [{ label: "Audit log", description: "Every change made in the admin, by whom and when.", href: "/portal/audit" }] : []),
        ...(tabs.includes("privacy") ? [{ label: "Privacy", description: "Deleted guest records and retention.", href: portalSettingsPath("privacy") }] : []),
    ];

    return (
        <div className="grid max-w-5xl grid-cols-1 gap-6 lg:grid-cols-2">
            <SettingsCard
                id="sign-in"
                icon={ShieldTick}
                title="Sign-in"
                description="Who can reach the admin is decided by Cloudflare Access; what they can do, by their role."
            >
                <dl className="flex flex-col divide-y divide-secondary">
                    <StatusRow label="Cloudflare Access" detail="Verified on every page and API request." value="Required" ok />
                    <StatusRow label="Roles" detail="Checked on the server for every change, which is then audited." value="Enforced" ok />
                </dl>
            </SettingsCard>
            {data.integrations ? (
                <SettingsCard id="integrations" icon={Link03} title="Integrations" description="What's configured on the Worker. Secrets are never shown.">
                    <ProviderRows integrations={data.integrations} />
                </SettingsCard>
            ) : (
                <Notice title="Integrations">Only owners and admins can see which providers are configured.</Notice>
            )}
            {links.length > 0 && (
                <SettingsCard id="security-links" icon={Users01} title="Records and oversight" className="lg:col-span-2">
                    <SettingsLinks label="Security settings" links={links} />
                </SettingsCard>
            )}
        </div>
    );
};

export const PortalSettingsPage = ({ data }: { data: Data }) => {
    const { user } = usePortal();
    const tabs = visibleSettingsTabs(user).filter((id) => id !== "privacy" || data.privacy);
    const [tab, setTab] = useState<PortalSettingsTab>(tabs.includes(data.tab) ? data.tab : "general");
    const select = (next: PortalSettingsTab) => {
        setTab(next);
        // Keep the URL shareable without a client router: the section's address in Payload's admin.
        window.history.replaceState(null, "", adminPathForPortal(portalSettingsPath(next)) ?? "/admin/administration");
    };

    return (
        <>
            <PageHeader
                title="Administration"
                description="Users and permissions, feature switches, integrations, privacy and the audit log. Wedding details are under Wedding → Settings."
                breadcrumbs={[{ label: "Administration" }]}
            />
            <Tabs selectedKey={tab} onSelectionChange={(key) => select(key as PortalSettingsTab)}>
                {/* Untitled UI's settings pattern: a select on phones, tabs from tablet width up. */}
                <Select
                    aria-label="Settings section"
                    className="md:hidden"
                    value={tab}
                    onChange={(key) => key && select(key as PortalSettingsTab)}
                    items={tabs.map((id) => ({ id, label: PORTAL_SETTINGS_SECTIONS[id].label }))}
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
                <Tabs.List type="underline" size="sm" className="overflow-x-auto max-md:hidden">
                    {tabs.map((id) => (
                        <Tabs.Item key={id} id={id}>
                            {PORTAL_SETTINGS_SECTIONS[id].label}
                        </Tabs.Item>
                    ))}
                </Tabs.List>
                {tabs.map((id) => (
                    <Tabs.Panel key={id} id={id} className="pt-6 md:pt-8">
                        <p className="mb-6 max-w-3xl text-sm text-tertiary">{PORTAL_SETTINGS_SECTIONS[id].description}</p>
                        {id === "general" && <GeneralTab />}
                        {id === "access" && <AccessTab data={data} />}
                        {id === "features" && <FeaturesPanel />}
                        {id === "website" && data.website && <WebsitePanel initial={data.website} />}
                        {id === "security" && <SecurityTab data={data} tabs={tabs} />}
                        {id === "privacy" && data.privacy && <PrivacyPanel initial={data.privacy} />}
                    </Tabs.Panel>
                ))}
            </Tabs>
        </>
    );
};
