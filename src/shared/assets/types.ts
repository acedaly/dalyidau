// Home & Assets: shared vocabulary, input schemas and the shapes the API and pages exchange.
// See docs/HOME_ASSETS.md. Money is whole cents; null always means "not recorded", never zero.
import { z } from "zod";
import type { AssetCategory, CategoryGroup, CustomFieldDef } from "./categories";
import { CATEGORY_ID, FIELD_TYPES } from "./categories";

// --- Vocabulary ----------------------------------------------------------------------------------

export const ASSET_STATUSES = ["active", "in_storage", "in_repair", "lent", "lost", "stolen", "sold", "disposed", "gifted"] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];
export const ASSET_STATUS_LABELS: Record<AssetStatus, string> = {
    active: "In use",
    in_storage: "In storage",
    in_repair: "Being repaired",
    lent: "Lent out",
    lost: "Lost",
    stolen: "Stolen",
    sold: "Sold",
    disposed: "Disposed of",
    gifted: "Given away",
};
/** No longer held: excluded from current totals and reminders. */
export const GONE_STATUSES: readonly AssetStatus[] = ["sold", "disposed", "gifted"];

export const CONDITIONS = ["new", "excellent", "good", "fair", "poor", "not_working", "unknown"] as const;
export type AssetCondition = (typeof CONDITIONS)[number];
export const CONDITION_LABELS: Record<AssetCondition, string> = {
    new: "New",
    excellent: "Excellent",
    good: "Good",
    fair: "Fair",
    poor: "Poor",
    not_working: "Not working",
    unknown: "Not recorded",
};

export const VISIBILITIES = ["private", "selected", "household"] as const;
export type AssetVisibility = (typeof VISIBILITIES)[number];
export const VISIBILITY_LABELS: Record<AssetVisibility, string> = {
    private: "Private to the owner",
    selected: "Shared with selected people",
    household: "Shared with the household",
};

export const LOCATION_KINDS = ["residence", "rental", "garage", "shed", "storage", "room", "vehicle", "trailer", "other"] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];
export const LOCATION_KIND_LABELS: Record<LocationKind, string> = {
    residence: "Home",
    rental: "Rental property",
    garage: "Garage",
    shed: "Shed",
    storage: "Storage facility",
    room: "Room or area",
    vehicle: "Vehicle",
    trailer: "Camper or trailer",
    other: "Other place",
};

export const TENURES = ["owned", "renting", "leased_out", "other"] as const;
export type Tenure = (typeof TENURES)[number];
export const TENURE_LABELS: Record<Tenure, string> = { owned: "Owned", renting: "Renting", leased_out: "Leased to tenants", other: "Other" };

export const RESPONSIBILITIES = ["owner", "tenant", "landlord", "shared", "uncertain"] as const;
export type Responsibility = (typeof RESPONSIBILITIES)[number];
export const RESPONSIBILITY_LABELS: Record<Responsibility, string> = {
    owner: "Us (owner)",
    tenant: "Us (tenant)",
    landlord: "Landlord or property manager",
    shared: "Shared",
    uncertain: "Not sure yet",
};

export const MAINTENANCE_CATEGORIES = ["service", "inspection", "safety", "cleaning", "replacement", "seasonal", "registration", "repair", "other"] as const;
export type MaintenanceCategory = (typeof MAINTENANCE_CATEGORIES)[number];
export const MAINTENANCE_CATEGORY_LABELS: Record<MaintenanceCategory, string> = {
    service: "Servicing",
    inspection: "Inspection",
    safety: "Safety check",
    cleaning: "Cleaning",
    replacement: "Replacement",
    seasonal: "Seasonal",
    registration: "Registration",
    repair: "Repair",
    other: "Other",
};

export const MAINTENANCE_KINDS = ["preventive", "corrective", "repair", "inspection", "service", "replacement", "seasonal", "safety"] as const;
export type MaintenanceKind = (typeof MAINTENANCE_KINDS)[number];
export const MAINTENANCE_KIND_LABELS: Record<MaintenanceKind, string> = {
    preventive: "Preventive",
    corrective: "Corrective",
    repair: "One-off repair",
    inspection: "Inspection",
    service: "Service",
    replacement: "Replacement",
    seasonal: "Seasonal",
    safety: "Safety",
};

export const MAINTENANCE_STATUSES = ["open", "requested", "scheduled", "in_progress", "completed", "cancelled"] as const;
export type MaintenanceStatus = (typeof MAINTENANCE_STATUSES)[number];
export const OPEN_MAINTENANCE: readonly MaintenanceStatus[] = ["open", "requested", "scheduled", "in_progress"];
export const MAINTENANCE_STATUS_LABELS: Record<MaintenanceStatus, string> = {
    open: "To do",
    requested: "Requested",
    scheduled: "Booked",
    in_progress: "In progress",
    completed: "Completed",
    cancelled: "Cancelled",
};

export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type MaintenancePriority = (typeof PRIORITIES)[number];
export const PRIORITY_LABELS: Record<MaintenancePriority, string> = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };

export const APPROVALS = ["not_needed", "pending", "approved", "declined"] as const;
export type Approval = (typeof APPROVALS)[number];
export const APPROVAL_LABELS: Record<Approval, string> = {
    not_needed: "No approval needed",
    pending: "Waiting for approval",
    approved: "Approved",
    declined: "Declined",
};

export const INTERVAL_UNITS = ["days", "weeks", "months", "years"] as const;
export type IntervalUnit = (typeof INTERVAL_UNITS)[number];

export const VEHICLE_KINDS = ["vehicle", "trailer", "caravan", "motorcycle", "boat", "other"] as const;
export type VehicleKind = (typeof VEHICLE_KINDS)[number];
export const VEHICLE_KIND_LABELS: Record<VehicleKind, string> = {
    vehicle: "Vehicle",
    trailer: "Trailer",
    caravan: "Caravan or camper",
    motorcycle: "Motorcycle",
    boat: "Boat",
    other: "Other",
};
export const TOWED: readonly VehicleKind[] = ["trailer", "caravan"];

export const ODOMETER_UNITS = ["km", "mi", "hours"] as const;
export type OdometerUnit = (typeof ODOMETER_UNITS)[number];

export const POLICY_TYPES = ["motor", "caravan_trailer", "home", "contents", "home_contents", "landlord", "personal_property", "travel", "other"] as const;
export type PolicyType = (typeof POLICY_TYPES)[number];
export const POLICY_TYPE_LABELS: Record<PolicyType, string> = {
    motor: "Motor vehicle",
    caravan_trailer: "Caravan and trailer",
    home: "Home (building)",
    contents: "Contents",
    home_contents: "Home and contents",
    landlord: "Landlord",
    personal_property: "Personal property (portable items)",
    travel: "Travel",
    other: "Other",
};

