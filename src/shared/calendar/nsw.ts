// Official NSW public holidays and NSW public school terms, as published by the NSW Government.
//
// These ship with the code rather than coming from a third-party feed, so leave calculations never
// depend on someone else's calendar being right or reachable. Every entry records where it came
// from and when it was checked. Years the government hasn't published yet are marked provisional
// (worked out from the Public Holidays Act 2010 rules) and say so wherever they're shown.
//
// To add a year: copy the published dates from the source pages below, set `verifiedOn`, and run
// `npm test` (test/calendar-nsw.test.ts checks every date's weekday and ordering).

export type HolidayKind = "public" | "additional" | "bank";

export interface PublicHoliday {
    date: string;
    name: string;
    /** public: a declared public holiday; additional: the extra day when one falls on a weekend; bank: not a public holiday (banks and some financial institutions only). */
    kind: HolidayKind;
    source: SourceKey;
    provisional?: boolean;
}

export type SchoolDivision = "eastern" | "western";

export interface SchoolPeriod {
    /** Stable id, e.g. "2026-autumn" or "2026-t1-western". */
    id: string;
    year: number;
    kind: "term" | "holidays" | "development_day";
    name: string;
    start: string;
    end: string;
    /** Which division it applies to; "both" when the dates are the same. */
    division: SchoolDivision | "both";
    source: SourceKey;
    provisional?: boolean;
}

export type SourceKey = "nsw-public-holidays" | "nsw-public-holidays-2025-ics" | "nsw-act" | "nsw-school-2026" | "nsw-school-2027" | "nsw-school-other";

export const SOURCES: Record<SourceKey, { label: string; url: string; verifiedOn: string }> = {
    "nsw-public-holidays": {
        label: "NSW Government: Public holidays (2026 and 2027)",
        url: "https://www.nsw.gov.au/about-nsw/public-holidays",
        verifiedOn: "2026-10-18",
    },
    "nsw-public-holidays-2025-ics": {
        label: "NSW Government: 2025 public holidays iCalendar",
        url: "https://staticontent.premiersdepartment.nsw.gov.au/ir/calendar/NSW-Public-Holidays-dates-2025.ics",
        verifiedOn: "2026-10-18",
    },
    "nsw-act": {
        label: "Public Holidays Act 2010 (NSW): fixed dates and weekend rules (not yet published for this year)",
        url: "https://legislation.nsw.gov.au/view/html/inforce/current/act-2010-115",
        verifiedOn: "2026-10-18",
    },
    "nsw-school-2026": {
        label: "NSW Department of Education: 2026 term dates",
        url: "https://education.nsw.gov.au/schooling/calendars/2026",
        verifiedOn: "2026-10-18",
    },
    "nsw-school-2027": {
        label: "NSW Department of Education: 2027 term dates",
        url: "https://education.nsw.gov.au/schooling/calendars/2027",
        verifiedOn: "2026-10-18",
    },
    "nsw-school-other": {
        label: "NSW Department of Education: future and past term and vacation dates",
        url: "https://education.nsw.gov.au/schooling/calendars/future-and-past-nsw-term-and-vacation-dates",
        verifiedOn: "2026-10-18",
    },
};

const h = (date: string, name: string, kind: HolidayKind, source: SourceKey, provisional = false): PublicHoliday => ({
    date,
    name,
    kind,
    source,
    ...(provisional ? { provisional: true } : {}),
});

