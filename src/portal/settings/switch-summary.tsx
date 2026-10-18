// Read-only state of one area's feature switches, with a link to Portal settings → Features where
// they're changed. Used wherever a page depends on a switch, so the controls stay in one place.
import { ArrowRight } from "@untitledui/icons";
import { BadgeWithDot } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { usePortal } from "@/portal/portal-context";
import { FLAG_DEFINITIONS } from "@/shared/portal/flags";
import { type FeatureArea, featuresHref, flagsInArea } from "@/shared/portal/settings-sections";

export const SwitchSummary = ({ area }: { area: FeatureArea }) => {
    const { flags, can } = usePortal();

    return (
        <div className="flex flex-col gap-3">
            <ul aria-label="Feature switches" className="flex flex-col divide-y divide-secondary rounded-lg ring-1 ring-secondary ring-inset">
                {flagsInArea(area).map((key) => (
                    <li key={key} data-flag={key} className="flex items-center justify-between gap-4 px-4 py-3">
                        <div className="min-w-0">
                            <p className="text-sm font-medium text-primary">{FLAG_DEFINITIONS[key].label}</p>
                            <p className="truncate font-mono text-xs text-tertiary">{key}</p>
                        </div>
                        <BadgeWithDot size="sm" type="pill-color" color={flags[key] ? "success" : "gray"} className="shrink-0">
                            {flags[key] ? "On" : "Off"}
                        </BadgeWithDot>
                    </li>
                ))}
            </ul>
            <Button href={featuresHref(area)} color="link-color" size="sm" iconTrailing={ArrowRight} className="self-start">
                {can("portal.settings.manage") ? "Manage in Portal settings → Features" : "View in Portal settings → Features"}
            </Button>
        </div>
    );
};