export const POLICY_STATUSES = ["active", "lapsed", "cancelled", "replaced"] as const;
export type PolicyStatus = (typeof POLICY_STATUSES)[number];
export const POLICY_STATUS_LABELS: Record<PolicyStatus, string> = { active: "Active", lapsed: "Lapsed", cancelled: "Cancelled", replaced: "Replaced" };

export const FREQUENCIES = ["annual", "half_yearly", "quarterly", "monthly", "fortnightly", "other"] as const;
export type PaymentFrequency = (typeof FREQUENCIES)[number];
export const FREQUENCY_LABELS: Record<PaymentFrequency, string> = {
    annual: "Yearly",
    half_yearly: "Half-yearly",
    quarterly: "Quarterly",
    monthly: "Monthly",
    fortnightly: "Fortnightly",
    other: "Other",
};
/** Payments a year, for comparing premiums paid on different schedules. Null for "other". */
export const PAYMENTS_PER_YEAR: Record<PaymentFrequency, number | null> = {
    annual: 1,
    half_yearly: 2,
    quarterly: 4,
    monthly: 12,
    fortnightly: 26,
    other: null,
};

export const WARRANTY_KINDS = ["manufacturer", "extended", "retailer", "other"] as const;
export type WarrantyKind = (typeof WARRANTY_KINDS)[number];
export const WARRANTY_KIND_LABELS: Record<WarrantyKind, string> = {
    manufacturer: "Manufacturer's warranty",
    extended: "Extended warranty",
    retailer: "Retailer's warranty",
    other: "Other warranty",
};

export const CLAIM_KINDS = ["warranty", "insurance", "consumer_guarantee"] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];
export const CLAIM_KIND_LABELS: Record<ClaimKind, string> = {
    warranty: "Warranty claim",
    insurance: "Insurance claim",
    consumer_guarantee: "Consumer guarantee (ACL) request",
};
export const CLAIM_STATUSES = ["preparing", "open", "approved", "declined", "settled", "withdrawn"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
    preparing: "Preparing",
    open: "Lodged",
    approved: "Approved",
    declined: "Declined",
    settled: "Settled",
    withdrawn: "Withdrawn",
};

export const VALUATION_KINDS = ["current", "replacement", "sale", "disposal", "agreed"] as const;
export type ValuationKind = (typeof VALUATION_KINDS)[number];
export const VALUATION_KIND_LABELS: Record<ValuationKind, string> = {
    current: "Current value",
    replacement: "Replacement value",
    sale: "Sale price",
    disposal: "Disposal value",
    agreed: "Insurer's agreed value",
};
export const VALUATION_BASES = ["user_estimate", "transaction", "verified_sale", "appraisal", "insurer"] as const;
export type ValuationBasis = (typeof VALUATION_BASES)[number];
/** Formula estimates (depreciation) are worked out when read; they're never stored. */
export type ValueBasis = ValuationBasis | "formula";
export const VALUE_BASIS_LABELS: Record<ValueBasis, string> = {
    user_estimate: "Your estimate",
    transaction: "Actual transaction",
    verified_sale: "Verified sale",
    appraisal: "Professional appraisal",
    insurer: "Insurer's figure",
    formula: "Formula estimate",
};

export const FILE_KINDS = [
    "photo",
    "receipt",
    "invoice",
    "registration",
    "policy",
    "warranty",
    "manual",
    "service_record",
    "inspection",
    "quote",
    "other",
] as const;
export type AssetFileKind = (typeof FILE_KINDS)[number];
export const FILE_KIND_LABELS: Record<AssetFileKind, string> = {
    photo: "Photo",
    receipt: "Receipt",
    invoice: "Invoice",
    registration: "Registration document",
    policy: "Insurance policy",
    warranty: "Warranty certificate",
    manual: "Manual",
    service_record: "Service record",
    inspection: "Inspection report",
    quote: "Repair quote",
    other: "Other document",
};
/** Proof of purchase: an asset with none of these "needs documentation". */
export const PROOF_KINDS: readonly AssetFileKind[] = ["receipt", "invoice"];

export const PHOTO_TAGS = ["general", "purchase", "condition", "damage", "repair", "inspection"] as const;
export type PhotoTag = (typeof PHOTO_TAGS)[number];
export const PHOTO_TAG_LABELS: Record<PhotoTag, string> = {
    general: "Photo",
    purchase: "At purchase",
    condition: "Condition",
    damage: "Damage",
    repair: "Repair",
    inspection: "Inspection",
};

export const DISPOSAL_METHODS = ["sold", "gifted", "recycled", "discarded", "traded_in", "written_off", "other"] as const;
export type DisposalMethod = (typeof DISPOSAL_METHODS)[number];
export const DISPOSAL_METHOD_LABELS: Record<DisposalMethod, string> = {
    sold: "Sold",
    gifted: "Given away",
    recycled: "Recycled",
    discarded: "Thrown out",
    traded_in: "Traded in",
    written_off: "Written off",
    other: "Other",
};

/** The kinds of date a reminder can be about. Each has its own settings. */
export const REMINDER_KINDS = ["maintenance", "registration", "insurance", "warranty", "inspection", "lease", "roadside"] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];
export const REMINDER_KIND_LABELS: Record<ReminderKind, string> = {
    maintenance: "Maintenance and servicing",
    registration: "Vehicle registration",
    insurance: "Insurance renewals",
    warranty: "Warranty expiry",
    inspection: "Inspections (vehicle and rental)",
    lease: "Lease end",
    roadside: "Roadside assistance renewal",
};

export const TASK_REF_KINDS = ["maintenance", "schedule", "registration", "policy_renewal", "warranty_expiry", "inspection", "lease_end", "roadside"] as const;
export type TaskRefKind = (typeof TASK_REF_KINDS)[number];

// --- Limits --------------------------------------------------------------------------------------

export const LIMITS = {
    /** Documents and receipts. Photos are resized in the browser before upload and are much smaller. */
    maxFileBytes: 10 * 1024 * 1024,
    maxPhotoBytes: 8 * 1024 * 1024,
    maxThumbBytes: 300 * 1024,
    filesPerAsset: 200,
    listPage: 100,
    listMax: 2000,
    bulkMax: 100,
    sharesPerAsset: 20,
    knowledgeLinksPerAsset: 50,
    exportMax: 5000,
} as const;

// --- Input pieces --------------------------------------------------------------------------------

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-20");
const optionalText = (max: number) =>
    z
        .string()
        .trim()
        .max(max)
        .transform((v) => (v === "" ? null : v))
        .nullable()
        .optional();
