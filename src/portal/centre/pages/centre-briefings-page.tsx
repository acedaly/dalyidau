// Briefings: the NSW situation or one watch area, as facts from stored records with an optional,
// labelled interpretation. Correlations are listed with their evidence and limitations.
import { NativeSelect } from "@/components/base/select/select-native";
import { Card } from "@/portal/components/card";
import type { PageData } from "@/portal/lib/page-types";
import { BriefingView } from "../briefing-view";
import { CorrelationItem } from "../history-ui";
import { CENTRE, CentreHeader, CentreNotices } from "../shared";

export const CentreBriefingsPage = ({ data }: { data: PageData<"centre-briefings"> }) => (
    <>
        <CentreHeader
            title="Briefings"
            crumb="Briefings"
            shell={data}
            description="Facts from the records collected, each with its source and time. An interpretation is optional and always labelled."
            actions={
                <NativeSelect
                    aria-label="Briefing for"
                    value={data.briefing.watchId ?? ""}
                    onChange={(e) => (window.location.href = e.target.value ? `${CENTRE}/briefings?watch=${e.target.value}` : `${CENTRE}/briefings`)}
                    options={[{ label: "NSW situation", value: "" }, ...data.watches.map((w) => ({ label: `Watch area: ${w.name}`, value: w.id }))]}
                />
            }
        />
        <CentreNotices shell={data} />
        <BriefingView key={data.briefing.watchId ?? "nsw"} briefing={data.briefing} shell={data} />
        <Card title="Cross-source correlations">
            {data.correlations.length ? (
                <ul className="divide-y divide-secondary">
                    {data.correlations.map((c) => (
                        <CorrelationItem key={c.id} correlation={c} />
                    ))}
                </ul>
            ) : (
                <p className="px-4 py-4 text-sm text-tertiary sm:px-5">
                    No records currently meet a correlation rule (for example, satellite detections within 5 km of an official fire, or road hazards near an
                    incident).
                </p>
            )}
        </Card>
    </>
);
