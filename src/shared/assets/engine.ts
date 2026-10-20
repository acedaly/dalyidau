// The deterministic rules of Home & Assets: when maintenance is next due, whether something is
// overdue or due soon, when a warranty ends, what a depreciation model gives, whether an asset is
// linked to verified cover, and the plain sentences reminders and briefings use. No model, no
// guessing: every answer comes from what a person recorded, and "not enough information" is an
// answer in its own right.
import { addDays, addMonthsToDate, daysBetween } from "../calendar/time";
import type { AttentionKind, CoverageState, Depreciation, DueState, IntervalUnit, OdometerUnit, PolicyStatus, ValueView, WarrantyState } from "./types";

// --- Intervals and due dates -----------------------------------------------------------------------

export const addInterval = (date: string, count: number, unit: IntervalUnit): string => {
    switch (unit) {
        case "days":
            return addDays(date, count);
        case "weeks":
            return addDays(date, count * 7);
        case "months":
            return addMonthsToDate(date, count);
        case "years":
            return addMonthsToDate(date, count * 12);
    }
};

export interface ScheduleRule {
    intervalCount: number | null;
    intervalUnit: IntervalUnit | null;
    intervalKm: number | null;
    firstDueOn: string | null;
    firstDueKm: number | null;
    lastDoneOn: string | null;
    lastDoneKm: number | null;
}

/**
 * The next due date and distance from the configured rule only. Never done: the first due date or
 * distance the person gave (or nothing). Done: when it was last done plus the interval. A date
 * interval with no date to count from, or a distance interval with no reading to count from, gives
 * no answer for that part.
 */
export function nextDue(rule: ScheduleRule): { dueOn: string | null; dueKm: number | null } {
    const dueOn =
        rule.intervalCount && rule.intervalUnit && rule.lastDoneOn
            ? addInterval(rule.lastDoneOn, rule.intervalCount, rule.intervalUnit)
            : (rule.firstDueOn ?? null);
    const dueKm = rule.intervalKm && rule.lastDoneKm !== null ? rule.lastDoneKm + rule.intervalKm : (rule.firstDueKm ?? null);
    return { dueOn, dueKm };
}

const RANK: Record<DueState, number> = { overdue: 3, due_soon: 2, upcoming: 1, unknown: 0 };

export interface DueInput {
    dueOn: string | null;
    dueKm: number | null;
    /** The latest odometer reading, if any. */
    currentKm: number | null;
    today: string;
    soonDays: number;
    soonKm: number;
}

/**
 * Overdue, due soon or upcoming, whichever of the date and the distance comes first. Unknown when
 * neither can be worked out (no due date, and no due distance or no odometer reading).
 */
export function dueState(input: DueInput): { state: DueState; remainingKm: number | null; reason: string | null } {
    let state: DueState = "unknown";
    let remainingKm: number | null = null;
    const worse = (s: DueState) => {
        if (RANK[s] > RANK[state]) state = s;
    };
    if (input.dueOn) {
        if (input.dueOn < input.today) worse("overdue");
        else if (input.dueOn <= addDays(input.today, input.soonDays)) worse("due_soon");
        else worse("upcoming");
    }
    if (input.dueKm !== null && input.currentKm !== null) {
        remainingKm = input.dueKm - input.currentKm;
        if (remainingKm <= 0) worse("overdue");
        else if (remainingKm <= input.soonKm) worse("due_soon");
        else worse("upcoming");
    }
    let reason: string | null = null;
    if (state === "unknown") {
        if (input.dueKm !== null && input.currentKm === null) reason = "Record an odometer reading to see when this is due.";
        else reason = "Record when this was last done, or when it's first due.";
    }
    return { state, remainingKm, reason };
}

// --- Warranties ----------------------------------------------------------------------------------

/**
 * A warranty's end from confirmed information only: the stated expiry date, or the start (or the
 * purchase date) plus the stated months. Otherwise unknown.
 */
export function warrantyExpiry(input: { expiresOn: string | null; startsOn: string | null; months: number | null; purchaseDate: string | null }): {
    expiresOn: string | null;
    basis: "stated" | "calculated" | "unknown";
} {
    if (input.expiresOn) return { expiresOn: input.expiresOn, basis: "stated" };
    const start = input.startsOn ?? input.purchaseDate;
    if (start && input.months) return { expiresOn: addMonthsToDate(start, input.months), basis: "calculated" };
    return { expiresOn: null, basis: "unknown" };
}

export function warrantyState(expiresOn: string | null, today: string, soonDays: number): WarrantyState {
    if (!expiresOn) return "unknown";
    if (expiresOn < today) return "expired";
    if (expiresOn <= addDays(today, soonDays)) return "expiring";
    return "active";
}

/** The best of several warranties: any active beats expiring beats unknown beats expired. */
export function bestWarranty(states: { state: WarrantyState; expiresOn: string | null }[]): { state: WarrantyState; expiresOn: string | null } {
    if (!states.length) return { state: "none", expiresOn: null };
    const order: WarrantyState[] = ["active", "expiring", "unknown", "expired"];
    for (const s of order) {
        const found = states.filter((w) => w.state === s).sort((a, b) => (b.expiresOn ?? "").localeCompare(a.expiresOn ?? ""));
        if (found.length) return found[0];
    }
    return { state: "none", expiresOn: null };
}