const cents = z.number().int().min(0).max(100_000_000_000);
const prefixedId = (prefix: string, what: string) => z.string().regex(new RegExp(`^${prefix}_[a-z0-9]{14}$`), `Not a valid ${what}`);
export const assetId = prefixedId("ast", "asset");
export const locationId = prefixedId("alo", "location");
export const policyId = prefixedId("aip", "policy");
export const maintenanceId = prefixedId("amr", "maintenance record");
export const scheduleId = prefixedId("ams", "maintenance schedule");
export const fileId = prefixedId("afl", "file");
export const warrantyId = prefixedId("awr", "warranty");
export const claimId = prefixedId("acl", "claim");
export const clientId = z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/)
    .optional();

export const depreciationSchema = z.discriminatedUnion("method", [
    z.object({ method: z.literal("none") }).strict(),
    z.object({ method: z.literal("straight_line"), years: z.number().min(1).max(50), residualPercent: z.number().min(0).max(100).default(0) }).strict(),
    z.object({ method: z.literal("diminishing"), ratePercent: z.number().min(1).max(90) }).strict(),
]);
export type Depreciation = z.output<typeof depreciationSchema>;

const customValue = z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]);

export const vehicleSpecsSchema = z
    .object({
        tyres: z.string().trim().max(500),
        tyrePressures: z.string().trim().max(300),
        battery: z.string().trim().max(500),
        modifications: z.string().trim().max(2000),
        accessories: z.string().trim().max(2000),
        towing: z.string().trim().max(1000),
        brakeSystem: z.string().trim().max(300),
        brakeController: z.string().trim().max(300),
        bearings: z.string().trim().max(500),
        coupling: z.string().trim().max(300),
        electrical: z.string().trim().max(500),
        water: z.string().trim().max(500),
        batterySystem: z.string().trim().max(500),
        suspension: z.string().trim().max(500),
        notes: z.string().trim().max(2000),
    })
    .partial();
export type VehicleSpecs = z.output<typeof vehicleSpecsSchema>;
export const VEHICLE_SPEC_LABELS: Record<keyof VehicleSpecs, string> = {
    tyres: "Tyres",
    tyrePressures: "Tyre pressures",
    battery: "Starting battery",
    modifications: "Modifications",
    accessories: "Accessories",
    towing: "Towing equipment",
    brakeSystem: "Brake system",
    brakeController: "Brake controller",
    bearings: "Bearings",
    coupling: "Coupling",
    electrical: "Electrical connections",
    water: "Water system",
    batterySystem: "House battery system",
    suspension: "Suspension",
    notes: "Other notes",
};
/** Specs that only make sense for towed vehicles. */
export const TRAILER_SPECS: readonly (keyof VehicleSpecs)[] = ["brakeSystem", "bearings", "coupling", "electrical", "water", "batterySystem", "suspension"];

export const vehicleInput = z
    .object({
        /** Optional on a change; on a new asset it defaults from a vehicle category. */
        kind: z.enum(VEHICLE_KINDS).optional(),
        registration: optionalText(20),
        jurisdiction: optionalText(40),
        registrationExpiry: isoDate.nullable().optional(),
        vin: optionalText(40),
        engineNumber: optionalText(40),
        make: optionalText(80),
        model: optionalText(80),
        year: z.number().int().min(1900).max(2100).nullable().optional(),
        odometerUnit: z.enum(ODOMETER_UNITS).optional(),
        roadsideProvider: optionalText(120),
        roadsideReference: optionalText(80),
        roadsideExpiry: isoDate.nullable().optional(),
        inspectionDue: isoDate.nullable().optional(),
        batteryInstalledOn: isoDate.nullable().optional(),
        atmKg: z.number().int().min(0).max(100000).nullable().optional(),
        gtmKg: z.number().int().min(0).max(100000).nullable().optional(),
        tareKg: z.number().int().min(0).max(100000).nullable().optional(),
        ballWeightKg: z.number().int().min(0).max(10000).nullable().optional(),
        specs: vehicleSpecsSchema.optional(),
    })
    .strict();
export type VehicleInput = z.input<typeof vehicleInput>;

const assetFields = {
    name: z.string().trim().min(1, "Give it a name").max(200),
    category: z.string().regex(CATEGORY_ID, "Choose a category"),
    manufacturer: optionalText(120),
    brand: optionalText(120),
    model: optionalText(120),
    serialNumber: optionalText(120),
    barcode: optionalText(64),
    description: optionalText(4000),
    purchaseDate: isoDate.nullable().optional(),
    purchasePriceCents: cents.nullable().optional(),
    purchaseLocation: optionalText(200),
    condition: z.enum(CONDITIONS).optional(),
    status: z.enum(ASSET_STATUSES).optional(),
    ownership: optionalText(120),
    locationId: locationId.nullable().optional(),
    notes: optionalText(8000),
    tags: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(20).optional(),
    custom: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), customValue).optional(),
    depreciation: depreciationSchema.optional(),
    disposedOn: isoDate.nullable().optional(),
    disposalMethod: z.enum(DISPOSAL_METHODS).nullable().optional(),
    disposalAmountCents: cents.nullable().optional(),
    disposalNotes: optionalText(2000),
    vehicle: vehicleInput.nullable().optional(),
};

/** Only a name and a category are needed; everything else can come later. */
export const createAssetInput = z
    .object({
        ...assetFields,
        /** Quick sharing on create; the full choice is in Sharing. */
        share: z.enum(["private", "household"]).optional(),
        /** Files already uploaded to the person's capture inbox (a receipt, photos) to attach. */
        fileIds: z.array(fileId).max(20).optional(),
        /** A first value, entered with the asset. */
        currentValueCents: cents.nullable().optional(),
        replacementValueCents: cents.nullable().optional(),
        clientId,
    })
    .strict();
export type CreateAssetInput = z.input<typeof createAssetInput>;

export const updateAssetInput = z
    .object({ ...assetFields, version: z.number().int().min(1) })
    .partial({ name: true, category: true })
    .strict();
export type UpdateAssetInput = z.input<typeof updateAssetInput>;

/** Fields only people who can see financial values may set or read. */
export const FINANCIAL_FIELDS = ["purchasePriceCents", "disposalAmountCents", "depreciation", "currentValueCents", "replacementValueCents"] as const;

export const bulkInput = z
    .object({
        ids: z.array(assetId).min(1).max(LIMITS.bulkMax),
        set: z
            .object({
                category: z.string().regex(CATEGORY_ID).optional(),
                status: z.enum(ASSET_STATUSES).optional(),
                condition: z.enum(CONDITIONS).optional(),
                locationId: locationId.nullable().optional(),
                ownership: optionalText(120),
                addTags: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(10).optional(),
                removeTags: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(10).optional(),
            })
            .strict(),
    })
    .strict();

