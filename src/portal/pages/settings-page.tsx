import { useState } from "react";
import { Tabs } from "@/components/application/tabs/tabs";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { Toggle } from "@/components/base/toggle/toggle";
import { DateField } from "@/portal/components/date-field";
import { FormGrid, FormSection, useSubmit } from "@/portal/components/form";
import { Notice } from "@/portal/components/notice";
import { PageHeader } from "@/portal/components/page-header";
import { useToast } from "@/portal/components/toast";
import { api, errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import { CustomFieldsPanel } from "@/portal/settings/custom-fields-panel";
import { PeoplePanel } from "@/portal/settings/people-panel";
import { FLAG_DEFINITIONS, FLAG_KEYS, type FlagKey, type Flags } from "@/shared/portal/flags";
import type { WeddingDetails } from "@/shared/portal/types";

const TIME_ZONES = [
    "Australia/Sydney",
    "Australia/Melbourne",
    "Australia/Brisbane",
    "Australia/Adelaide",
    "Australia/Darwin",
    "Australia/Perth",
    "Australia/Hobart",
    "Pacific/Auckland",
    "Europe/London",
    "America/New_York",
    "America/Los_Angeles",
    "Asia/Singapore",
];

type Tab = PageData<"settings">["tab"];

const GeneralTab = () => {
    const { wedding, setWedding, can } = usePortal();
    const [draft, setDraft] = useState<WeddingDetails>(wedding);
    const canEdit = can("portal.settings.manage");
    const save = useSubmit(() => api<{ value: WeddingDetails }>("PUT", "/api/portal/settings/wedding", draft), {
        success: "Wedding details saved",
        onSuccess: ({ value }) => {
            setWedding(value);
            setDraft(value);
        },
    });

    return (
        <form
            noValidate
            className="flex max-w-4xl flex-col gap-8"
            onSubmit={(e) => {
                e.preventDefault();
                void save.submit();
            }}
        >
            <fieldset disabled={!canEdit} className="flex flex-col gap-8">
                <FormSection title="The couple" description="Used across the portal (for example, to label each side of the guest list) and on the website.">
                    <FormGrid>
                        <Input
                            label="First partner"
                            isRequired
                            value={draft.partnerOne}
                            onChange={(v) => setDraft({ ...draft, partnerOne: v })}
                            isInvalid={!!save.fieldError("partnerOne")}
                            hint={save.fieldError("partnerOne")}
                        />
                        <Input
                            label="Second partner"
                            isRequired
                            value={draft.partnerTwo}
                            onChange={(v) => setDraft({ ...draft, partnerTwo: v })}
                            isInvalid={!!save.fieldError("partnerTwo")}
                            hint={save.fieldError("partnerTwo")}
                        />
                    </FormGrid>
                </FormSection>
                <FormSection title="When and where">
                    <DateField
                        label="Wedding date"
                        value={draft.date || null}
                        onChange={(v) => setDraft({ ...draft, date: v ?? "" })}
                        error={save.fieldError("date")}
                    />
                    <Input
                        label="Location"
                        placeholder="Town or region"
                        value={draft.location}
                        onChange={(v) => setDraft({ ...draft, location: v })}
                        hint="A general place shown on the website, e.g. a region. Venue addresses belong on events."
                    />
                    <Select
                        label="Time zone"
                        items={(TIME_ZONES.includes(draft.timeZone) ? TIME_ZONES : [draft.timeZone, ...TIME_ZONES]).map((tz) => ({
                            id: tz,
                            label: tz.replace("_", " "),
                        }))}
                        value={draft.timeZone}
                        onChange={(v) => setDraft({ ...draft, timeZone: String(v) })}
                        hint="Used for the countdown, due dates and the RSVP deadline."
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                </FormSection>
            </fieldset>
            {canEdit && (
                <div className="flex justify-end gap-3">
                    <Button color="secondary" onClick={() => setDraft(wedding)} isDisabled={save.busy}>
                        Reset
                    </Button>
                    <Button type="submit" isLoading={save.busy} showTextWhileLoading>
                        Save
                    </Button>
                </div>
            )}
        </form>
    );
};

const FeaturesTab = () => {
    const { flags, setFlags, can } = usePortal();
    const toast = useToast();
    const [busy, setBusy] = useState<FlagKey | null>(null);
    const canEdit = can("portal.settings.manage");
    const groups = [...new Set(FLAG_KEYS.map((key) => FLAG_DEFINITIONS[key].group))];

    const toggle = async (key: FlagKey, enabled: boolean) => {
        setBusy(key);
        try {
            const result = await api<{ flags: Flags }>("PUT", `/api/portal/flags/${key}`, { enabled });
            setFlags(result.flags);
            toast.success(`${FLAG_DEFINITIONS[key].label} ${enabled ? "on" : "off"}`);
        } catch (e) {
            toast.error("Couldn't change the feature", errorMessage(e));
        } finally {
            setBusy(null);
        }
    };

    return (
        <div className="flex max-w-4xl flex-col gap-8">
            {!canEdit && <Notice title="Read only">Only owners and admins can change features.</Notice>}
            {groups.map((group) => (
                <FormSection key={group} title={group}>
                    {FLAG_KEYS.filter((key) => FLAG_DEFINITIONS[key].group === group).map((key) => (
                        <Toggle
                            key={key}
                            size="md"
                            label={FLAG_DEFINITIONS[key].label}
                            hint={FLAG_DEFINITIONS[key].description}
                            isSelected={flags[key]}
                            isDisabled={!canEdit || busy === key}
                            onChange={(on) => toggle(key, on)}
                        />
                    ))}
                </FormSection>
            ))}
        </div>
    );
};

export const SettingsPage = ({ data }: { data: PageData<"settings"> }) => {
    const [tab, setTab] = useState<Tab>(data.tab === "people" && !data.users ? "general" : data.tab);
    const select = (next: Tab) => {
        setTab(next);
        // Keep the URL shareable without a client router.
        window.history.replaceState(null, "", next === "general" ? "/portal/settings" : `/portal/settings/${next}`);
    };

    return (
        <>
            <PageHeader
                title="Settings"
                description="Wedding details, features, custom fields and who can use the portal."
                breadcrumbs={[{ label: "Settings" }]}
            />
            <Tabs selectedKey={tab} onSelectionChange={(k) => select(k as Tab)}>
                <Tabs.List type="underline" size="sm" className="overflow-x-auto">
                    <Tabs.Item id="general">General</Tabs.Item>
                    <Tabs.Item id="features">Features</Tabs.Item>
                    <Tabs.Item id="fields">Custom fields</Tabs.Item>
                    {data.users && <Tabs.Item id="people">People and roles</Tabs.Item>}
                </Tabs.List>
                <Tabs.Panel id="general" className="pt-8">
                    <GeneralTab />
                </Tabs.Panel>
                <Tabs.Panel id="features" className="pt-8">
                    <FeaturesTab />
                </Tabs.Panel>
                <Tabs.Panel id="fields" className="pt-8">
                    <CustomFieldsPanel initial={data.customFields} />
                </Tabs.Panel>
                {data.users && (
                    <Tabs.Panel id="people" className="pt-8">
                        <PeoplePanel initial={data.users} />
                    </Tabs.Panel>
                )}
            </Tabs>
        </>
    );
};
