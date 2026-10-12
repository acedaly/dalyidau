// Data for the public wedding website. Only events marked public are included, and no guest data
// ever reaches these pages: RSVP details are fetched separately once a valid code is entered.
import type { D1Database } from "@cloudflare/workers-types";
import type { PublicEvent, WeddingPageData } from "../../src/shared/portal/types";
import { eventDef, listEntities } from "../portal/entities";
import { loadFlags } from "../portal/flags";
import { getSettings } from "../portal/settings";

export async function loadWeddingPage(db: D1Database, route: WeddingPageData["route"], preview: boolean): Promise<WeddingPageData> {
    const [details, content, rsvp, events, flags] = await Promise.all([
        getSettings(db, "wedding"),
        getSettings(db, "website"),
        getSettings(db, "rsvp"),
        listEntities(db, eventDef),
        loadFlags(db),
    ]);
    const publicEvents: PublicEvent[] = events
        .filter((e) => e.isPublic)
        .map(({ id, name, startsAt, endsAt, venueName, address, description, dressCode }) => ({
            id,
            name,
            startsAt,
            endsAt,
            venueName,
            address,
            description,
            dressCode,
        }));

    const mode: WeddingPageData["rsvp"]["mode"] = flags["rsvp.native"] ? "native" : rsvp.externalUrl ? "external" : "closed";
    return {
        route,
        details,
        content,
        events: publicEvents,
        rsvp: { mode, externalUrl: mode === "external" ? rsvp.externalUrl : null, deadline: rsvp.deadline || null },
        preview,
    };
}

export const weddingTitle = (data: WeddingPageData) => {
    const couple = `${data.details.partnerOne} & ${data.details.partnerTwo}`;
    return data.route === "rsvp" ? `RSVP · ${couple}` : data.content.heroTitle || couple;
};
