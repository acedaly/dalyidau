// Portal settings → Features: the one place feature switches are changed. Grouped by the part of
// the portal they belong to; an area is listed only to people who can open its application (or, for
// the website, who manage portal settings).
// Each change goes through PUT /api/portal/flags/:key, which checks portal.settings.manage and
// audits it.
import { useEffect, useState } from "react";
import { Toggle } from "@/components/base/toggle/toggle";
import { FormSection } from "@/portal/components/form";
import { Notice } from "@/portal/components/notice";
import { useToast } from "@/portal/components/toast";
import { api, errorMessage } from "@/portal/lib/api";
import { usePortal } from "@/portal/portal-context";
import { FLAG_DEFINITIONS, type FlagKey, type Flags } from "@/shared/portal/flags";
import { FEATURE_AREAS, FEATURE_AREA_DETAILS, canSeeFeatureArea, flagGroupsInArea, flagsInArea } from "@/shared/portal/settings-sections";

export const FeaturesPanel = () => {
    const { user, flags, setFlags, can } = usePortal();
    const toast = useToast();
    const [busy, setBusy] = useState<FlagKey | null>(null);
    const canEdit = can("portal.settings.manage");
    const areas = FEATURE_AREAS.filter((area) => canSeeFeatureArea(user, area));

    // Links such as /portal/settings/features#features-calendar arrive before the page renders.
    useEffect(() => {
        const id = window.location.hash.slice(1);
        if (id.startsWith("features-")) document.getElementById(id)?.scrollIntoView({ block: "start" });
    }, []);

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
            {areas.map((area) => {
                const groups = flagGroupsInArea(area);
                return (
                    <div key={area} id={`features-${area}`} className="scroll-mt-6" data-feature-area={area}>
                        <FormSection title={FEATURE_AREA_DETAILS[area].label} description={FEATURE_AREA_DETAILS[area].description}>
                            {groups.map((group) => (
                                <div
                                    key={group}
                                    role={groups.length > 1 ? "group" : undefined}
                                    aria-label={groups.length > 1 ? group : undefined}
                                    className="flex flex-col gap-4"
                                >
                                    {groups.length > 1 && <h3 className="text-xs font-semibold tracking-wide text-quaternary uppercase">{group}</h3>}
                                    {flagsInArea(area)
                                        .filter((key) => FLAG_DEFINITIONS[key].group === group)
                                        .map((key) => (
                                            <Toggle
                                                key={key}
                                                size="md"
                                                // Toggle is w-max by default; long hints would widen the page.
                                                className="w-full"
                                                label={FLAG_DEFINITIONS[key].label}
                                                hint={FLAG_DEFINITIONS[key].description}
                                                isSelected={flags[key]}
                                                isDisabled={!canEdit || busy === key}
                                                onChange={(on) => toggle(key, on)}
                                            />
                                        ))}
                                </div>
                            ))}
                        </FormSection>
                    </div>
                );
            })}
        </div>
    );
};
