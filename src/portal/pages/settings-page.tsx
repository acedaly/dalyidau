import { useState } from "react";
import { Tabs } from "@/components/application/tabs/tabs";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { DateField } from "@/portal/components/date-field";
import { FormGrid, FormSection, useSubmit } from "@/portal/components/form";
import { PageHeader } from "@/portal/components/page-header";
import { api } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import { CustomFieldsPanel } from "@/portal/settings/custom-fields-panel";
import { SwitchSummary } from "@/portal/settings/switch-summary";
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

type Tab = PageData<"wedding-settings">["tab"];

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

export const WeddingSettingsPage = ({ data }: { data: PageData<"wedding-settings"> }) => {
    const [tab, setTab] = useState<Tab>(data.tab);
    const select = (next: Tab) => {
        setTab(next);
        // Keep the URL shareable without a client router.
        window.history.replaceState(null, "", next === "general" ? "/portal/wedding/settings" : `/portal/wedding/settings/${next}`);
    };

    return (
        <>
            <PageHeader
                title="Wedding settings"
                description="Wedding details and custom guest fields. Feature switches are in Portal settings → Features."
                breadcrumbs={[{ label: "Wedding Planner", href: "/portal/wedding" }, { label: "Settings" }]}
            />
            <Tabs selectedKey={tab} onSelectionChange={(k) => select(k as Tab)}>
                <Tabs.List type="underline" size="sm" className="overflow-x-auto">
                    <Tabs.Item id="general">General</Tabs.Item>
                    <Tabs.Item id="fields">Custom fields</Tabs.Item>
                </Tabs.List>
                <Tabs.Panel id="general" className="flex max-w-4xl flex-col gap-8 pt-8">
                    <GeneralTab />
                    {/* Switches are portal-wide and changed in one place; this shows the Wedding Planner ones. */}
                    <div className="border-t border-secondary pt-8">
                        <FormSection
                            title="Feature switches"
                            description="The website, RSVP, sending and modules are switched on or off for the whole portal, in Portal settings → Features."
                        >
                            <SwitchSummary area="wedding" />
                        </FormSection>
                    </div>
                </Tabs.Panel>
                <Tabs.Panel id="fields" className="pt-8">
                    <CustomFieldsPanel initial={data.customFields} />
                </Tabs.Panel>
            </Tabs>
        </>
    );
};
