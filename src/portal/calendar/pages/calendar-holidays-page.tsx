// NSW public holidays and NSW public school dates, from the NSW Government's own pages (with where
// each came from and when it was checked), plus your own dates: your school's development days,
// regional holidays and non-working days. Leave calculations use these, never a third-party feed.
import { useState } from "react";
import { ArrowLeft, ArrowRight, Plus, Trash01 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { DateField } from "@/portal/components/date-field";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import { NSW_PUBLIC_HOLIDAYS, NSW_SCHOOL_PERIODS, SOURCES, appliesTo } from "@/shared/calendar/nsw";
import { dayLabel, rangeLabel } from "@/shared/calendar/time";
import { CUSTOM_DATE_KINDS, CUSTOM_DATE_LABELS, type CustomDate, type CustomDateKind } from "@/shared/calendar/types";
import { calendarApi } from "../api";
import { CalendarHeader, Card } from "../shared";

const Source = ({ source }: { source: keyof typeof SOURCES }) => (
    <a href={SOURCES[source].url} target="_blank" rel="noopener noreferrer" className="text-xs text-tertiary hover:underline">
        Source, checked {dayLabel(SOURCES[source].verifiedOn)}
    </a>
);

export const CalendarHolidaysPage = ({ data }: { data: PageData<"calendar-holidays"> }) => {
    const toast = useToast();
    const [custom, setCustom] = useState<CustomDate[]>(data.customDates);
    const [draft, setDraft] = useState<{
        kind: CustomDateKind;
        name: string;
        start: string | null;
        end: string | null;
        school: string;
        region: string;
        scope: "personal" | "household";
    }>({
        kind: "development_day",
        name: "",
        start: null,
        end: null,
        school: "",
        region: "",
        scope: "household",
    });
    const year = data.year;
    const holidays = NSW_PUBLIC_HOLIDAYS.filter((h) => h.date.startsWith(String(year)));
    const school = NSW_SCHOOL_PERIODS.filter((p) => p.year === year && appliesTo(p, data.division));
    const add = async () => {
        if (!draft.start) return;
        try {
            setCustom(
                (
                    await calendarApi.addCustomDate({
                        kind: draft.kind,
                        name: draft.name.trim(),
                        start: draft.start,
                        end: draft.end ?? draft.start,
                        school: draft.school.trim() || null,
                        region: draft.region.trim() || null,
                        scope: draft.kind === "non_working" ? "personal" : draft.scope,
                    })
                ).customDates,
            );
            setDraft({ ...draft, name: "", start: null, end: null });
            toast.success("Date added");
        } catch (error) {
            toast.error("Couldn't add it", errorMessage(error));
        }
    };

    return (
        <>
            <CalendarHeader
                shell={data}
                title={`Holidays and school dates ${year}`}
                description={`NSW public holidays and ${data.division === "western" ? "Western" : "Eastern"} division school dates. Change the division in Settings.`}
                crumb={{ label: "Holidays and school dates" }}
                actions={
                    <>
                        <Button size="md" color="secondary" iconLeading={ArrowLeft} href={`/portal/calendar/holidays?year=${year - 1}`}>
                            {year - 1}
                        </Button>
                        <Button size="md" color="secondary" iconTrailing={ArrowRight} href={`/portal/calendar/holidays?year=${year + 1}`}>
                            {year + 1}
                        </Button>
                    </>
                }
            />
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                <Card
                    title="NSW public holidays"
                    description="Statewide holidays and additional days. The Bank Holiday is only for banks and some financial institutions; turn it on in Leave settings if it applies to you."
                >
                    {holidays.length ? (
                        <ul className="flex flex-col divide-y divide-secondary">
                            {holidays.map((h) => (
                                <li key={h.date} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                                    <span className="flex flex-col">
                                        <span className="text-sm font-medium text-primary">{h.name}</span>
                                        <Source source={h.source} />
                                    </span>
                                    <span className="flex items-center gap-2">
                                        {h.kind === "bank" && (
                                            <Badge size="sm" color="gray">
                                                Not a public holiday
                                            </Badge>
                                        )}
                                        {h.provisional && (
                                            <Badge size="sm" color="warning">
                                                Provisional
                                            </Badge>
                                        )}
                                        <span className="text-sm text-tertiary tabular-nums">{dayLabel(h.date)}</span>
                                    </span>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="text-sm text-tertiary">
                            The NSW Government hasn't published {year}'s public holidays, so none are included. Leave for {year} is costed without them.
                        </p>
                    )}
                </Card>
                <Card
                    title="NSW public school dates"
                    description="Terms, school holidays and school development days (students absent). Schools near the Victorian and Queensland borders, and non-government schools, may differ."
                >
                    {school.length ? (
                        <ul className="flex flex-col divide-y divide-secondary">
                            {school.map((p) => (
                                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                                    <span className="flex flex-col">
                                        <span className="text-sm font-medium text-primary">{p.name}</span>
                                        <Source source={p.source} />
                                    </span>
                                    <span className="flex items-center gap-2">
                                        {p.provisional && (
                                            <Badge size="sm" color="warning">
                                                Provisional
                                            </Badge>
                                        )}
                                        <Badge size="sm" color={p.kind === "holidays" ? "success" : p.kind === "development_day" ? "blue" : "gray"}>
                                            {p.kind === "holidays" ? "Holidays" : p.kind === "development_day" ? "Development day" : "Term"}
                                        </Badge>
                                        <span className="text-sm text-tertiary tabular-nums">{rangeLabel(p.start, p.end, String(year))}</span>
                                    </span>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="text-sm text-tertiary">No published school dates for {year} yet.</p>
                    )}
                </Card>
            </div>
            <Card
                title="Your own dates"
                description="Your school's development days and events, regional public holidays and your own non-working days (days you don't work and need no leave for). Household dates are seen by everyone who uses Calendar here."
            >
                {custom.length ? (
                    <ul className="flex flex-col divide-y divide-secondary">
                        {custom.map((d) => (
                            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                                <span className="flex flex-col">
                                    <span className="text-sm font-medium text-primary">
                                        {d.name}
                                        {d.school ? ` · ${d.school}` : ""}
                                        {d.region ? ` · ${d.region}` : ""}
                                    </span>
                                    <span className="text-xs text-tertiary">
                                        {CUSTOM_DATE_LABELS[d.kind]} · {d.scope === "household" ? "household" : "only you"}
                                        {!d.mine && " · added by someone else"}
                                    </span>
                                </span>
                                <span className="flex items-center gap-2">
                                    <span className="text-sm text-tertiary">{rangeLabel(d.start, d.end)}</span>
                                    {d.mine && (
                                        <ButtonUtility
                                            size="xs"
                                            color="tertiary"
                                            icon={Trash01}
                                            tooltip="Remove"
                                            onClick={async () => {
                                                try {
                                                    setCustom((await calendarApi.deleteCustomDate(d.id)).customDates);
                                                } catch (error) {
                                                    toast.error("Couldn't remove it", errorMessage(error));
                                                }
                                            }}
                                        />
                                    )}
                                </span>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="text-sm text-tertiary">None yet.</p>
                )}
                <form
                    className="grid grid-cols-1 gap-4 border-t border-secondary pt-4 md:grid-cols-2 xl:grid-cols-3"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void add();
                    }}
                >
                    <Select
                        label="Kind"
                        value={draft.kind}
                        onChange={(k) => k && setDraft({ ...draft, kind: k as CustomDateKind })}
                        items={CUSTOM_DATE_KINDS.map((k) => ({ id: k, label: CUSTOM_DATE_LABELS[k] }))}
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                    <Input
                        label="Name"
                        isRequired
                        value={draft.name}
                        onChange={(name) => setDraft({ ...draft, name })}
                        placeholder="e.g. School development day"
                    />
                    {(draft.kind === "development_day" || draft.kind === "school_holiday" || draft.kind === "school_event") && (
                        <Input
                            label="School"
                            value={draft.school}
                            onChange={(school) => setDraft({ ...draft, school })}
                            placeholder="e.g. Riverside Public School"
                        />
                    )}
                    {draft.kind === "regional_holiday" && (
                        <Input
                            label="Region"
                            value={draft.region}
                            onChange={(region) => setDraft({ ...draft, region })}
                            placeholder="Matches your region in Leave settings"
                        />
                    )}
                    <DateField
                        label="From"
                        isRequired
                        value={draft.start}
                        onChange={(start) => setDraft({ ...draft, start, end: draft.end && start && draft.end < start ? start : draft.end })}
                    />
                    <DateField label="To" value={draft.end} onChange={(end) => setDraft({ ...draft, end })} hint="Leave empty for one day" />
                    {draft.kind !== "non_working" && (
                        <Select
                            label="Who sees it"
                            value={draft.scope}
                            onChange={(k) => k && setDraft({ ...draft, scope: k as "personal" | "household" })}
                            items={[
                                { id: "household", label: "The household" },
                                { id: "personal", label: "Only me" },
                            ]}
                        >
                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                        </Select>
                    )}
                    <div className="flex items-end">
                        <Button type="submit" size="md" iconLeading={Plus} isDisabled={!draft.name.trim() || !draft.start}>
                            Add date
                        </Button>
                    </div>
                </form>
            </Card>
        </>
    );
};