export const RIGHTS = ["edit", "maintain", "financial", "insurance", "documents"] as const;
export type ShareRight = (typeof RIGHTS)[number];
export const RIGHT_LABELS: Record<ShareRight, { label: string; description: string }> = {
    edit: { label: "Edit details", description: "Change the asset, its vehicle details, warranties and photos." },
    maintain: { label: "Record maintenance", description: "Add and complete maintenance, report problems and update the odometer." },
    financial: { label: "See values and costs", description: "Purchase price, estimated and replacement values, maintenance costs." },
    insurance: { label: "See insurance", description: "Which policies are linked and their details (each policy is also shared on its own)." },
    documents: { label: "Open documents", description: "Receipts, invoices, manuals and other files (photos are visible to everyone it's shared with)." },
};
const grant = z.object({ edit: z.boolean(), maintain: z.boolean(), financial: z.boolean(), insurance: z.boolean(), documents: z.boolean() }).strict();
export type Grant = z.output<typeof grant>;
export const NO_GRANT: Grant = { edit: false, maintain: false, financial: false, insurance: false, documents: false };

export const sharingInput = z
    .object({
        visibility: z.enum(VISIBILITIES),
        household: grant.optional(),
        people: z
            .array(z.object({ email: z.string().trim().toLowerCase().email().max(254), ...grant.shape }).strict())
            .max(LIMITS.sharesPerAsset)
            .optional(),
        version: z.number().int().min(1),
    })
    .strict();
export type SharingInput = z.input<typeof sharingInput>;

export const locationInput = z
    .object({
        name: z.string().trim().min(1, "Give it a name").max(120),
        kind: z.enum(LOCATION_KINDS),
        parentId: locationId.nullable().optional(),
        tenure: z.enum(TENURES).nullable().optional(),
        address: optionalText(300),
        leaseStart: isoDate.nullable().optional(),
        leaseEnd: isoDate.nullable().optional(),
        managerName: optionalText(120),
        managerPhone: optionalText(40),
        managerEmail: z
            .string()
            .trim()
            .toLowerCase()
            .email()
            .max(254)
            .nullable()
            .optional()
            .or(z.literal("").transform(() => null)),
        nextInspectionOn: isoDate.nullable().optional(),
        utilities: optionalText(2000),
        notes: optionalText(4000),
        visibility: z.enum(["private", "household"]).optional(),
        householdCanEdit: z.boolean().optional(),
    })
    .strict();
export const updateLocationInput = locationInput
    .partial()
    .extend({ version: z.number().int().min(1), archived: z.boolean().optional() })
    .strict();

const intervalFields = {
    intervalCount: z.number().int().min(1).max(1000).nullable().optional(),
    intervalUnit: z.enum(INTERVAL_UNITS).nullable().optional(),
    intervalKm: z.number().int().min(1).max(1_000_000).nullable().optional(),
};

export const scheduleInput = z
    .object({
        assetId: assetId.optional(),
        locationId: locationId.optional(),
        title: z.string().trim().min(1, "Give it a title").max(200),
        category: z.enum(MAINTENANCE_CATEGORIES),
        ...intervalFields,
        firstDueOn: isoDate.nullable().optional(),
        firstDueKm: z.number().int().min(0).nullable().optional(),
        lastDoneOn: isoDate.nullable().optional(),
        lastDoneKm: z.number().int().min(0).nullable().optional(),
        reminderDays: z.array(z.number().int().min(0).max(365)).max(5).optional(),
        responsibility: z.enum(RESPONSIBILITIES).optional(),
        provider: optionalText(200),
        notes: optionalText(2000),
        templateId: z.string().max(40).nullable().optional(),
        autoNext: z.boolean().optional(),
        taskLeadDays: z.number().int().min(0).max(365).nullable().optional(),
        active: z.boolean().optional(),
    })
    .strict();
export const updateScheduleInput = scheduleInput
    .omit({ assetId: true, locationId: true })
    .partial()
    .extend({ version: z.number().int().min(1) })
    .strict();

export const maintenanceInput = z
    .object({
        assetId: assetId.optional(),
        locationId: locationId.optional(),
        scheduleId: scheduleId.optional(),
        title: z.string().trim().min(1, "Give it a title").max(200),
        description: optionalText(4000),
        kind: z.enum(MAINTENANCE_KINDS).optional(),
        category: z.enum(MAINTENANCE_CATEGORIES).optional(),
        priority: z.enum(PRIORITIES).optional(),
        status: z.enum(MAINTENANCE_STATUSES).optional(),
        dueOn: isoDate.nullable().optional(),
        dueKm: z.number().int().min(0).nullable().optional(),
        scheduledOn: isoDate.nullable().optional(),
        scheduledTime: z
            .string()
            .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
            .nullable()
            .optional(),
        completedOn: isoDate.nullable().optional(),
        odometer: z.number().int().min(0).nullable().optional(),
        costCents: cents.nullable().optional(),
        provider: optionalText(200),
        notes: optionalText(8000),
        responsibility: z.enum(RESPONSIBILITIES).optional(),
        requestReference: optionalText(80),
        requestedOn: isoDate.nullable().optional(),
        approval: z.enum(APPROVALS).optional(),
        checklist: z
            .array(z.object({ text: z.string().trim().min(1).max(200), done: z.boolean() }).strict())
            .max(30)
            .optional(),
        clientId,
    })
    .strict();
export const updateMaintenanceInput = maintenanceInput
    .omit({ assetId: true, locationId: true, scheduleId: true, clientId: true })
    .partial()
    .extend({ version: z.number().int().min(1) })
    .strict();
export const completeMaintenanceInput = z
    .object({
        completedOn: isoDate,
        odometer: z.number().int().min(0).nullable().optional(),
        costCents: cents.nullable().optional(),
        provider: optionalText(200),
        notes: optionalText(8000),
        /** Also complete the linked Daly Task, if there is one and you can. Default true. */
        completeTask: z.boolean().optional(),
        version: z.number().int().min(1).optional(),
    })
    .strict();

export const templateInput = z
    .object({
        title: z.string().trim().min(1).max(200),
        category: z.enum(MAINTENANCE_CATEGORIES),
        appliesTo: z.enum(["any", "vehicle", "trailer", "property", "appliance", "equipment"]).optional(),
        ...intervalFields,
        checklist: z.array(z.string().trim().min(1).max(200)).max(30).optional(),
        notes: optionalText(2000),
    })
    .strict();

