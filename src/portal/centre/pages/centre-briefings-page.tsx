// Briefings: the NSW situation or one watch area, as facts from stored records with an optional,
// labelled interpretation. Correlations are listed with their evidence and limitations.
import { Badge } from "@/components/base/badges/badges";
import { NativeSelect } from "@/components/base/select/select-native";
import { Card } from "@/portal/knowledge/pages/knowledge-home-page";
import type { PageData } from "@/portal/lib/page-types";
import { BriefingView } from "../briefing-view";
import { CENTRE, CentreHeader, CentreNotices, recordHref } from "../shared";

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
                        <li key={c.id} className="flex flex-col gap-2 px-4 py-3 sm:px-5">
                            <div className="flex flex-wrap items-center gap-2">
                                <Badge size="sm" type="color" color="purple">
                                    Derived · {c.confidence} confidence
                                </Badge>
                                <span className="text-sm font-semibold text-primary">{c.title}</span>
                            </div>
                            <p className="text-sm text-tertiary">{c.explanation}</p>
                            <ul className="flex flex-col gap-0.5 text-sm">
                                {c.records.map((r) => (
                                    <li key={r.recordId}>
                                        <a href={recordHref(r.recordId)} className="text-secondary hover:underline">
                                            {r.title}
                                        </a>
                                        <span className="text-xs text-tertiary">
                                            {" "}
                                            · {r.provider}
                                            {r.distanceKm !== null ? ` · ${r.distanceKm} km` : ""}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                            <p className="text-xs text-quaternary">
                                Limitations: {c.limitations} These records may be related; nothing here says one caused another.
                            </p>
                        </li>
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
