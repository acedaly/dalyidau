// Geographic extents a wallboard widget, report or replay can be limited to (docs/INTELLIGENCE_CENTRE_9_1.md).
//
// They are rectangles: an extent to look within, not an official boundary. Regions inside NSW
// follow the state's planning regions only approximately and say so. Collection covers NSW and the
// ACT (plus national earthquakes, satellite detections and space weather), so a wider extent never
// implies that other states' incidents are included.

export type BBox = [number, number, number, number]; // [west, south, east, north]

export interface RegionDefinition {
    id: string;
    label: string;
    bbox: BBox;
    /** What this extent can and can't show, for people to read. */
    note: string;
}

export const REGIONS = [
    {
        id: "nsw",
        label: "New South Wales",
        bbox: [140.9, -37.6, 153.7, -28.1],
        note: "The state's extent (it includes the ACT). Coverage is only what the active sources publish.",
    },
    {
        id: "act",
        label: "Australian Capital Territory",
        bbox: [148.75, -35.93, 149.4, -35.12],
        note: "ACT Emergency Services Agency incidents, plus NSW and national sources that reach into the territory.",
    },
    { id: "greater_sydney", label: "Greater Sydney (approximate)", bbox: [150.0, -34.4, 151.4, -33.3], note: "An approximate rectangle, not an official boundary." },
    { id: "hunter", label: "Hunter and Central Coast (approximate)", bbox: [150.0, -33.6, 152.6, -31.5], note: "An approximate rectangle, not an official boundary." },
    {
        id: "illawarra_south_coast",
        label: "Illawarra and South Coast (approximate)",
        bbox: [149.6, -37.6, 151.1, -34.1],
        note: "An approximate rectangle, not an official boundary.",
    },
    { id: "north_coast", label: "North Coast (approximate)", bbox: [152.2, -31.5, 153.7, -28.1], note: "An approximate rectangle, not an official boundary." },
    {
        id: "new_england_north_west",
        label: "New England and North West (approximate)",
        bbox: [148.7, -31.6, 152.3, -28.2],
        note: "An approximate rectangle, not an official boundary.",
    },
    {
        id: "central_west_orana",
        label: "Central West and Orana (approximate)",
        bbox: [146.5, -34.3, 150.4, -30.5],
        note: "An approximate rectangle, not an official boundary.",
    },
    { id: "riverina_murray", label: "Riverina and Murray (approximate)", bbox: [143.0, -36.2, 148.6, -33.5], note: "An approximate rectangle, not an official boundary." },
    { id: "far_west", label: "Far West (approximate)", bbox: [140.9, -34.5, 146.5, -28.9], note: "An approximate rectangle, not an official boundary." },
    {
        id: "snowy_tablelands",
        label: "Southern Tablelands and Snowy Mountains (approximate)",
        bbox: [148.0, -37.0, 150.3, -34.2],
        note: "An approximate rectangle, not an official boundary.",
    },
    {
        id: "australia",
        label: "Australia",
        bbox: [112.0, -44.0, 154.0, -10.0],
        note: "Only the national datasets (earthquakes, satellite detections, space weather) cover all of Australia. Incidents and warnings come from NSW and ACT sources only.",
    },
] as const satisfies readonly RegionDefinition[];

export type RegionId = (typeof REGIONS)[number]["id"];
export const REGION_IDS = REGIONS.map((r) => r.id) as [RegionId, ...RegionId[]];
export const regionById = (id: string): RegionDefinition | undefined => (REGIONS as readonly RegionDefinition[]).find((r) => r.id === id);
