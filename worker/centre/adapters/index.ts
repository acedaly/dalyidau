// Adapter for each implemented source in src/shared/centre/sources.ts. Adding a public dataset:
// write an adapter, add its registry entry (with the evidence), and list it here.
import { bomObservations, bomWarnings, bomWater } from "./bom";
import { deaHotspots, gaEarthquakes } from "./geoscience";
import { nasaFirms, tfnswLiveTraffic } from "./keyed";
import { actIncidents, endeavourOutages, noaaSpaceWeather, nswAirQuality } from "./regional";
import { rfsFireDanger, rfsIncidentAlerts, rfsIncidents, rfsMajorUpdates } from "./rfs";
import type { Adapter } from "./types";

export const ADAPTERS: Record<string, Adapter> = Object.fromEntries(
    [
        rfsIncidents,
        rfsFireDanger,
        rfsMajorUpdates,
        rfsIncidentAlerts,
        bomWarnings,
        bomObservations,
        bomWater,
        gaEarthquakes,
        deaHotspots,
        nswAirQuality,
        endeavourOutages,
        actIncidents,
        noaaSpaceWeather,
        tfnswLiveTraffic,
        nasaFirms,
    ].map((a) => [a.id, a]),
);