export const policyInput = z
    .object({
        provider: z.string().trim().min(1, "Who is the insurer?").max(120),
        policyType: z.enum(POLICY_TYPES),
        name: optionalText(120),
        reference: optionalText(80),
        startsOn: isoDate.nullable().optional(),
        renewsOn: isoDate.nullable().optional(),
        premiumCents: cents.nullable().optional(),
        paymentFrequency: z.enum(FREQUENCIES).nullable().optional(),
        excessCents: cents.nullable().optional(),
        coverageSummary: optionalText(4000),
        coverageLimits: optionalText(4000),
        exclusions: optionalText(4000),
        contactPhone: optionalText(40),
        contactEmail: z
            .string()
            .trim()
            .toLowerCase()
            .email()
            .max(254)
            .nullable()
            .optional()
            .or(z.literal("").transform(() => null)),
        contactUrl: z
            .string()
            .trim()
            .max(300)
            .regex(/^https:\/\//, "Use an https:// address")
            .nullable()
            .optional()
            .or(z.literal("").transform(() => null)),
        notes: optionalText(4000),
        status: z.enum(POLICY_STATUSES).optional(),
        previousId: policyId.nullable().optional(),
        shared: z.boolean().optional(),
        householdCanEdit: z.boolean().optional(),
        /** Fields the person took from an AI suggestion and hasn't checked yet. */
        unverifiedFields: z.array(z.string().max(40)).max(30).optional(),
    })
    .strict();
export const updatePolicyInput = policyInput
    .partial()
    .extend({ version: z.number().int().min(1) })
    .strict();

export const warrantyInput = z
    .object({
        kind: z.enum(WARRANTY_KINDS),
        provider: optionalText(120),
        startsOn: isoDate.nullable().optional(),
        months: z.number().int().min(1).max(600).nullable().optional(),
        expiresOn: isoDate.nullable().optional(),
        reference: optionalText(80),
        terms: optionalText(4000),
        contact: optionalText(300),
        costCents: cents.nullable().optional(),
    })
    .strict();
export const updateWarrantyInput = warrantyInput
    .partial()
    .extend({ version: z.number().int().min(1) })
    .strict();

export const claimInput = z
    .object({
        assetId: assetId.optional(),
        warrantyId: warrantyId.nullable().optional(),
        policyId: policyId.nullable().optional(),
        kind: z.enum(CLAIM_KINDS),
        lodgedOn: isoDate.nullable().optional(),
        reference: optionalText(80),
        description: optionalText(4000),
        status: z.enum(CLAIM_STATUSES).optional(),
        amountClaimedCents: cents.nullable().optional(),
        amountPaidCents: cents.nullable().optional(),
        outcome: optionalText(2000),
    })
    .strict();
export const updateClaimInput = claimInput.omit({ assetId: true, kind: true }).partial().strict();

export const valuationInput = z
    .object({
        kind: z.enum(VALUATION_KINDS),
        basis: z.enum(VALUATION_BASES),
        amountCents: cents,
        valuedOn: isoDate,
        source: optionalText(300),
    })
    .strict();

export const odometerInput = z
    .object({
        reading: z.number().int().min(0).max(10_000_000),
        readOn: isoDate,
        correction: z.boolean().optional(),
        note: optionalText(300),
    })
    .strict();

export const categoryInput = z
    .object({
        name: z.string().trim().min(1).max(80),
        fields: z
            .array(
                z
                    .object({
                        key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "Use lower-case letters, digits and _"),
                        label: z.string().trim().min(1).max(60),
                        type: z.enum(FIELD_TYPES),
                        options: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
                    })
                    .strict(),
            )
            .max(30)
            .optional(),
        archived: z.boolean().optional(),
    })
    .strict();

export const taskRequestInput = z
    .object({
        refKind: z.enum(TASK_REF_KINDS),
        refId: z.string().regex(/^[a-z]{3}_[a-z0-9]{14}$/),
        /** As in an attention item's taskRef. Ignored: the date always comes from the record as it is now. */
        refDate: z.string().max(10).optional(),
        title: z.string().trim().min(1).max(500).optional(),
        dueDate: isoDate.nullable().optional(),
        projectId: z
            .string()
            .regex(/^tpj_[a-z0-9]{14}$/)
            .optional(),
    })
    .strict();

// --- Preferences ---------------------------------------------------------------------------------

const reminderSetting = (days: number[]) =>
    z
        .object({
            inApp: z.boolean().default(true),
            email: z.boolean().default(false),
            days: z.array(z.number().int().min(0).max(365)).max(5).default(days),
        })
        .default({ inApp: true, email: false, days });

export const DEFAULT_REMINDER_DAYS: Record<ReminderKind, number[]> = {
    maintenance: [14, 0],
    registration: [30, 7, 0],
    insurance: [30, 7],
    warranty: [30],
    inspection: [14, 0],
    lease: [60, 30],
    roadside: [30],
};

/** Not strict: a field a later version adds is dropped by an older Worker, never a reason to fail. */
export const assetPreferencesSchema = z.object({
    today: z
        .object({
            enabled: z.boolean().default(true),
            horizonDays: z.union([z.literal(30), z.literal(60), z.literal(90)]).default(30),
            maxItems: z.number().int().min(1).max(10).default(6),
        })
        .default({ enabled: true, horizonDays: 30, maxItems: 6 }),
    briefing: z.object({ include: z.boolean().default(true) }).default({ include: true }),
    reminders: z
        .object({
            maintenance: reminderSetting(DEFAULT_REMINDER_DAYS.maintenance),
            registration: reminderSetting(DEFAULT_REMINDER_DAYS.registration),
            insurance: reminderSetting(DEFAULT_REMINDER_DAYS.insurance),
            warranty: reminderSetting(DEFAULT_REMINDER_DAYS.warranty),
            inspection: reminderSetting(DEFAULT_REMINDER_DAYS.inspection),
            lease: reminderSetting(DEFAULT_REMINDER_DAYS.lease),
            roadside: reminderSetting(DEFAULT_REMINDER_DAYS.roadside),
        })
        .prefault({}),
    /** Also remind me about assets other people share with me (where I can see that information). */
    householdReminders: z.boolean().default(false),
    /** Put the asset's name in reminder emails (off: "You have a Home & Assets reminder"). */
    emailDetails: z.boolean().default(false),
    /** How far ahead counts as "due soon". */
    dueSoonDays: z.number().int().min(1).max(180).default(30),
    dueSoonDistance: z.number().int().min(0).max(100_000).default(1000),
    /** Leave items worth less than this out of summaries and reports (0: include everything). */
    lowValueCents: z.number().int().min(0).max(10_000_000).default(0),
    layout: z.enum(["list", "cards"]).default("list"),
    retention: z
        .object({
            /** List documents of things disposed of more than this many years ago for review (null: never). */
            disposedYears: z.number().int().min(1).max(30).nullable().default(null),
        })
        .default({ disposedYears: null }),
});
export type AssetPreferences = z.output<typeof assetPreferencesSchema>;
export const DEFAULT_ASSET_PREFERENCES: AssetPreferences = assetPreferencesSchema.parse({});

