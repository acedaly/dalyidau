// The couple's agreed wording for accommodation and the courtesy bus (October 2026), used as the
// website defaults and offered in the Website editor as "Use suggested wording". Applying it only
// changes the draft: nothing reaches the public site until the couple saves and publishes.
//
// Facts come from the couple and the Dubbo RSL's advice. Nothing here states a price, a timetable,
// a capacity or a confirmed pick-up, and nothing says accommodation or seats are reserved.
import type { WebsiteItem, WebsiteSection } from "./types";

const item = (title: string, body: string, url = "", detail = "", onSite?: boolean): WebsiteItem => ({
    title,
    body,
    url,
    detail,
    imageId: null,
    ...(onSite === undefined ? {} : { onSite }),
});

export const ACCOMMODATION_BODY =
    "For those travelling to celebrate with us, you can stay right at the venue or in town, or make your own arrangements.\n\n" +
    "There are also plenty of other accommodation options in Dubbo if you'd prefer to stay in town.";

export const RHINO_LODGE_STAY = item(
    "Stay at Rhino Lodge",
    "For those wanting to stay close to the celebrations, Rhino Lodge offers on-site glamping accommodation.\n\n" +
        "Accommodation is limited and available on a **first-in, first-served basis**, so we recommend organising your stay early if you'd like to stay at the venue.\n\n" +
        "We're currently coordinating accommodation arrangements with Rhino Lodge. If you're interested in staying on-site, please get in touch with us and we'll point you in the right direction.",
    "https://www.rhinolodge.com.au/accommodation/",
    "On-site glamping · 99 m from the ceremony",
    true,
);

export const COURTESY_BUS_ITEMS: WebsiteItem[] = [
    item(
        "Getting to the wedding",
        "We're planning to arrange the Dubbo RSL courtesy bus to help guests travel to Rhino Lodge.\n\n" +
            "The bus will depart from Dubbo RSL at a prearranged time, with potential pick-ups from accommodation along the route where practical.\n\n" +
            "If you'd like to use the courtesy bus, please let us know when you RSVP so we can estimate passenger numbers and coordinate transport arrangements.",
    ),
    item(
        "Getting home",
        "The courtesy bus can also be arranged to help guests return to town after the celebrations.\n\n" +
            "Return trips may be organised at scheduled times or requested through the bar staff on the night, subject to the bus driver's availability and other RSL commitments.\n\n" +
            "We'll share confirmed pick-up points and times closer to the wedding.",
    ),
];

export const ONSITE_FAQ = item(
    "Is there accommodation onsite?",
    "Yes. Rhino Lodge has limited on-site glamping, available on a first-in, first-served basis. We're coordinating accommodation arrangements with Rhino Lodge, so if you'd like to stay on-site, please get in touch with us and we'll point you in the right direction.",
);

/** Section kinds the editor can offer suggested wording for. */
export const SUGGESTION_KINDS = ["accommodation", "transport", "faq"] as const;
export const hasSuggestion = (kind: WebsiteSection["kind"]) => (SUGGESTION_KINDS as readonly string[]).includes(kind);

/** Which accommodation item is the on-site stay. Older content has no flag, where it was the first place. */
export const isOnSite = (stay: WebsiteItem, index: number, items: WebsiteItem[]) =>
    stay.onSite ?? (index === 0 && !items.some((other) => other.onSite !== undefined));

/**
 * The section with the suggested wording merged in. Existing places to stay, links, photos and other
 * questions are kept: only the on-site stay's wording, the bus wording and the on-site FAQ answer change.
 */
export function withSuggestedWording(section: WebsiteSection): WebsiteSection {
    if (section.kind === "accommodation") {
        const items = section.items.map((stay, i) => ({ ...stay, onSite: isOnSite(stay, i, section.items) }));
        const onSite = items.findIndex((stay) => stay.onSite || /rhino/i.test(stay.title));
        const merged =
            onSite === -1
                ? [RHINO_LODGE_STAY, ...items]
                : items.map((stay, i) =>
                      i === onSite
                          ? {
                                ...stay,
                                title: RHINO_LODGE_STAY.title,
                                body: RHINO_LODGE_STAY.body,
                                detail: RHINO_LODGE_STAY.detail,
                                url: stay.url || RHINO_LODGE_STAY.url,
                                onSite: true,
                            }
                          : stay,
                  );
        return { ...section, body: ACCOMMODATION_BODY, items: merged };
    }
    if (section.kind === "transport") {
        return { ...section, title: "Courtesy bus", body: "", items: COURTESY_BUS_ITEMS.map((bus) => ({ ...bus })) };
    }
    if (section.kind === "faq") {
        const index = section.items.findIndex((faq) => /accommodation.*on\s?-?site/i.test(faq.title));
        const items =
            index === -1 ? [...section.items, { ...ONSITE_FAQ }] : section.items.map((faq, i) => (i === index ? { ...faq, body: ONSITE_FAQ.body } : faq));
        return { ...section, items };
    }
    return section;
}
