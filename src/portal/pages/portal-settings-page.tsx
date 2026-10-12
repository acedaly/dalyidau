import { useState } from "react";
import { Key01, LayoutGrid01, Palette, User01 } from "@untitledui/icons";
import { Tabs } from "@/components/application/tabs/tabs";
import { Badge } from "@/components/base/badges/badges";
import { FeaturedIcon } from "@/components/foundations/featured-icon/featured-icon";
import { ThemeToggle } from "@/components/site/theme-toggle";
import { PageHeader } from "@/portal/components/page-header";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import { PeoplePanel } from "@/portal/settings/people-panel";
import { PrivacyPanel } from "@/portal/settings/privacy-panel";
import { availableApplications } from "@/shared/portal/applications";
import { ROLE_LABELS } from "@/shared/portal/permissions";

type Tab = PageData<"portal-settings">["tab"];

const GeneralTab = () => {
    const { user } = usePortal();
    const applications = availableApplications(user);

    return (
        <div className="grid max-w-5xl grid-cols-1 gap-6 lg:grid-cols-2">
            <section aria-labelledby="identity-heading" className="rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset sm:p-6">
                <div className="flex items-start gap-4">
                    <FeaturedIcon icon={User01} color="gray" theme="modern" size="lg" />
                    <div className="min-w-0">
                        <h2 id="identity-heading" className="text-md font-semibold text-primary">
                            Identity and access
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
                <div className="mt-5 flex flex-wrap gap-2" aria-label="Your permissions">
                    {user.permissions.map((permission) => (
                        <Badge key={permission} size="sm" color="gray">
                            {permission}
                        </Badge>
                    ))}
                </div>
            </section>

            <section aria-labelledby="applications-heading" className="rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset sm:p-6">
                <div className="flex items-start gap-4">
                    <FeaturedIcon icon={LayoutGrid01} color="gray" theme="modern" size="lg" />
                    <div>
                        <h2 id="applications-heading" className="text-md font-semibold text-primary">
                            Application access
                        </h2>
                        <p className="mt-1 text-sm text-tertiary">Applications available to your current role.</p>
                    </div>
                </div>
                <ul className="mt-6 flex flex-col divide-y divide-secondary">
                    {applications.map((application) => (
                        <li key={application.id} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
                            <span className="text-sm font-medium text-primary">{application.name}</span>
                            <Badge size="sm" color="success">
                                Allowed
                            </Badge>
                        </li>
                    ))}
                </ul>
            </section>

            <section aria-labelledby="appearance-heading" className="rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset sm:p-6 lg:col-span-2">
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

export const PortalSettingsPage = ({ data }: { data: PageData<"portal-settings"> }) => {
    const [tab, setTab] = useState<Tab>(data.tab);
    const select = (next: Tab) => {
        setTab(next);
        window.history.replaceState(null, "", next === "general" ? "/portal/settings" : `/portal/settings/${next}`);
    };

    return (
        <>
            <PageHeader
                title="Portal settings"
                description="Your identity, application permissions and settings shared across the portal."
                breadcrumbs={[{ label: "Portal settings" }]}
            />
            <Tabs selectedKey={tab} onSelectionChange={(key) => select(key as Tab)}>
                <Tabs.List type="underline" size="sm" className="overflow-x-auto">
                    <Tabs.Item id="general">General</Tabs.Item>
                    {data.users && <Tabs.Item id="people">People and roles</Tabs.Item>}
                    {data.privacy && <Tabs.Item id="privacy">Privacy</Tabs.Item>}
                </Tabs.List>
                <Tabs.Panel id="general" className="pt-8">
                    <GeneralTab />
                </Tabs.Panel>
                {data.users && (
                    <Tabs.Panel id="people" className="pt-8">
                        <PeoplePanel initial={data.users} />
                    </Tabs.Panel>
                )}
                {data.privacy && (
                    <Tabs.Panel id="privacy" className="pt-8">
                        <PrivacyPanel initial={data.privacy} />
                    </Tabs.Panel>
                )}
            </Tabs>
        </>
    );
};
