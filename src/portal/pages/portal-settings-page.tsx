// Portal settings: everything shared across the portal's applications. Feature switches are changed
// only here (Features); the other sections show what applies to each area and link to the
// settings each application keeps for itself. Wedding details and guest fields stay in Wedding
// Planner. Which sections someone sees comes from settings-sections.ts, which the worker also uses.
import { useState } from "react";
import {
    BookOpen01,
    Calendar,
    CheckDone01,
    Key01,
    LayoutGrid01,
    Link03,
    Palette,
    ShieldTick,
    Stars02,
    Toggle01Right,
    User01,
    Users01,
} from "@untitledui/icons";
import { Tabs } from "@/components/application/tabs/tabs";
import { Badge } from "@/components/base/badges/badges";
import { Select } from "@/components/base/select/select";
import { FeaturedIcon } from "@/components/foundations/featured-icon/featured-icon";
import { ThemeToggle } from "@/components/site/theme-toggle";
import { Notice } from "@/portal/components/notice";
import { PageHeader } from "@/portal/components/page-header";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import { FeaturesPanel } from "@/portal/settings/features-panel";
import { PeoplePanel } from "@/portal/settings/people-panel";
import { PrivacyPanel } from "@/portal/settings/privacy-panel";
import { SettingsCard, type SettingsLink, SettingsLinks, StatusRow } from "@/portal/settings/settings-card";
import { SwitchSummary } from "@/portal/settings/switch-summary";
import { type ApplicationId, applicationById, availableApplications, canAccessApplication } from "@/shared/portal/applications";
import { ROLES, ROLE_LABELS } from "@/shared/portal/permissions";
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
                            <p className="mt-1 text-sm text-tertiary">Switch the portal between light and dark mode on this device.</p>
                        </div>
                    </div>
                    <ThemeToggle />
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

const ProviderRows = ({ integrations, emailOnly }: { integrations: PortalIntegrations; emailOnly?: boolean }) => (
    <dl className="flex flex-col divide-y divide-secondary">
        <StatusRow
            label="Email provider"
            detail="Shared by guest email and reminder emails. Each also has its own switch."
            value={integrations.email ?? "Not set up"}
            ok={!!integrations.email}
        />
        {!emailOnly && (
            <>
                <StatusRow label="SMS provider" value={integrations.sms ?? "Not set up"} ok={!!integrations.sms} />
                <StatusRow
                    label="Delivery webhooks"
                    detail="Delivery reports and SMS replies are accepted only with the webhook secret."
                    value={integrations.webhooks ? "Secret set" : "Not set up"}
                    ok={integrations.webhooks}
                />
            </>
        )}
    </dl>
);

const CALENDAR_LINKS: SettingsLink[] = [
    {
        label: "Settings, import and export",
        description: "Your time zone, reminders and whether notifications are emailed to you.",
        href: "/portal/calendar/settings",
    },
    { label: "Calendars and sharing", description: "Create, copy and revoke your private subscription addresses.", href: "/portal/calendar/calendars" },
    { label: "Subscriptions", description: "Calendars you follow from elsewhere, and how often they refresh.", href: "/portal/calendar/subscriptions" },
    { label: "Holidays and school dates", description: "NSW public and school holidays shown on calendars.", href: "/portal/calendar/holidays" },
    { label: "Leave settings", description: "Leave types, balances and accrual.", href: "/portal/calendar/leave/settings" },
];

const CalendarTab = ({ data }: { data: Data }) => (
    <div className="grid max-w-5xl grid-cols-1 gap-6 lg:grid-cols-2">
        <SettingsCard
            id="calendar-switches"
            icon={Toggle01Right}
            title="Subscription addresses and reminder emails"
            description="These switches apply to everyone. While they're off, addresses answer “not found” and notifications stay in the portal."
        >
            <SwitchSummary area="calendar" />
        </SettingsCard>
        <SettingsCard id="calendar-links" icon={Calendar} title="In Daly Calendar" description="Settings each person keeps for themselves.">
            <SettingsLinks label="Calendar settings" links={CALENDAR_LINKS} />
        </SettingsCard>
        {data.integrations && (
            <SettingsCard id="calendar-config" icon={Key01} title="On the Worker" className="lg:col-span-2">
                <dl className="flex flex-col divide-y divide-secondary">
                    <StatusRow
                        label="Subscribed calendar addresses encrypted"
                        detail="CALENDAR_ENCRYPTION_KEY. Optional; without it addresses are stored as entered."
                        value={data.integrations.calendarEncryption ? "Encrypted" : "Not set"}
                        ok={data.integrations.calendarEncryption}
                    />
                    <StatusRow label="Email provider for reminder emails" value={data.integrations.email ?? "Not set up"} ok={!!data.integrations.email} />
                </dl>
            </SettingsCard>
        )}
    </div>
);