export const NSW_PUBLIC_HOLIDAYS: readonly PublicHoliday[] = [
    // 2025: the government's iCalendar file (New Year's Day isn't in it; it's fixed by the Act).
    h("2025-01-01", "New Year's Day", "public", "nsw-act"),
    h("2025-01-27", "Australia Day", "public", "nsw-public-holidays-2025-ics"),
    h("2025-04-18", "Good Friday", "public", "nsw-public-holidays-2025-ics"),
    h("2025-04-19", "Easter Saturday", "public", "nsw-public-holidays-2025-ics"),
    h("2025-04-20", "Easter Sunday", "public", "nsw-public-holidays-2025-ics"),
    h("2025-04-21", "Easter Monday", "public", "nsw-public-holidays-2025-ics"),
    h("2025-04-25", "Anzac Day", "public", "nsw-public-holidays-2025-ics"),
    h("2025-06-09", "King's Birthday", "public", "nsw-public-holidays-2025-ics"),
    h("2025-08-04", "Bank Holiday", "bank", "nsw-act"),
    h("2025-10-06", "Labour Day", "public", "nsw-public-holidays-2025-ics"),
    h("2025-12-25", "Christmas Day", "public", "nsw-public-holidays-2025-ics"),
    h("2025-12-26", "Boxing Day", "public", "nsw-public-holidays-2025-ics"),
    // 2026
    h("2026-01-01", "New Year's Day", "public", "nsw-public-holidays"),
    h("2026-01-26", "Australia Day", "public", "nsw-public-holidays"),
    h("2026-04-03", "Good Friday", "public", "nsw-public-holidays"),
    h("2026-04-04", "Easter Saturday", "public", "nsw-public-holidays"),
    h("2026-04-05", "Easter Sunday", "public", "nsw-public-holidays"),
    h("2026-04-06", "Easter Monday", "public", "nsw-public-holidays"),
    h("2026-04-25", "Anzac Day", "public", "nsw-public-holidays"),
    h("2026-04-27", "Anzac Day (additional day)", "additional", "nsw-public-holidays"),
    h("2026-06-08", "King's Birthday", "public", "nsw-public-holidays"),
    h("2026-08-03", "Bank Holiday", "bank", "nsw-public-holidays"),
    h("2026-10-05", "Labour Day", "public", "nsw-public-holidays"),
    h("2026-12-25", "Christmas Day", "public", "nsw-public-holidays"),
    h("2026-12-26", "Boxing Day", "public", "nsw-public-holidays"),
    h("2026-12-28", "Boxing Day (additional day)", "additional", "nsw-public-holidays"),
    // 2027
    h("2027-01-01", "New Year's Day", "public", "nsw-public-holidays"),
    h("2027-01-26", "Australia Day", "public", "nsw-public-holidays"),
    h("2027-03-26", "Good Friday", "public", "nsw-public-holidays"),
    h("2027-03-27", "Easter Saturday", "public", "nsw-public-holidays"),
    h("2027-03-28", "Easter Sunday", "public", "nsw-public-holidays"),
    h("2027-03-29", "Easter Monday", "public", "nsw-public-holidays"),
    h("2027-04-25", "Anzac Day", "public", "nsw-public-holidays"),
    h("2027-04-26", "Anzac Day (additional day)", "additional", "nsw-public-holidays"),
    h("2027-06-14", "King's Birthday", "public", "nsw-public-holidays"),
    h("2027-08-02", "Bank Holiday", "bank", "nsw-public-holidays"),
    h("2027-10-04", "Labour Day", "public", "nsw-public-holidays"),
    h("2027-12-25", "Christmas Day", "public", "nsw-public-holidays"),
    h("2027-12-26", "Boxing Day", "public", "nsw-public-holidays"),
    h("2027-12-27", "Christmas Day (additional day)", "additional", "nsw-public-holidays"),
    h("2027-12-28", "Boxing Day (additional day)", "additional", "nsw-public-holidays"),
    // 2028: not yet published. Worked out from the Act's fixed dates and weekend rules, and Easter.
    h("2028-01-01", "New Year's Day", "public", "nsw-act", true),
    h("2028-01-03", "New Year's Day (additional day)", "additional", "nsw-act", true),
    h("2028-01-26", "Australia Day", "public", "nsw-act", true),
    h("2028-04-14", "Good Friday", "public", "nsw-act", true),
    h("2028-04-15", "Easter Saturday", "public", "nsw-act", true),
    h("2028-04-16", "Easter Sunday", "public", "nsw-act", true),
    h("2028-04-17", "Easter Monday", "public", "nsw-act", true),
    h("2028-04-25", "Anzac Day", "public", "nsw-act", true),
    h("2028-06-12", "King's Birthday", "public", "nsw-act", true),
    h("2028-08-07", "Bank Holiday", "bank", "nsw-act", true),
    h("2028-10-02", "Labour Day", "public", "nsw-act", true),
    h("2028-12-25", "Christmas Day", "public", "nsw-act", true),
    h("2028-12-26", "Boxing Day", "public", "nsw-act", true),
];

const p = (
    id: string,
    year: number,
    kind: SchoolPeriod["kind"],
    name: string,
    start: string,
    end: string,
    division: SchoolPeriod["division"],
    source: SourceKey,
    provisional = false,
): SchoolPeriod => ({ id, year, kind, name, start, end, division, source, ...(provisional ? { provisional: true } : {}) });

/**
 * Student term dates, school holidays and school development days (students absent) for NSW public
 * schools. 2025 and 2028 term dates on the department's page include the development days.
 * Schools near the Victorian and Queensland borders, and non-government schools, may differ: add
 * their dates as custom school dates.
 */