// --- Views ---------------------------------------------------------------------------------------

export interface Rights {
    view: true;
    edit: boolean;
    maintain: boolean;
    financial: boolean;
    insurance: boolean;
    documents: boolean;
    /** Sharing, deleting and labels: the owner only. */
    manage: boolean;
}

export interface ValueView {
    amountCents: number;
    basis: ValueBasis;
    valuedOn: string;
}

export type WarrantyState = "active" | "expiring" | "expired" | "unknown" | "none";
/** Never "insured": only whether a verified, current policy record is linked. */
export type CoverageState = "verified" | "unverified" | "lapsed" | "none" | "hidden";
export const COVERAGE_LABELS: Record<CoverageState, string> = {
    verified: "Linked to a verified policy",
    unverified: "Linked policy not yet verified",
    lapsed: "Linked policy has lapsed",
    none: "No policy linked",
    hidden: "Insurance not shared with you",
};
export type DueState = "overdue" | "due_soon" | "upcoming" | "unknown";

export interface PersonRef {
    email: string;
    name: string | null;
}

export interface AssetSummary {
    id: string;
    name: string;
    category: string;
    categoryLabel: string;
    group: CategoryGroup;
    manufacturer: string | null;
    brand: string | null;
    model: string | null;
    serialNumber: string | null;
    barcode: string | null;
    status: AssetStatus;
    condition: AssetCondition;
    ownership: string | null;
    location: { id: string; name: string } | null;
    /** The asset is in a place the viewer can't see. */
    locationHidden: boolean;
    tags: string[];
    owner: PersonRef;
    mine: boolean;
    visibility: AssetVisibility;
    coverFileId: string | null;
    purchaseDate: string | null;
    /** Null with financialHidden false: not recorded. */
    purchasePriceCents: number | null;
    currentValue: ValueView | null;
    replacementValue: ValueView | null;
    financialHidden: boolean;
    vehicle: { kind: VehicleKind; registration: string | null; registrationExpiry: string | null; odometer: number | null; odometerUnit: OdometerUnit } | null;
    warranty: { state: WarrantyState; expiresOn: string | null };
    coverage: CoverageState;
    maintenance: { overdue: number; dueSoon: number; nextDueOn: string | null; open: number };
    /** No receipt or invoice, or no photo. Only for people who can open documents. */
    needsDocuments: { proof: boolean; photo: boolean } | null;
    rights: Rights;
    version: number;
    updatedAt: string;
}

export interface VehicleDetail {
    kind: VehicleKind;
    registration: string | null;
    jurisdiction: string | null;
    registrationExpiry: string | null;
    vin: string | null;
    engineNumber: string | null;
    make: string | null;
    model: string | null;
    year: number | null;
    odometerUnit: OdometerUnit;
    roadsideProvider: string | null;
    roadsideReference: string | null;
    roadsideExpiry: string | null;
    inspectionDue: string | null;
    batteryInstalledOn: string | null;
    atmKg: number | null;
    gtmKg: number | null;
    tareKg: number | null;
    ballWeightKg: number | null;
    specs: VehicleSpecs;
    odometer: { reading: number; readOn: string } | null;
}

export interface OdometerReading {
    id: string;
    reading: number;
    readOn: string;
    correction: boolean;
    note: string | null;
    maintenanceId: string | null;
}

export interface ValuationView {
    id: string;
    kind: ValuationKind;
    basis: ValuationBasis;
    amountCents: number;
    valuedOn: string;
    source: string | null;
}

export interface WarrantyView {
    id: string;
    assetId: string;
    assetName: string;
    kind: WarrantyKind;
    provider: string | null;
    startsOn: string | null;
    months: number | null;
    expiresOn: string | null;
    expiresBasis: "stated" | "calculated" | "unknown";
    state: WarrantyState;
    reference: string | null;
    terms: string | null;
    contact: string | null;
    costCents: number | null;
    version: number;
}

export interface ClaimView {
    id: string;
    assetId: string | null;
    assetName: string | null;
    warrantyId: string | null;
    policyId: string | null;
    kind: ClaimKind;
    lodgedOn: string | null;
    reference: string | null;
    description: string | null;
    status: ClaimStatus;
    amountClaimedCents: number | null;
    amountPaidCents: number | null;
    outcome: string | null;
    updatedAt: string;
}

export interface ScheduleView {
    id: string;
    assetId: string | null;
    locationId: string | null;
    targetName: string;
    title: string;
    category: MaintenanceCategory;
    intervalCount: number | null;
    intervalUnit: IntervalUnit | null;
    intervalKm: number | null;
    firstDueOn: string | null;
    firstDueKm: number | null;
    lastDoneOn: string | null;
    lastDoneKm: number | null;
    nextDueOn: string | null;
    nextDueKm: number | null;
    /** Distance left, when an odometer reading exists. */
    remainingKm: number | null;
    state: DueState;
    /** Why it's unknown, in words (e.g. "Record an odometer reading"). */
    unknownReason: string | null;
    reminderDays: number[];
    responsibility: Responsibility;
    provider: string | null;
    notes: string | null;
    templateId: string | null;
    autoNext: boolean;
    taskLeadDays: number | null;
    active: boolean;
    openRecordId: string | null;
    version: number;
}

export interface LinkedTask {
    taskId: string;
    /** False when the person can't see the task (or it was deleted). */
    available: boolean;
    title: string | null;
    status: string | null;
    dueDate: string | null;
}

export interface MaintenanceView {
    id: string;
    assetId: string | null;
    locationId: string | null;
    targetName: string;
    scheduleId: string | null;
    title: string;
    description: string | null;
    kind: MaintenanceKind;
    category: MaintenanceCategory;
    priority: MaintenancePriority;
    status: MaintenanceStatus;
    dueOn: string | null;
    dueKm: number | null;
    scheduledOn: string | null;
    scheduledTime: string | null;
    completedOn: string | null;
    odometer: number | null;
    /** Null with costHidden false: not recorded. */
    costCents: number | null;
    costHidden: boolean;
    provider: string | null;
    notes: string | null;
    responsibility: Responsibility;
    requestReference: string | null;
    requestedOn: string | null;
    approval: Approval;
    checklist: { text: string; done: boolean }[];
    state: DueState | null;
    task: LinkedTask | null;
    calendarEventId: string | null;
    fileCount: number;
    canEdit: boolean;
    version: number;
    updatedAt: string;
}