const TasksTab = ({ data }: { data: Data }) => (
    <div className="grid max-w-5xl grid-cols-1 gap-6 lg:grid-cols-2">
        <SettingsCard
            id="tasks-switches"
            icon={Toggle01Right}
            title="Reminder emails"
            description="Applies to everyone. While it's off, reminders appear in Tasks only."
        >
            <SwitchSummary area="tasks" />
        </SettingsCard>
        <SettingsCard id="tasks-links" icon={CheckDone01} title="In Daly Tasks" description="Settings each person keeps for themselves.">
            <SettingsLinks
                label="Tasks settings"
                links={[
                    {
                        label: "Settings and export",
                        description: "Whether your reminders are emailed to you, your defaults and exports.",
                        href: "/portal/tasks/settings",
                    },
                ]}
            />
            {data.integrations && <ProviderRows integrations={data.integrations} emailOnly />}
        </SettingsCard>
    </div>
);

const KnowledgeTab = () => {
    const canOpen = useCanOpen();

    return (
        <div className="grid max-w-5xl grid-cols-1 gap-6 lg:grid-cols-2">
            {canOpen("knowledge") && (
                <SettingsCard
                    id="knowledge-links"
                    icon={BookOpen01}
                    title="Daly Knowledge"
                    description="Spaces are private to their members; portal roles never open someone else's space."
                >
                    <SettingsLinks
                        label="Knowledge settings"
                        links={[{ label: "Settings and export", description: "Your spaces, members and a full export.", href: "/portal/knowledge/settings" }]}
                    />
                </SettingsCard>
            )}
            {canOpen("intelligence") && (
                <SettingsCard
                    id="intelligence-links"
                    icon={Stars02}
                    title="Daly Intelligence"
                    description="AI features, the monthly budget and storage are set in Intelligence itself. AI only suggests; nothing is saved until someone approves it."
                >
                    <SettingsLinks
                        label="Intelligence settings"
                        links={[
                            {
                                label: "AI and storage settings",
                                description: "Which AI features are on, the budget, your preferences and Knowledge exclusions.",
                                href: "/portal/intelligence/settings",
                            },
                        ]}
                    />
                </SettingsCard>
            )}
        </div>
    );
};

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
        ...(can("portal.audit.view") ? [{ label: "Audit log", description: "Every change made in the portal, by whom and when.", href: "/portal/audit" }] : []),
        ...(tabs.includes("privacy") ? [{ label: "Privacy", description: "Deleted guest records and retention.", href: portalSettingsPath("privacy") }] : []),
    ];

    return (
        <div className="grid max-w-5xl grid-cols-1 gap-6 lg:grid-cols-2">
            <SettingsCard
                id="sign-in"
                icon={ShieldTick}
                title="Sign-in"
                description="Who can reach the portal is decided by Cloudflare Access; what they can do, by their role."
            >
                <dl className="flex flex-col divide-y divide-secondary">
                    <StatusRow label="Cloudflare Access" detail="Verified on every page and API request." value="Required" ok />
                    <StatusRow label="Roles" detail="Checked on the server for every change, which is then audited." value="Enforced" ok />
                </dl>
            </SettingsCard>
            {data.integrations ? (
                <SettingsCard id="integrations" icon={Link03} title="Integrations" description="What's configured on the Worker. Secrets are never shown.">
                    <ProviderRows integrations={data.integrations} />
                    <dl className="flex flex-col divide-y divide-secondary border-t border-secondary pt-3">
                        <StatusRow
                            label="AI assistants (MCP)"
                            detail="Through the MCP gateway, with the same permissions as here."
                            value={data.integrations.mcp ? "Configured" : "Not set up"}
                            ok={data.integrations.mcp}
                        />
                    </dl>
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
        // Keep the URL shareable without a client router.
        window.history.replaceState(null, "", portalSettingsPath(next));
    };

    return (
        <>
            <PageHeader
                title="Portal settings"
                description="Feature switches, people and access, and settings shared by every application. Wedding details stay in Wedding Planner."
                breadcrumbs={[{ label: "Portal settings" }]}
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
                        {id === "calendar" && <CalendarTab data={data} />}
                        {id === "tasks" && <TasksTab data={data} />}
                        {id === "knowledge" && <KnowledgeTab />}
                        {id === "security" && <SecurityTab data={data} tabs={tabs} />}
                        {id === "privacy" && data.privacy && <PrivacyPanel initial={data.privacy} />}
                    </Tabs.Panel>
                ))}
            </Tabs>
        </>
    );
};
