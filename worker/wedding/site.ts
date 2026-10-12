// Data for the public wedding website. Only events marked public are included, and no guest data
// ever reaches these pages: RSVP details are fetched separately once a valid code is entered.
import type { D1Database } from "@cloudflare/workers-types";
import type { PublicEvent, WeddingPageData } from "../../src/shared/portal/types";
import { eventDef, listEntities } from "../portal/entities";
import { loadFlags } from "../portal/flags";
import { getSettings } from "../portal/settings";
import { listMedia } from "./media";

export async function loadWeddingPage(db: D1Database, route: WeddingPageData["route"], preview: boolean): Promise<WeddingPageData> {
    // The preview shows the draft; the public site shows what was last published.
    const [details, content, rsvp, events, flags, media] = await Promise.all([
        getSettings(db, "wedding"),
        getSettings(db, preview ? "website_draft" : "website"),
        getSettings(db, "rsvp"),
        listEntities(db, eventDef),
        loadFlags(db),
        listMedia(db),
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

    const sections = content.sections.filter((s) => s.visible);
    const byId = new Map(media.map((m) => [m.id, m]));
    // Only photos the published content actually uses are sent to the page.
    const sectionImages = Object.fromEntries(sections.flatMap((s) => (s.imageId && byId.has(s.imageId) ? [[s.imageId, byId.get(s.imageId)!] as const] : [])));
    const mode: WeddingPageData["rsvp"]["mode"] = flags["rsvp.native"] ? "native" : rsvp.externalUrl ? "external" : "closed";
    return {
        route,
        details,
        content: { ...content, sections },
        heroImage: (content.heroImageId && byId.get(content.heroImageId)) || null,
        sectionImages,
        gallery: content.showGallery ? media.filter((m) => m.inGallery) : [],
        events: publicEvents,
        rsvp: { mode, externalUrl: mode === "external" ? rsvp.externalUrl : null, deadline: rsvp.deadline || null },
        preview,
    };
}

export const weddingTitle = (data: WeddingPageData) => {
    const couple = `${data.details.partnerOne} & ${data.details.partnerTwo}`;
    return data.route === "rsvp" ? `RSVP · ${couple}` : data.content.heroTitle || couple;
};
