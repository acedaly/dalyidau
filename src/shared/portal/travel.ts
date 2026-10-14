// Courtesy bus and accommodation answers, collected once per household on the native RSVP.
// Shared by the guest form, the Worker and the Wedding Planner so the choices, the validation and
// the follow-up rules can never disagree.
//
// This is information gathering for the Dubbo RSL booking, not a booking system: nothing here
// reserves a seat, a pick-up or a room.

export const BUS_CHOICES = ["to", "home", "both", "none", "unsure"] as const;
export type BusChoice = (typeof BUS_CHOICES)[number];

export const STAY_CHOICES = ["glamping", "dubbo", "family", "home", "unsure"] as const;
export type StayChoice = (typeof STAY_CHOICES)[number];

export const BUS_LABELS: Record<BusChoice, string> = {
    to: "Yes — to the wedding",
    home: "Yes — home after the reception",
    both: "Yes — both ways",
    none: "No — we'll arrange our own transport",
    unsure: "Not sure yet",
};

/** Short labels for tables, CSVs and narrow screens. */
export const BUS_SHORT_LABELS: Record<BusChoice, string> = {
    to: "To the wedding",
    home: "Home after",
    both: "Both ways",
    none: "Own transport",
    unsure: "Not sure yet",
};

export const STAY_LABELS: Record<StayChoice, string> = {
    glamping: "Rhino Lodge glamping",
    dubbo: "Accommodation in Dubbo",
    family: "Staying with family or friends",
    home: "Travelling home",
    unsure: "Not sure yet",
};

export interface RsvpTravel {
    /** Null until the household answers; every answer is optional. */
    bus: BusChoice | null;
    /** Passengers to Rhino Lodge. Only non-zero for "to" and "both". */
    outbound: number;
    /** Passengers back to town. Only non-zero for "home" and "both". */
    return: number;
    stay: StayChoice | null;
    /** Only kept for "Accommodation in Dubbo". Helps find possible pick-up points; never a promise of one. */
    stayLocation: string | null;
}

export const EMPTY_TRAVEL: RsvpTravel = { bus: null, outbound: 0, return: 0, stay: null, stayLocation: null };

export const STAY_LOCATION_MAX = 200;

export const needsOutbound = (bus: BusChoice | null) => bus === "to" || bus === "both";
export const needsReturn = (bus: BusChoice | null) => bus === "home" || bus === "both";

const isBus = (value: unknown): value is BusChoice => typeof value === "string" && (BUS_CHOICES as readonly string[]).includes(value);
const isStay = (value: unknown): value is StayChoice => typeof value === "string" && (STAY_CHOICES as readonly string[]).includes(value);

/**
 * Normalises a household's travel answer against the number of guests coming, or returns an error.
 * Counts that don't apply to the chosen direction are zeroed, and the accommodation name is only
 * kept for Dubbo accommodation, so a changed answer never leaves stale seats behind.
 */
export function validateTravel(input: unknown, attending: number): { value: RsvpTravel } | { error: string; field: keyof RsvpTravel } {
    const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const bus = raw.bus === null || raw.bus === undefined || raw.bus === "" ? null : raw.bus;
    const stay = raw.stay === null || raw.stay === undefined || raw.stay === "" ? null : raw.stay;
    if (bus !== null && !isBus(bus)) return { error: "Choose one of the courtesy bus options.", field: "bus" };
    if (stay !== null && !isStay(stay)) return { error: "Choose one of the accommodation options.", field: "stay" };

    const count = (value: unknown, applies: boolean, field: "outbound" | "return", direction: string) => {
        if (!applies) return { value: 0 };
        // With one guest coming, the count is implied.
        if (attending === 1 && (value === undefined || value === null || value === "")) return { value: 1 };
        const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
        if (!Number.isInteger(n) || n < 1) return { error: `Let us know how many of you need the bus ${direction}.`, field };
        if (n > attending)
            return {
                error: `Only ${attending} ${attending === 1 ? "person is" : "people are"} coming, so the bus ${direction} can be for up to ${attending}.`,
                field,
            };
        return { value: n };
    };
    const outbound = count(raw.outbound, needsOutbound(bus as BusChoice | null), "outbound", "to the wedding");
    if ("error" in outbound) return outbound as { error: string; field: "outbound" };
    const back = count(raw.return, needsReturn(bus as BusChoice | null), "return", "home");
    if ("error" in back) return back as { error: string; field: "return" };

    const location = typeof raw.stayLocation === "string" ? raw.stayLocation.trim().replace(/\s+/g, " ") : "";
    if (location.length > STAY_LOCATION_MAX)
        return { error: `Please keep the accommodation name under ${STAY_LOCATION_MAX} characters.`, field: "stayLocation" };

    return {
        value: {
            bus: bus as BusChoice | null,
            outbound: outbound.value!,
            return: back.value!,
            stay: stay as StayChoice | null,
            stayLocation: stay === "dubbo" && location ? location : null,
        },
    };
}

/** True when the household has said anything at all about travel. */
export const hasTravelAnswer = (travel: RsvpTravel | null | undefined) => !!travel && (travel.bus !== null || travel.stay !== null);

// ---------------------------------------------------------------------------------------------
// Follow-up rules for the Wedding Planner

export const FOLLOW_UP_REASONS = ["unsure_bus", "unsure_stay", "glamping", "seats_exceed", "not_attending"] as const;
export type FollowUpReason = (typeof FOLLOW_UP_REASONS)[number];

export const FOLLOW_UP_LABELS: Record<FollowUpReason, string> = {
    unsure_bus: "Not sure about the bus yet",
    unsure_stay: "Not sure where they're staying",
    glamping: "Interested in Rhino Lodge glamping",
    seats_exceed: "More bus seats than guests now coming",
    not_attending: "Asked for the bus but nobody is coming now",
};

/**
 * Why a household needs a follow-up, given its saved answer and how many of its guests are
 * currently attending (attendance can change after the travel answer, e.g. edited in the portal).
 */
export function followUpReasons(travel: RsvpTravel, attending: number): FollowUpReason[] {
    const reasons: FollowUpReason[] = [];
    const seats = Math.max(travel.outbound, travel.return);
    if (attending === 0 && seats > 0) reasons.push("not_attending");
    else if (seats > attending) reasons.push("seats_exceed");
    if (attending > 0 && travel.bus === "unsure") reasons.push("unsure_bus");
    if (attending > 0 && travel.stay === "unsure") reasons.push("unsure_stay");
    // The couple is coordinating glamping with Rhino Lodge, so every interested household needs a reply.
    if (attending > 0 && travel.stay === "glamping") reasons.push("glamping");
    return reasons;
}