export interface LocationView {
    id: string;
    name: string;
    kind: LocationKind;
    parentId: string | null;
    parentName: string | null;
    tenure: Tenure | null;
    address: string | null;
    leaseStart: string | null;
    leaseEnd: string | null;
    managerName: string | null;
    managerPhone: string | null;
    managerEmail: string | null;
    nextInspectionOn: string | null;
    utilities: string | null;
    notes: string | null;
    visibility: "private" | "household";
    householdCanEdit: boolean;
    mine: boolean;
    canEdit: boolean;
    owner: PersonRef;
    archived: boolean;
    assetCount: number;
    openMaintenance: number;
    version: number;
}

export interface PolicyView {
    id: string;
    provider: string;
    policyType: PolicyType;
    name: string | null;
    reference: string | null;
    startsOn: string | null;
    renewsOn: string | null;
    premiumCents: number | null;
    paymentFrequency: PaymentFrequency | null;
    excessCents: number | null;
    coverageSummary: string | null;
    coverageLimits: string | null;
    exclusions: string | null;
    contactPhone: string | null;
    contactEmail: string | null;
    contactUrl: string | null;
    notes: string | null;
    status: PolicyStatus;
    previousId: string | null;
    unverifiedFields: string[];
    verified: { at: string; by: string } | null;
    shared: boolean;
    householdCanEdit: boolean;
    mine: boolean;
    canEdit: boolean;
    owner: PersonRef;
    /** Assets linked that the viewer can see (with insurance shown to them). */
    assets: { id: string; name: string; agreedValueCents: number | null }[];
    /** Linked assets the viewer can't see. */
    hiddenAssetCount: number;
    premiums: { periodStart: string; premiumCents: number; paymentFrequency: PaymentFrequency | null }[];
    fileCount: number;
    version: number;
}

export interface AssetFileView {
    id: string;
    kind: AssetFileKind;
    photoTag: PhotoTag | null;
    caption: string | null;
    filename: string;
    contentType: string;
    bytes: number;
    width: number | null;
    height: number | null;
    hasThumb: boolean;
    assetId: string | null;
    assetName: string | null;
    locationId: string | null;
    policyId: string | null;
    maintenanceId: string | null;
    warrantyId: string | null;
    claimId: string | null;
    uploadedBy: string;
    mine: boolean;
    createdAt: string;
}

export interface KnowledgeLinkView {
    objectId: string;
    available: boolean;
    title: string | null;
    spaceName: string | null;
}

export interface AssetActivityView {
    at: string;
    actor: string;
    action: string;
    entityType: string;
    via: "portal" | "mcp" | "system";
}

export interface AssetShareView {
    email: string;
    name: string | null;
    grant: Grant;
}

export interface AssetDetail {
    asset: AssetSummary & {
        description: string | null;
        notes: string | null;
        purchaseLocation: string | null;
        custom: Record<string, string | number | boolean | null>;
        customFields: CustomFieldDef[];
        depreciation: Depreciation | null;
        formulaValue: ValueView | null;
        disposal: { on: string | null; method: DisposalMethod | null; amountCents: number | null; notes: string | null };
        labelVersion: number;
        createdAt: string;
        createdBy: string;
    };
    vehicle: VehicleDetail | null;
    odometer: OdometerReading[];
    valuations: ValuationView[] | null;
    warranties: WarrantyView[];
    policies: PolicyView[] | null;
    claims: ClaimView[];
    schedules: ScheduleView[];
    maintenance: MaintenanceView[];
    files: AssetFileView[];
    /** Documents exist but the viewer can't open them. */
    documentsHidden: number;
    knowledge: KnowledgeLinkView[];
    tasks: (LinkedTask & { refKind: TaskRefKind; refDate: string })[];
    sharing: { visibility: AssetVisibility; household: Grant | null; people: AssetShareView[] } | null;
    activity: AssetActivityView[];
    totals: { maintenanceCostCents: number | null; maintenanceRecords: number; costsMissing: number } | null;
}

// --- Attention, dashboard, reports ---------------------------------------------------------------

export const ATTENTION_KINDS = ["maintenance", "registration", "insurance", "warranty", "inspection", "lease", "roadside", "repair"] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

/** One fact that needs attention, stated only from records. */
export interface AttentionItem {
    key: string;
    kind: AttentionKind;
    state: "overdue" | "due_soon" | "upcoming";
    date: string | null;
    daysAway: number | null;
    /** e.g. "Cub Camper Frontier registration is due in 21 days." */
    sentence: string;
    /** e.g. "No renewal Task has been created." Null when there is a task, or none can be made. */
    taskNote: string | null;
    title: string;
    targetName: string;
    url: string;
    assetId: string | null;
    refId: string;
    taskRef: { refKind: TaskRefKind; refId: string; refDate: string } | null;
    taskId: string | null;
}

export interface CategoryCount {
    category: string;
    label: string;
    count: number;
    /** Sum of current values recorded (or formula), and how many have none. Null when hidden. */
    valueCents: number | null;
    withoutValue: number;
}

export interface AssetsOverview {
    today: string;
    timeZone: string;
    totals: {
        assets: number;
        vehicles: number;
        locations: number;
        policies: number;
        /** Values the person may see. Missing values are counted, never treated as zero. */
        valueCents: number | null;
        valued: number;
        unvalued: number;
        replacementCents: number | null;
        purchaseCents: number | null;
        financialHidden: number;
    };
    byCategory: CategoryCount[];
    attention: AttentionItem[];
    horizon: { days30: number; days60: number; days90: number };
    overdue: AttentionItem[];
    recentRepairs: MaintenanceView[];
    recentPurchases: AssetSummary[];
    needsDocuments: AssetSummary[];
    notifications: AssetNotificationView[];
}

export interface AssetNotificationView {
    id: string;
    reminder: ReminderKind;
    dueOn: string;
    fireOn: string;
    sentence: string;
    url: string;
}

export interface TodayAssets {
    items: AttentionItem[];
    total: number;
    horizonDays: number;
}

export interface AssetSearchResults {
    assets: AssetSummary[];
    maintenance: MaintenanceView[];
    files: AssetFileView[];
    locations: LocationView[];
    knowledge: { id: string; title: string; spaceName: string; snippet: string | null }[] | null;
}

