// Cross-source correlations: records that an authoritative source links itself, and records the
// Centre's deterministic rules found near each other in place and time. Each shows its evidence,
// the factors weighed and its limitations. Proximity is never presented as cause.
import { useMemo, useState } from "react";
import { Stars02 } from "@untitledui/icons";
import { NativeSelect } from "@/components/base/select/select-native";
import { Card } from "@/portal/components/card";
import type { PageData } from "@/portal/lib/page-types";
import { CorrelationItem } from "../history-ui";
import { CentreHeader, CentreNotices } from "../shared";

const RULE_LABELS: Record<string, string> = {
    "alert-incident": "RFS alert naming an incident",
    "fire-thermal": "Satellite detections near a fire",
    "fire-roads": "Road hazards near a fire",
    "warning-district": "Observations in a warning's districts",
    "danger-incidents": "Fire danger and fires in the district",
    "wind-gusts": "Wind warning and damaging gusts",
    "heat-temperature": "Heat warning and high temperatures",
    "air-fire": "Poor air quality near fire activity",
    "multi-warning": "Several warnings for one area",
};

export const CentreCorrelationsPage = ({ data }: { data: PageData<"centre-correlations"> }) => {
    const [rule, setRule] = useState("");
    const [basis, setBasis] = useState("");
    const list = useMemo(() => data.correlations.filter((c) => (!rule || c.rule === rule) && (!basis || c.basis === basis)), [data.correlations, rule, basis]);
    const rules = [...new Set(data.correlations.map((c) => c.rule))];
    return (
        <>
            <CentreHeader
                title="Correlations"
                crumb="Correlations"
                shell={data}
                description={`Possible relationships between current records from different sources, within ${data.distanceKm} km and ${data.windowHours} hours (Settings). Derived findings aren't official and aren't evidence that one thing caused another.`}
            />
            <CentreNotices shell={data} />
            <Card
                title={`${list.length} ${list.length === 1 ? "correlation" : "correlations"}`}
                icon={Stars02}
                action={
                    <div className="flex flex-wrap gap-2">
                        <NativeSelect
                            aria-label="Rule"
                            size="sm"
                            value={rule}
                            onChange={(e) => setRule(e.target.value)}
                            options={[{ label: "Every rule", value: "" }, ...rules.map((r) => ({ label: RULE_LABELS[r] ?? r, value: r }))]}
                        />
                        <NativeSelect
                            aria-label="Basis"
                            size="sm"
                            value={basis}
                            onChange={(e) => setBasis(e.target.value)}
                            options={[
                                { label: "Linked by provider and derived", value: "" },
                                { label: "Linked by the provider", value: "explicit" },
                                { label: "Derived by the Centre", value: "derived" },
                            ]}
                        />
                    </div>
                }
            >
                {list.length ? (
                    <ul className="divide-y divide-secondary">
                        {list.map((c) => (
                            <CorrelationItem key={c.id} correlation={c} />
                        ))}
                    </ul>
                ) : (
                    <p className="px-4 py-4 text-sm text-tertiary sm:px-5">No correlations among the current records.</p>
                )}
            </Card>
            <p className="text-xs text-tertiary">
                Rules are deterministic and capped (at most 20 records in a group and 40 groups per rule). Confidence is only ever low or moderate.
            </p>
        </>
    );
};
