// Built-in maintenance templates: a title, a category and a checklist to start from. None of them
// carries an interval. Service intervals differ by make, model, use and agreement, so the person
// enters the one from their owner's manual, service book, manufacturer or lease, and the template
// says where to look. Household templates (asset_maintenance_templates) keep the intervals the
// household chose for itself.
import type { MaintenanceCategory } from "./types";

export type TemplateAppliesTo = "any" | "vehicle" | "trailer" | "property" | "appliance" | "equipment";

export interface MaintenanceTemplate {
    id: string;
    title: string;
    category: MaintenanceCategory;
    appliesTo: TemplateAppliesTo;
    /** Which interval makes sense: by date, by distance, or whichever comes first. */
    basis: "date" | "distance" | "either";
    /** Where the person should find the interval. Shown next to the interval fields. */
    intervalSource: string;
    checklist: string[];
    builtin: true;
}

export const BUILTIN_TEMPLATES = [
    {
        id: "vehicle-service",
        title: "Vehicle service",
        category: "service",
        appliesTo: "vehicle",
        basis: "either",
        intervalSource: "Use the interval in the vehicle's service book or owner's manual (often both a distance and a time, whichever comes first).",
        checklist: ["Book with the service provider", "Record the odometer reading", "Keep the invoice"],
        builtin: true,
    },
    {
        id: "trailer-bearings",
        title: "Trailer wheel bearing inspection",
        category: "inspection",
        appliesTo: "trailer",
        basis: "either",
        intervalSource: "Use the interval from the trailer or axle manufacturer's manual.",
        checklist: ["Check for play and noise", "Repack or replace as needed", "Check seals"],
        builtin: true,
    },
    {
        id: "tyre-check",
        title: "Tyre check",
        category: "safety",
        appliesTo: "any",
        basis: "date",
        intervalSource: "Choose how often you check, guided by the vehicle or tyre manufacturer.",
        checklist: ["Pressures, including the spare", "Tread depth", "Damage or uneven wear"],
        builtin: true,
    },
    {
        id: "registration-renewal",
        title: "Registration renewal",
        category: "registration",
        appliesTo: "vehicle",
        basis: "date",
        intervalSource: "Your registration term (on the renewal notice or certificate).",
        checklist: ["Inspection or safety check if your state requires one", "Pay the renewal"],
        builtin: true,
    },
    {
        id: "smoke-alarm",
        title: "Smoke alarm check",
        category: "safety",
        appliesTo: "property",
        basis: "date",
        intervalSource:
            "Follow the alarm manufacturer's instructions and your state fire service's guidance. In a rental, check who is responsible under your lease.",
        checklist: ["Press the test button", "Check the expiry date on the alarm", "Replace the battery if it's replaceable"],
        builtin: true,
    },
    {
        id: "aircon-filter",
        title: "Air-conditioner filter clean",
        category: "cleaning",
        appliesTo: "appliance",
        basis: "date",
        intervalSource: "Use the interval in the unit's manual.",
        checklist: ["Turn the unit off at the isolator", "Remove and clean the filters", "Refit and test"],
        builtin: true,
    },
    {
        id: "camera-batteries",
        title: "Camera battery check",
        category: "inspection",
        appliesTo: "equipment",
        basis: "date",
        intervalSource: "Choose how often suits how you use the cameras.",
        checklist: ["Charge level", "Battery health", "Spare batteries"],
        builtin: true,
    },
    {
        id: "equipment-inspection",
        title: "Equipment inspection",
        category: "inspection",
        appliesTo: "equipment",
        basis: "date",
        intervalSource: "Use the manufacturer's recommendation, or choose your own.",
        checklist: ["Visual check for damage", "Function test", "Clean and store"],
        builtin: true,
    },
    {
        id: "battery-replacement",
        title: "Battery replacement",
        category: "replacement",
        appliesTo: "any",
        basis: "date",
        intervalSource: "Use the battery manufacturer's expected life, or replace when tested weak.",
        checklist: ["Test the battery", "Replace and record the date", "Recycle the old battery"],
        builtin: true,
    },
    {
        id: "rental-inspection",
        title: "Rental inspection",
        category: "inspection",
        appliesTo: "property",
        basis: "date",
        intervalSource: "The date your property manager gives you.",
        checklist: ["Note anything to report", "Take condition photos"],
        builtin: true,
    },
] as const satisfies readonly MaintenanceTemplate[];

export const builtinTemplate = (id: string): MaintenanceTemplate | undefined => BUILTIN_TEMPLATES.find((t) => t.id === id);