export interface AssetFilters {
    q: string;
    category: string | null;
    group: CategoryGroup | null;
    locationId: string | null;
    owner: "mine" | "shared" | null;
    status: "current" | "gone" | AssetStatus | null;
    condition: AssetCondition | null;
    warranty: WarrantyState | null;
    coverage: CoverageState | null;
    maintenance: "overdue" | "due_soon" | "none" | null;
    visibility: AssetVisibility | null;
    minValue: number | null;
    maxValue: number | null;
    tag: string | null;
}

export const REPORTS = ["inventory", "values", "categories", "maintenance", "expenditure", "renewals", "warranties", "vehicles", "household", "claim"] as const;
export type ReportName = (typeof REPORTS)[number];
export const REPORT_LABELS: Record<ReportName, { label: string; description: string }> = {
    inventory: { label: "Asset inventory", description: "Every asset you can see, with identifiers, location, warranty and coverage state." },
    values: { label: "Estimated values", description: "Purchase, current and replacement values, each labelled with where it came from." },
    categories: { label: "Assets by category", description: "Counts and recorded values by category." },
    maintenance: { label: "Maintenance history", description: "Completed and open maintenance, with costs where recorded." },
    expenditure: { label: "Annual maintenance spend", description: "Recorded maintenance costs by year, and how many records have no cost." },
    renewals: { label: "Insurance renewals", description: "Policies by renewal date, with premium history." },
    warranties: { label: "Warranties", description: "Stated and calculated expiry dates." },
    vehicles: { label: "Vehicle costs", description: "Maintenance costs and records per vehicle and trailer." },
    household: { label: "Household inventory", description: "Assets grouped by location, for a contents list." },
    claim: { label: "Insurance claim documentation", description: "Identifiers, purchase details, values, documents and photos for chosen assets." },
};

// --- Pages ---------------------------------------------------------------------------------------

export interface AssetsShell {
    canAi: boolean;
    aiNote: string | null;
    preferences: AssetPreferences;
    preferencesVersion: number;
    categories: AssetCategory[];
    locations: { id: string; name: string; kind: LocationKind }[];
    unreadNotifications: number;
    emailOn: boolean;
    canTasks: boolean;
    canCalendar: boolean;
    canKnowledge: boolean;
    today: string;
}

export type AssetsSection = "overview" | "all" | "vehicles" | "property" | "maintenance" | "insurance" | "warranties" | "documents" | "reports" | "settings";

export type AssetsRoute =
    | ({ route: "assets-overview" } & AssetsShell & { overview: AssetsOverview })
    | ({ route: "assets-list" } & AssetsShell & {
              section: "all" | "vehicles";
              assets: AssetSummary[];
              truncated: boolean;
              filters: AssetFilters;
          })
    | ({ route: "assets-item" } & AssetsShell & { detail: AssetDetail; tab: string; labelVersionScanned: number | null })
    | ({ route: "assets-property" } & AssetsShell & {
              places: LocationView[];
              maintenance: MaintenanceView[];
              schedules: ScheduleView[];
          })
    | ({ route: "assets-location" } & AssetsShell & {
              location: LocationView;
              assets: AssetSummary[];
              maintenance: MaintenanceView[];
              schedules: ScheduleView[];
              files: AssetFileView[];
          })
    | ({ route: "assets-maintenance" } & AssetsShell & {
              view: "upcoming" | "open" | "history" | "schedules" | "templates";
              maintenance: MaintenanceView[];
              schedules: ScheduleView[];
              templates: { builtin: import("./templates").MaintenanceTemplate[]; household: HouseholdTemplate[] };
              targets: { id: string; name: string; kind: "asset" | "location" }[];
          })
    | ({ route: "assets-insurance" } & AssetsShell & {
              policies: PolicyView[];
              coverage: { asset: { id: string; name: string; categoryLabel: string }; state: CoverageState }[];
              claims: ClaimView[];
              assets: { id: string; name: string }[];
          })
    | ({ route: "assets-warranties" } & AssetsShell & { warranties: WarrantyView[]; claims: ClaimView[]; assets: { id: string; name: string }[] })
    | ({ route: "assets-documents" } & AssetsShell & {
              files: AssetFileView[];
              inbox: AssetFileView[];
              needsDocuments: AssetSummary[];
              retentionDue: AssetFileView[];
              assets: { id: string; name: string }[];
          })
    | ({ route: "assets-reports" } & AssetsShell & { assets: { id: string; name: string; locationName: string | null }[] })
    | ({ route: "assets-register" } & AssetsShell & {
              kind: "household" | "claim" | "inventory";
              assets: AssetSummary[];
              details: AssetDetail[];
              generatedAt: string;
          })
    | ({ route: "assets-settings" } & AssetsShell & { templates: HouseholdTemplate[] })
    | ({ route: "assets-capture" } & AssetsShell & { inbox: AssetFileView[]; mode: "quick" | "photo" | "receipt" | "scan" })
    | ({ route: "assets-labels" } & AssetsShell & { assets: { id: string; name: string; labelVersion: number; categoryLabel: string }[] })
    | ({ route: "assets-search" } & AssetsShell & { q: string; results: AssetSearchResults });

export interface HouseholdTemplate {
    id: string;
    title: string;
    category: MaintenanceCategory;
    appliesTo: string;
    intervalCount: number | null;
    intervalUnit: IntervalUnit | null;
    intervalKm: number | null;
    checklist: string[];
    notes: string | null;
    builtin: false;
}

// --- AI capture ----------------------------------------------------------------------------------

/** One value a model proposed, with the words in the document it came from. */
export interface ProposedValue<T = string | number> {
    value: T;
    /** The source text it was found in, so a person can check it. */
    evidence: string | null;
    /** True only if the value (or its digits) appears in the document's text. */
    grounded: boolean;
}

export interface ReceiptProposal {
    merchant: ProposedValue<string> | null;
    purchaseDate: ProposedValue<string> | null;
    items: { description: ProposedValue<string>; amountCents: ProposedValue<number> | null }[];
    totalCents: ProposedValue<number> | null;
    warranty: ProposedValue<string> | null;
    documentKind: AssetFileKind | null;
    model: string;
    note: string;
}

export interface PhotoProposal {
    itemType: string | null;
    manufacturer: string | null;
    model: string | null;
    category: string | null;
    description: string | null;
    /** Always "low" or "medium": an identification from a photo is never certain. */
    confidence: "low" | "medium";
    modelId: string;
    note: string;
}

export interface PolicyProposal {
    fields: Partial<Record<"provider" | "reference" | "startsOn" | "renewsOn" | "premiumCents" | "excessCents" | "policyType", ProposedValue>>;
    coverage: { statement: string; evidence: string; grounded: boolean }[];
    exclusions: { statement: string; evidence: string; grounded: boolean }[];
    model: string;
    note: string;
}