export const NSW_SCHOOL_PERIODS: readonly SchoolPeriod[] = [
    // 2025
    p("2025-t1-eastern", 2025, "term", "Term 1", "2025-01-31", "2025-04-11", "eastern", "nsw-school-other"),
    p("2025-t1-western", 2025, "term", "Term 1", "2025-02-07", "2025-04-11", "western", "nsw-school-other"),
    p("2025-sdd1-eastern", 2025, "development_day", "School development days", "2025-01-31", "2025-02-05", "eastern", "nsw-school-other"),
    p("2025-sdd1-western", 2025, "development_day", "School development days", "2025-02-07", "2025-02-12", "western", "nsw-school-other"),
    p("2025-autumn", 2025, "holidays", "Autumn school holidays", "2025-04-14", "2025-04-24", "both", "nsw-school-other"),
    p("2025-t2", 2025, "term", "Term 2", "2025-04-28", "2025-07-04", "both", "nsw-school-other"),
    p("2025-sdd2", 2025, "development_day", "School development days", "2025-04-28", "2025-04-29", "both", "nsw-school-other"),
    p("2025-winter", 2025, "holidays", "Winter school holidays", "2025-07-07", "2025-07-18", "both", "nsw-school-other"),
    p("2025-t3", 2025, "term", "Term 3", "2025-07-21", "2025-09-26", "both", "nsw-school-other"),
    p("2025-sdd3", 2025, "development_day", "School development day", "2025-07-21", "2025-07-21", "both", "nsw-school-other"),
    p("2025-spring", 2025, "holidays", "Spring school holidays", "2025-09-29", "2025-10-10", "both", "nsw-school-other"),
    p("2025-t4", 2025, "term", "Term 4", "2025-10-13", "2025-12-19", "both", "nsw-school-other"),
    p("2025-sdd4", 2025, "development_day", "School development day", "2025-10-13", "2025-10-13", "both", "nsw-school-other"),
    p("2025-summer-eastern", 2025, "holidays", "Summer school holidays", "2025-12-22", "2026-01-26", "eastern", "nsw-school-other"),
    p("2025-summer-western", 2025, "holidays", "Summer school holidays", "2025-12-22", "2026-02-02", "western", "nsw-school-other"),
    // 2026
    p("2026-sdd1-eastern", 2026, "development_day", "School development days", "2026-01-27", "2026-01-30", "eastern", "nsw-school-2026"),
    p("2026-sdd1-western", 2026, "development_day", "School development days", "2026-02-03", "2026-02-06", "western", "nsw-school-2026"),
    p("2026-t1-eastern", 2026, "term", "Term 1", "2026-02-02", "2026-04-02", "eastern", "nsw-school-2026"),
    p("2026-t1-western", 2026, "term", "Term 1", "2026-02-09", "2026-04-02", "western", "nsw-school-2026"),
    p("2026-autumn", 2026, "holidays", "Autumn school holidays", "2026-04-07", "2026-04-17", "both", "nsw-school-2026"),
    p("2026-sdd2", 2026, "development_day", "School development days", "2026-04-20", "2026-04-21", "both", "nsw-school-2026"),
    p("2026-t2", 2026, "term", "Term 2", "2026-04-22", "2026-07-03", "both", "nsw-school-2026"),
    p("2026-winter", 2026, "holidays", "Winter school holidays", "2026-07-06", "2026-07-17", "both", "nsw-school-2026"),
    p("2026-sdd3", 2026, "development_day", "School development day", "2026-07-20", "2026-07-20", "both", "nsw-school-2026"),
    p("2026-t3", 2026, "term", "Term 3", "2026-07-21", "2026-09-25", "both", "nsw-school-2026"),
    p("2026-spring", 2026, "holidays", "Spring school holidays", "2026-09-28", "2026-10-09", "both", "nsw-school-2026"),
    p("2026-sdd4", 2026, "development_day", "School development day", "2026-10-12", "2026-10-12", "both", "nsw-school-2026"),
    p("2026-t4", 2026, "term", "Term 4", "2026-10-13", "2026-12-17", "both", "nsw-school-2026"),
    p("2026-summer-eastern", 2026, "holidays", "Summer school holidays", "2026-12-18", "2027-01-27", "eastern", "nsw-school-2026"),
    p("2026-summer-western", 2026, "holidays", "Summer school holidays", "2026-12-18", "2027-02-03", "western", "nsw-school-2026"),
    // 2027
    p("2027-sdd1-eastern", 2027, "development_day", "School development days", "2027-01-28", "2027-02-02", "eastern", "nsw-school-2027"),
    p("2027-sdd1-western", 2027, "development_day", "School development days", "2027-02-04", "2027-02-09", "western", "nsw-school-2027"),
    p("2027-t1-eastern", 2027, "term", "Term 1", "2027-02-03", "2027-04-09", "eastern", "nsw-school-2027"),
    p("2027-t1-western", 2027, "term", "Term 1", "2027-02-10", "2027-04-09", "western", "nsw-school-2027"),
    p("2027-autumn", 2027, "holidays", "Autumn school holidays", "2027-04-12", "2027-04-23", "both", "nsw-school-2027"),
    p("2027-sdd2", 2027, "development_day", "School development days", "2027-04-27", "2027-04-28", "both", "nsw-school-2027"),
    p("2027-t2", 2027, "term", "Term 2", "2027-04-29", "2027-07-02", "both", "nsw-school-2027"),
    p("2027-winter", 2027, "holidays", "Winter school holidays", "2027-07-05", "2027-07-16", "both", "nsw-school-2027"),
    p("2027-sdd3", 2027, "development_day", "School development day", "2027-07-19", "2027-07-19", "both", "nsw-school-2027"),
    p("2027-t3", 2027, "term", "Term 3", "2027-07-20", "2027-09-24", "both", "nsw-school-2027"),
    p("2027-spring", 2027, "holidays", "Spring school holidays", "2027-09-27", "2027-10-08", "both", "nsw-school-2027"),
    p("2027-sdd4", 2027, "development_day", "School development day", "2027-10-11", "2027-10-11", "both", "nsw-school-2027"),
    p("2027-t4", 2027, "term", "Term 4", "2027-10-12", "2027-12-20", "both", "nsw-school-2027"),
    p("2027-summer-eastern", 2027, "holidays", "Summer school holidays", "2027-12-21", "2028-01-28", "eastern", "nsw-school-2027"),
    p("2027-summer-western", 2027, "holidays", "Summer school holidays", "2027-12-21", "2028-02-04", "western", "nsw-school-2027"),
    // 2028: published in advance without development days; the department may still change it.
    p("2028-t1-eastern", 2028, "term", "Term 1", "2028-01-31", "2028-04-07", "eastern", "nsw-school-other", true),
    p("2028-t1-western", 2028, "term", "Term 1", "2028-02-07", "2028-04-07", "western", "nsw-school-other", true),
    p("2028-autumn", 2028, "holidays", "Autumn school holidays", "2028-04-10", "2028-04-21", "both", "nsw-school-other", true),
    p("2028-t2", 2028, "term", "Term 2", "2028-04-24", "2028-07-07", "both", "nsw-school-other", true),
    p("2028-winter", 2028, "holidays", "Winter school holidays", "2028-07-10", "2028-07-21", "both", "nsw-school-other", true),
    p("2028-t3", 2028, "term", "Term 3", "2028-07-24", "2028-09-29", "both", "nsw-school-other", true),
    p("2028-spring", 2028, "holidays", "Spring school holidays", "2028-10-03", "2028-10-13", "both", "nsw-school-other", true),
    p("2028-t4", 2028, "term", "Term 4", "2028-10-16", "2028-12-21", "both", "nsw-school-other", true),
    p("2028-summer-eastern", 2028, "holidays", "Summer school holidays", "2028-12-22", "2029-01-25", "eastern", "nsw-school-other", true),
    p("2028-summer-western", 2028, "holidays", "Summer school holidays", "2028-12-22", "2029-02-02", "western", "nsw-school-other", true),
];

/** The years this dataset covers, so callers can say when a date is outside it rather than implying there are no holidays. */
export const COVERED_YEARS = { publicHolidays: [2025, 2028], school: [2025, 2028] } as const;

export const appliesTo = (period: SchoolPeriod, division: SchoolDivision) => period.division === "both" || period.division === division;

/** Public holidays between two dates (inclusive). Bank holidays only when asked for. */
export const publicHolidaysBetween = (from: string, to: string, options: { includeBank?: boolean } = {}) =>
    NSW_PUBLIC_HOLIDAYS.filter((d) => d.date >= from && d.date <= to && (options.includeBank || d.kind !== "bank"));

/** School periods overlapping two dates (inclusive) for one division. */
export const schoolPeriodsBetween = (
    from: string,
    to: string,
    division: SchoolDivision,
    kinds: SchoolPeriod["kind"][] = ["term", "holidays", "development_day"],
) => NSW_SCHOOL_PERIODS.filter((s) => s.end >= from && s.start <= to && appliesTo(s, division) && kinds.includes(s.kind));
