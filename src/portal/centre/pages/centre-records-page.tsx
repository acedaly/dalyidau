// Incidents and warnings (and everything else), as a filterable list. Filters are a plain GET form,
// so a filtered list is a link that can be bookmarked, and it works before JavaScript loads.
import { AlertTriangle, FilterLines } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { NativeSelect } from "@/components/base/select/select-native";
import { Empty } from "@/portal/components/empty";
import { Card } from "@/portal/knowledge/pages/knowledge-home-page";
import { pluralise } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { CATEGORY_LABELS, HAZARD_CATEGORIES, IMPLEMENTED_SOURCES } from "@/shared/centre/sources";
import { RECORD_KINDS, RECORD_KIND_LABELS } from "@/shared/centre/types";
import { CENTRE, CentreHeader, CentreNotices, RecordRow } from "../shared";

export const CentreRecordsPage = ({ data }: { data: PageData<"centre-records"> }) => {
    const f = data.filters;
    const active = [f.q, f.category, f.kind, f.source, f.minLevel, f.watch, f.includeInactive].filter(Boolean).length;
    const watch = data.watches.find((w) => w.id === f.watch);
    return (
        <>
            <CentreHeader
                title={watch ? `Records: ${watch.name}` : "Incidents and warnings"}
                crumb="Incidents and warnings"
                shell={data}
                description="Current records from the sources that are on, most serious first. Levels are the providers' own."
            />
            <CentreNotices shell={data} />
            <form
                method="get"
                action={`${CENTRE}/records`}
                className="flex flex-col gap-4 rounded-xl bg-primary p-4 shadow-xs ring-1 ring-secondary ring-inset"
                aria-label="Filter records"
            >
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    <Input label="Search" name="q" defaultValue={f.q} placeholder="Title, place or type" />
                    <NativeSelect
                        className="min-w-0"
                        selectClassName="w-full min-w-0"
                        label="Hazard"
                        name="category"
                        defaultValue={f.category ?? ""}
                        options={[{ label: "All hazards", value: "" }, ...HAZARD_CATEGORIES.map((c) => ({ label: CATEGORY_LABELS[c], value: c }))]}
                    />
                    <NativeSelect
                        label="Kind"
                        name="kind"
                        defaultValue={f.kind ?? ""}
                        options={[{ label: "All kinds", value: "" }, ...RECORD_KINDS.map((k) => ({ label: RECORD_KIND_LABELS[k], value: k }))]}
                    />
                    <NativeSelect
                        className="min-w-0"
                        selectClassName="w-full min-w-0"
                        label="Source"
                        name="source"
                        defaultValue={f.source ?? ""}
                        options={[
                            { label: "All sources", value: "" },
                            ...IMPLEMENTED_SOURCES.map((s) => ({ label: `${s.provider}: ${s.dataset}`, value: s.id })),
                        ]}
                    />
                    <NativeSelect
                        className="min-w-0"
                        selectClassName="w-full min-w-0"
                        label="Warning level"
                        name="minLevel"
                        defaultValue={String(f.minLevel)}
                        hint="As published (Australian Warning System)"
                        options={[
                            { label: "Any", value: "0" },
                            { label: "Advice and above", value: "1" },
                            { label: "Watch and Act and above", value: "2" },
                            { label: "Emergency Warning", value: "3" },
                        ]}
                    />
                    <NativeSelect
                        className="min-w-0"
                        selectClassName="w-full min-w-0"
                        label="Watch area"
                        name="watch"
                        defaultValue={f.watch ?? ""}
                        options={[{ label: "Everywhere", value: "" }, ...data.watches.map((w) => ({ label: w.name, value: w.id }))]}
                    />
                    <div className="flex items-end">
                        <Checkbox label="Include records no longer in the feed" name="includeInactive" value="1" defaultSelected={f.includeInactive} />
                    </div>
                </div>
                <div className="flex flex-wrap gap-3">
                    <Button size="md" type="submit" iconLeading={FilterLines}>
                        Apply filters
                    </Button>
                    {active > 0 && (
                        <Button size="md" color="secondary" href={`${CENTRE}/records`}>
                            Clear filters
                        </Button>
                    )}
                </div>
            </form>
            <Card title={pluralise(data.records.length, "record")} icon={AlertTriangle}>
                {data.records.length ? (
                    <ul className="divide-y divide-secondary">
                        {data.records.map((r) => (
                            <RecordRow key={r.id} record={r} reason={data.reasons[r.id]} />
                        ))}
                    </ul>
                ) : (
                    <Empty
                        icon={AlertTriangle}
                        title="Nothing matches"
                        description="No current records match these filters in the sources that are on. That isn't confirmation that nothing is happening: check official channels."
                        size="sm"
                    />
                )}
                {data.truncated && (
                    <p className="border-t border-secondary px-4 py-3 text-xs text-warning-primary sm:px-5">
                        Only the first records are shown. Narrow the filters to see the rest.
                    </p>
                )}
            </Card>
        </>
    );
};
