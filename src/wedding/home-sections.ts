// How the homepage groups the portal's sections. The page and the navigation both use this, so
// every nav link points at a section that is actually rendered.
//
// "The day" merges the schedule (details), the venue and the dress code; "Stay & travel" merges
// accommodation, getting there and transport. Their ids are fixed, and the ids the sections had on
// their own (#details, #venue, #stay, #bus…) plus the older fixed ones (#schedule, #venue, #stay,
// #transport) stay on the page as empty anchors, because sent invitations and emails may link to them.
import type { SectionKind, WebsiteSection, WeddingPageData } from "@/shared/portal/types";

export const DAY_ID = "the-day";
export const STAY_ID = "stay-and-travel";

const DAY_KINDS: SectionKind[] = ["details", "venue", "dress"];
const STAY_KINDS: SectionKind[] = ["accommodation", "travel", "transport"];

/** Anchors earlier versions of the page had, whatever the sections are called now. */
export const LEGACY_DAY_ANCHORS = ["schedule", "venue"];
export const LEGACY_STAY_ANCHORS = ["stay", "transport"];

/** Sections with something to show (a venue shows even when empty: its name is the content). */
export const shownSections = (data: WeddingPageData) => data.content.sections.filter((s) => s.body.trim() || s.items.length || s.kind === "venue");

export interface HomeLayout {
    sections: WebsiteSection[];
    day: { details: WebsiteSection | null; venue: WebsiteSection | null; dress: WebsiteSection | null; anchors: string[] } | null;
    stay: { accommodation: WebsiteSection | null; travel: WebsiteSection | null; transport: WebsiteSection | null; anchors: string[] } | null;
    faq: WebsiteSection | null;
}

const first = (sections: WebsiteSection[], kind: SectionKind) => sections.find((s) => s.kind === kind) ?? null;

export const homeLayout = (data: WeddingPageData): HomeLayout => {
    const sections = shownSections(data);
    const details = first(sections, "details");
    const venue = first(sections, "venue");
    // The dress code joins the day only when there is a day to join; otherwise it stays a section of its own.
    const hasDay = !!(details || venue || data.events.length > 0);
    const dress = hasDay ? first(sections, "dress") : null;
    const accommodation = first(sections, "accommodation");
    const travel = first(sections, "travel");
    const transport = first(sections, "transport");
    const hasStay = !!(accommodation || travel || transport);
    const faq = first(sections, "faq");
    const ids = (list: (WebsiteSection | null)[], legacy: string[], own: string) =>
        [...new Set([...list.filter((s): s is WebsiteSection => !!s).map((s) => s.id), ...legacy])].filter((id) => id !== own);
    return {
        sections,
        day: hasDay ? { details, venue, dress, anchors: ids([details, venue, dress], LEGACY_DAY_ANCHORS, DAY_ID) } : null,
        stay: hasStay ? { accommodation, travel, transport, anchors: ids([accommodation, travel, transport], LEGACY_STAY_ANCHORS, STAY_ID) } : null,
        faq,
    };
};

/** Whether a section is drawn as part of "The day" or "Stay & travel" rather than on its own. */
export const isMerged = (layout: HomeLayout, section: WebsiteSection) =>
    (!!layout.day && DAY_KINDS.includes(section.kind) && Object.values(layout.day).includes(section)) ||
    (!!layout.stay && STAY_KINDS.includes(section.kind) && Object.values(layout.stay).includes(section));

export const navItems = (data: WeddingPageData) => {
    const layout = homeLayout(data);
    const items: { id: string; label: string }[] = [];
    if (layout.day) items.push({ id: DAY_ID, label: "The day" });
    if (layout.stay) items.push({ id: STAY_ID, label: "Stay & travel" });
    if (layout.faq) items.push({ id: layout.faq.id, label: "FAQ" });
    return items;
};