/**
 * Shown wherever warranty dates are: a manufacturer's warranty is in addition to the Australian
 * Consumer Law, and its end isn't the end of consumer guarantees. General information, not advice.
 */
export const CONSUMER_LAW_NOTE =
    "Warranties here are what a manufacturer, retailer or provider promised. They're in addition to the consumer guarantees under the Australian Consumer Law, which don't necessarily end when a stated warranty does: a product must last a reasonable time for its price and kind. This is general information, not legal advice; see accc.gov.au for your rights.";

// --- Values --------------------------------------------------------------------------------------

/**
 * What an optional depreciation model gives today, from the actual purchase price and date. Null
 * when the person hasn't turned one on, or the price or date isn't recorded. Always labelled as a
 * formula estimate.
 */
export function formulaValue(depreciation: Depreciation | null, purchaseCents: number | null, purchaseDate: string | null, today: string): ValueView | null {
    if (!depreciation || depreciation.method === "none" || purchaseCents === null || !purchaseDate || purchaseDate > today) return null;
    const years = Math.max(0, daysBetween(purchaseDate, today) / 365.25);
    let amount: number;
    if (depreciation.method === "straight_line") {
        const residual = (purchaseCents * depreciation.residualPercent) / 100;
        amount = purchaseCents - (purchaseCents - residual) * Math.min(1, years / depreciation.years);
    } else {
        amount = purchaseCents * (1 - depreciation.ratePercent / 100) ** years;
    }
    return { amountCents: Math.max(0, Math.round(amount)), basis: "formula", valuedOn: today };
}

// --- Insurance -----------------------------------------------------------------------------------

export interface LinkedPolicyState {
    status: PolicyStatus;
    verified: boolean;
    renewsOn: string | null;
}

/**
 * Whether an asset is linked to cover the household has confirmed. "verified" needs a linked policy
 * a person verified against its documents, that is active and not past its renewal date. Anything
 * else is reported as what it is; nothing here says an asset is insured.
 */
export function coverageState(policies: LinkedPolicyState[], today: string): Exclude<CoverageState, "hidden"> {
    if (!policies.length) return "none";
    const current = policies.filter((p) => p.status === "active" && (!p.renewsOn || p.renewsOn >= today));
    if (current.some((p) => p.verified)) return "verified";
    if (current.length) return "unverified";
    return "lapsed";
}

/** A yearly premium for comparison, when the frequency is a regular one. */
export const annualPremium = (cents: number | null, perYear: number | null) => (cents === null || perYear === null ? null : cents * perYear);

// --- Sentences -----------------------------------------------------------------------------------

export function inDays(days: number): string {
    if (days === 0) return "today";
    if (days === 1) return "tomorrow";
    if (days === -1) return "yesterday";
    if (days < 0) return `${-days} days ago`;
    return `in ${days} days`;
}

const DATE_SUBJECT: Record<Exclude<AttentionKind, "maintenance" | "repair">, { due: string; past: string }> = {
    registration: { due: "registration is due", past: "registration was due" },
    insurance: { due: "insurance renews", past: "insurance renewal was due" },
    warranty: { due: "warranty ends", past: "warranty ended" },
    inspection: { due: "inspection is due", past: "inspection was due" },
    lease: { due: "lease ends", past: "lease ended" },
    roadside: { due: "roadside assistance renews", past: "roadside assistance renewal was due" },
};

/** "Cub Camper Frontier registration is due in 21 days." Only from the record's own name and date. */
export function dateSentence(kind: Exclude<AttentionKind, "maintenance" | "repair">, name: string, days: number): string {
    const s = DATE_SUBJECT[kind];
    return `${name} ${days < 0 ? s.past : s.due} ${inDays(days)}.`;
}

/** "Hilux service is overdue by 12 days." / "… is due in 5 days." / "… is due in 800 km." */
export function maintenanceSentence(title: string, targetName: string, days: number | null, remainingKm: number | null, unit: OdometerUnit = "km"): string {
    const subject = title.toLowerCase().includes(targetName.toLowerCase()) ? title : `${targetName}: ${title}`;
    const parts: string[] = [];
    if (days !== null) parts.push(days < 0 ? `overdue by ${-days} ${-days === 1 ? "day" : "days"}` : `due ${inDays(days)}`);
    if (remainingKm !== null) {
        const label = unit === "hours" ? "hours" : unit;
        parts.push(remainingKm <= 0 ? `${-remainingKm} ${label} past due` : `due in ${remainingKm.toLocaleString("en-AU")} ${label}`);
    }
    return `${subject} is ${parts.length ? parts.join(", or ") : "due"}.`;
}

export const TASK_NOUN: Record<AttentionKind, string> = {
    maintenance: "Task",
    registration: "renewal Task",
    insurance: "renewal Task",
    warranty: "Task",
    inspection: "Task",
    lease: "Task",
    roadside: "renewal Task",
    repair: "Task",
};

export const daysFrom = (today: string, date: string) => daysBetween(today, date);
