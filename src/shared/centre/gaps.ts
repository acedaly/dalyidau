// Why a source has nothing to show, in a sentence (docs/INTELLIGENCE_CENTRE_9_1.md#source-health).
// Shown wherever its data would be, so a missing feed never reads as "nothing is happening":
// "Road disruptions aren't available: the Transport for NSW API key hasn't been added."
import type { SourceHealth } from "./types";

/** What the dataset is about, for sentences ("Road disruptions aren't available…"). */
const SUBJECTS: Record<string, string> = {
    "rfs-incidents": "RFS incidents",
    "rfs-fire-danger": "Fire danger ratings and Total Fire Bans",
    "rfs-major-updates": "RFS major fire updates",
    "rfs-incident-alerts": "RFS incident alerts",
    "bom-warnings": "Bureau of Meteorology warnings",
    "bom-observations": "Weather observations",
    "bom-water": "River gauge readings",
    "ga-earthquakes": "Earthquakes",
    "dea-hotspots": "Satellite detections (Digital Earth Australia)",
    "nsw-air-quality": "Air quality readings",
    "endeavour-outages": "Electricity outages",
    "act-esa-incidents": "ACT incidents",
    "noaa-space-weather": "Space weather",
    "tfnsw-live-traffic": "Road disruptions",
    "nasa-firms": "Satellite detections (NASA FIRMS)",
};

export const sourceSubject = (h: Pick<SourceHealth, "source">) => SUBJECTS[h.source.id] ?? `${h.source.provider}: ${h.source.dataset}`;

/** Null when the source is active and up to date. */
export function sourceGapMessage(h: Pick<SourceHealth, "source" | "status" | "statusDetail" | "lastSuccessAt">): string | null {
    const subject = sourceSubject(h);
    switch (h.status) {
        case "active":
            return null;
        case "needs_registration":
            return h.source.secretName
                ? `${subject} aren't available: the ${h.source.provider} API key (${h.source.secretName}) hasn't been added. This isn't the same as there being none.`
                : `${subject} aren't available: ${h.source.provider} needs a registration that hasn't been made.`;
        case "disabled":
            return `${subject} aren't being collected: the source is switched off in Sources. This isn't the same as there being none.`;
        case "awaiting_verification":
            return `${subject} aren't available yet: the source is switched on but hasn't completed a validated retrieval.`;
        case "stale":
            return `${subject} may be out of date: ${h.statusDetail}`;
        case "error":
            return h.lastSuccessAt ? `${subject} may be out of date: the latest attempts failed. ${h.statusDetail}` : `${subject} aren't available: ${h.statusDetail}`;
        case "unavailable":
            return `${subject} aren't available: the provider no longer serves this.`;
        case "restricted":
            return `${subject} aren't collected: the provider's permission is needed.`;
        case "unsupported":
            return `${subject} aren't collected: there's no permitted machine-readable interface.`;
    }
}
