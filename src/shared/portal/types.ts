// Data shapes shared by the worker and the portal/wedding browser bundles.
import type { ApplicationId } from "./applications";
import type { Flags } from "./flags";
import type { ImportHistoryEntry } from "./guest-import";
import type { Permission, Role } from "./permissions";

export interface PortalUser {
    email: string;
    name: string | null;
    role: Role;
    permissions: Permission[];
}

// ---------------------------------------------------------------------------------------------
// Settings documents

export interface WeddingDetails {
    partnerOne: string;
    partnerTwo: string;
    /** YYYY-MM-DD, or empty while undecided. */
    date: string;
    /** Free text shown on the website, e.g. "Southern Highlands, NSW". Empty hides it. */
    location: string;
    /** IANA time zone used for countdowns and "today". */
    timeZone: string;
}

export interface InvitationTemplateSettings {
    /** The visual treatment shared by print and email previews. */
    artwork: "native-botanicals" | "none";
    accent: "burgundy" | "rust" | "eucalyptus";
    eyebrow: string;
    invitationLine: string;
    greetingPrefix: string;
    emailIntroduction: string;
    emailSignoff: string;
}

export const SECTION_KINDS = ["story", "details", "venue", "accommodation", "travel", "transport", "children", "dress", "registry", "faq", "custom"] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

/** A titled entry inside a section: an accommodation option, an FAQ, a registry link. */
export interface WebsiteItem {
    title: string;
    body: string;
    url: string;
    /** A short label shown above the title, e.g. "5.2 km from the ceremony". */
    detail: string;
    /** website_media id of a photo for this item (a place to stay), if any. */
    imageId: string | null;
}

export interface WebsiteSection {
    id: string;
    kind: SectionKind;
    title: string;
    body: string;
    items: WebsiteItem[];
    /** website_media id of the section's photo (story, venue, accommodation…), if any. */
    imageId: string | null;
    /** Hidden sections stay in the draft but never appear on the site. */
    visible: boolean;
}

export interface WebsiteContent {
    heroEyebrow: string;
    heroTitle: string;
    heroSubtitle: string;
    /** website_media id of the hero photo, if any. */
    heroImageId: string | null;
    /** Focal point percentages used by responsive object-position cropping. */
    heroFocalX: number;
    heroFocalY: number;
    welcome: string;
    sections: WebsiteSection[];
    /** The closing RSVP invitation, e.g. "We hope you'll celebrate with us." */
    rsvpHeading: string;
    rsvpText: string;
    showGallery: boolean;
    contactEmail: string;
    /** Keep search engines away. On by default. */
    noindex: boolean;
}

export interface WebsiteMedia {
    id: string;
    url: string;
    contentType: string;
    bytes: number;
    width: number | null;
    height: number | null;
    alt: string;
    caption: string | null;
    inGallery: boolean;
    sortOrder: number;
}

export interface MealCategory {
    id: string;
    label: string;
    description: string;
    /** Who the category can be chosen for. */
    appliesTo: "any" | "adult" | "child";
}

export interface CateringSettings {
    /** The event the meal is served at. Null = picked automatically (an event called "Reception", else the first). */
    eventId: string | null;
    categories: MealCategory[];
    /** Category adults get when nobody has chosen one. Children never get one automatically. */
    adultDefault: string | null;
    notes: string;
}

export interface RsvpSettings {
    /** Link to the RSVP form currently in use (Say I Do). */
    externalUrl: string;
    /** YYYY-MM-DD. After this date the native form is read-only. Empty means no deadline. */
    deadline: string;
    collectDietary: boolean;
    collectMessage: boolean;
    allowChangesAfterDeadline: boolean;
    /** Accept the short household codes as well as invitation links. */
    allowCodes: boolean;
    /** Invitation links stop working this many days after the deadline. 0 = never. */
    linkExpiryDays: number;
    /** Email a confirmation after an online RSVP. Also needs email delivery switched on. */
    confirmationEmail: boolean;
}

export interface BudgetSettings {
    totalCents: number;
    currency: string;
}

export interface PrivacySettings {
    /** Audit entries older than this many days can be removed with "Apply retention". 0 keeps them forever. */
    auditRetentionDays: number;
    /** Deleted guests and households older than this many days can be erased with "Apply retention". */
    deletedRetentionDays: number;
}

export interface SettingsDocuments {
    privacy: PrivacySettings;
    catering: CateringSettings;
    /** What the portal edits; the public site shows `website` until changes are published. */
    website_draft: WebsiteContent;
    wedding: WeddingDetails;
    invitation: InvitationTemplateSettings;
    website: WebsiteContent;
    rsvp: RsvpSettings;
    budget: BudgetSettings;
}
export type SettingsKey = keyof SettingsDocuments;

// ---------------------------------------------------------------------------------------------
// Entities

export type Side = "partner_one" | "partner_two" | "shared";
export type AgeGroup = "adult" | "child" | "infant";
export type RsvpStatus = "pending" | "attending" | "declined";
export type RsvpSource = "portal" | "native" | "sayido" | "import";
export type ContactPreference = "email" | "post" | "phone" | "none";

export interface GuestEventStatus {
    eventId: string;
    status: RsvpStatus;
    source: RsvpSource | null;
    respondedAt: string | null;
}

export interface Guest {
    id: string;
    householdId: string | null;
    householdName: string | null;
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
    side: Side;
    groupName: string | null;
    ageGroup: AgeGroup;
    isPlusOne: boolean;
    /** The guest this person is the plus-one of. */
    plusOneOf: string | null;
    dietary: string | null;
    allergies: string | null;
    /** Catering category id; null = not chosen (adults then count as the adult default). */
    mealCategory: string | null;
    contactPreference: ContactPreference;
    accessibility: string | null;
    notes: string | null;
    tags: string[];
    custom: Record<string, string | number | boolean | null>;
    events: GuestEventStatus[];
    /** Table name from the seating planner, if seated. */
    tableId: string | null;
    /** Derived: attending if attending anything, declined if declined everything, else pending. */
    rsvp: RsvpStatus | "not_invited";
    createdAt: string;
    updatedAt: string;
}

export interface Household {
    id: string;
    name: string;
    rsvpCode: string;
    email: string | null;
    phone: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    locality: string | null;
    region: string | null;
    postcode: string | null;
    country: string | null;
    notes: string | null;
    guestCount: number;
    inviteVersion: number;
    inviteRevokedAt: string | null;
    invitationUrl?: string | null;
    /** Say I Do party id the household was imported from, if any. */
    externalId: string | null;
    /** Last time invitations were generated in bulk for this household. Generating never sends. */
    invitationGeneratedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

/** How far a household has got with its RSVP, counted per invited guest and event. */
export type HouseholdResponseStatus = "not_invited" | "not_started" | "partial" | "complete";

export interface HouseholdResponse {
    status: HouseholdResponseStatus;
    /** Guests invited to at least one event. */
    invited: number;
    /** Guests who have answered every event they're invited to. */
    answered: number;
    /** Guests with some events answered and some not. */
    partial: number;
    /** Guests attending at least one event. */
    attending: number;
    /** Guests who declined everything. */
    declined: number;
    /** Guests with no answer at all. */
    waiting: number;
    /** Guest × event invitations, and how many are answered. */
    invitations: number;
    answeredInvitations: number;
    lastResponseAt: string | null;
    /** Names in invitation order, for the list. */
    guestNames: string[];
}

export type HouseholdRow = Household & { response: HouseholdResponse };

export interface WeddingEvent {
    id: string;
    name: string;
    startsAt: string | null;
    endsAt: string | null;
    venueName: string | null;
    address: string | null;
    description: string | null;
    dressCode: string | null;
    isPublic: boolean;
    rsvpEnabled: boolean;
    sortOrder: number;
    createdAt: string;
    updatedAt: string;
}

export type CustomFieldType = "text" | "number" | "boolean" | "select" | "date";

export interface CustomField {
    id: string;
    entity: "guest";
    key: string;
    label: string;
    type: CustomFieldType;
    options: string[];
    help: string | null;
    showInTable: boolean;
    sortOrder: number;
    archived: boolean;
    createdAt: string;
}

export interface RsvpSubmission {
    id: string;
    householdId: string;
    householdName: string;
    submittedAt: string;
    message: string | null;
    payload: RsvpSubmissionPayload;
}

export interface RsvpSubmissionPayload {
    /** "pending" means the household chose to answer for this person later. */
    guests: { guestId: string; name: string; events: Record<string, RsvpStatus>; dietary?: string | null }[];
    email?: string | null;
    answers?: {
        household: Record<string, AnswerValue>;
        guests: Record<string, Record<string, AnswerValue>>;
    };
}

export interface MessageTemplate {
    id: string;
    name: string;
    subject: string;
    body: string;
    category: MessageCategory;
    createdAt: string;
    updatedAt: string;
}

export type MessageStatus = "draft" | "queued" | "sending" | "sent" | "partial" | "failed";
/** Categories the couple can choose when preparing a message. */
export const MESSAGE_CATEGORIES = ["save_the_date", "invitation", "reminder", "update", "thank_you"] as const;
/** Categories only the system uses, e.g. the automatic email after an online RSVP. */
export const SYSTEM_MESSAGE_CATEGORIES = ["rsvp_confirmation"] as const;
export type MessageCategory = (typeof MESSAGE_CATEGORIES)[number] | (typeof SYSTEM_MESSAGE_CATEGORIES)[number];
export const MESSAGE_CATEGORY_LABELS: Record<MessageCategory, string> = {
    save_the_date: "Save the date",
    invitation: "Invitation",
    reminder: "Reminder",
    update: "Update",
    thank_you: "Thank you",
    rsvp_confirmation: "RSVP confirmation",
};
export const MESSAGE_CHANNELS = ["email", "sms"] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

export interface Audience {
    rsvp?: (RsvpStatus | "not_invited")[];
    eventId?: string | null;
    side?: Side[];
    groupName?: string | null;
    tag?: string | null;
    /** When set, only these guests (still filtered to guests with an email address). */
    guestIds?: string[];
    ageGroup?: AgeGroup[];
    contactPreference?: ContactPreference[];
}

export interface Message {
    id: string;
    templateId: string | null;
    subject: string;
    body: string;
    audience: Audience;
    channel: MessageChannel;
    category: MessageCategory;
    status: MessageStatus;
    recipientCount: number;
    deliveryNote: string | null;
    createdBy: string;
    createdAt: string;
    scheduledAt: string | null;
    sentAt: string | null;
}

export interface MessageRecipient {
    guestId: string;
    name: string;
    email: string | null;
    phone: string | null;
    status: "pending" | "sent" | "failed" | "skipped";
    error: string | null;
    sentAt: string | null;
    providerId: string | null;
    attempts: number;
    /** Reported later by the provider's webhook: delivered, bounced, complained, undelivered… */
    deliveryStatus: string | null;
    deliveredAt: string | null;
    costCents: number | null;
}

export interface SmsMessage {
    id: string;
    direction: "outbound" | "inbound";
    phone: string;
    guestId: string | null;
    householdId: string | null;
    body: string;
    status: "pending" | "sent" | "delivered" | "failed" | "received";
    providerId: string | null;
    costCents: number | null;
    error: string | null;
    messageId: string | null;
    createdBy: string;
    createdAt: string;
    readAt: string | null;
}

/** One phone number's conversation, newest message first in the list view. */
export interface SmsThread {
    phone: string;
    /** Guests with this number (a shared family phone can match several). */
    guests: { id: string; name: string; householdName: string | null }[];
    last: SmsMessage;
    unread: number;
    optedOut: boolean;
}

export interface CommsStatus {
    email: string | null;
    sms: string | null;
    emailFrom: string | null;
    smsFrom: string | null;
    webhooks: boolean;
}

export interface InvitationStudioHousehold {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    rsvpCode: string;
    inviteVersion: number;
    inviteRevoked: boolean;
    invitationGeneratedAt: string | null;
    /** `invited` is false for guests with no RSVP-enabled event; they get no invitation of their own. */
    guests: { id: string; name: string; invited: boolean }[];
    delivery: { channel: "email" | "sms" | "print"; status: string; updatedAt: string }[];
}

export interface InvitationPreview {
    key: string;
    householdId: string;
    guestId: string | null;
    householdName: string;
    guestNames: string[];
    highlightedGuest: string | null;
    coupleNames: string;
    greeting: string;
    eyebrow: string;
    invitationLine: string;
    weddingDate: string;
    location: string;
    artwork: InvitationTemplateSettings["artwork"];
    accent: InvitationTemplateSettings["accent"];
    sample: boolean;
    rsvpUrl: string;
    fallback: string;
    /** Null when RSVP codes are switched off, so no unusable code is printed or sent. */
    rsvpCode: string | null;
    qrDataUrl: string;
    eventLines: string[];
    deadline: string;
    emailSubject: string;
    emailBody: string;
    smsBody: string;
}

export type TaskStatus = "todo" | "in_progress" | "done";
export type TaskPriority = "low" | "medium" | "high";

export interface Task {
    id: string;
    title: string;
    notes: string | null;
    status: TaskStatus;
    priority: TaskPriority;
    category: string | null;
    dueDate: string | null;
    assignee: string | null;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
}

export interface TimelineItem {
    id: string;
    startsAt: string;
    endsAt: string | null;
    title: string;
    location: string | null;
    owner: string | null;
    notes: string | null;
    createdAt: string;
    updatedAt: string;
}

export type SupplierStatus = "researching" | "quoted" | "booked" | "cancelled";

export interface Supplier {
    id: string;
    name: string;
    category: string | null;
    status: SupplierStatus;
    contactName: string | null;
    email: string | null;
    phone: string | null;
    website: string | null;
    notes: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface BudgetItem {
    id: string;
    category: string;
    description: string;
    supplierId: string | null;
    supplierName: string | null;
    estimatedCents: number;
    actualCents: number | null;
    paidCents: number;
    dueDate: string | null;
    notes: string | null;
    createdAt: string;
    updatedAt: string;
}

export type PaymentState = "unpaid" | "partial" | "paid" | "overdue";

export interface AuditEntry {
    id: number;
    at: string;
    actor: string;
    action: string;
    entityType: string;
    entityId: string | null;
    summary: string;
    changes: unknown;
}

export interface DeletedRecord {
    type: "guest" | "household";
    id: string;
    name: string;
    detail: string | null;
    deletedAt: string;
    deletedBy: string | null;
}

export interface RetentionPreview {
    settings: PrivacySettings;
    auditCutoff: string | null;
    auditEntries: number;
    deletedCutoff: string;
    deletedRecords: number;
}

export interface PortalUserRecord {
    email: string;
    name: string | null;
    role: Role;
    active: boolean;
    /** True when the role comes from PORTAL_OWNER_EMAILS and cannot be changed in the portal. */
    fromConfig: boolean;
    createdAt: string | null;
    lastSeenAt: string | null;
}

// ---------------------------------------------------------------------------------------------
// Dashboard

export const WIDGET_TYPES = [
    "countdown",
    "rsvp-summary",
    "guest-breakdown",
    "event-attendance",
    "dietary",
    "upcoming-tasks",
    "budget-summary",
    "recent-activity",
    "rsvp-responses",
    "response-trend",
    "invitation-readiness",
    "seating-readiness",
    "communications-status",
] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];
export type WidgetSize = "sm" | "md" | "lg";

export interface DashboardWidget {
    id: string;
    type: WidgetType;
    size: WidgetSize;
}

export interface DashboardStats {
    guests: { total: number; adults: number; children: number; infants: number; withoutEmail: number; households: number };
    rsvp: { attending: number; declined: number; pending: number; notInvited: number };
    bySide: { side: Side; count: number }[];
    events: { id: string; name: string; startsAt: string | null; invited: number; attending: number; declined: number; pending: number }[];
    dietary: { label: string; count: number }[];
    tasks: { open: number; overdue: number; dueSoon: Pick<Task, "id" | "title" | "dueDate" | "priority" | "status">[] } | null;
    budget: { totalCents: number; estimatedCents: number; actualCents: number; paidCents: number; dueSoonCents: number; currency: string } | null;
    recentActivity: Pick<AuditEntry, "id" | "at" | "actor" | "summary">[] | null;
    recentResponses: { householdName: string; submittedAt: string; attending: number; declined: number }[];
    /** Cumulative count of guests who have answered at least one invitation, by day (wedding time zone not applied; UTC days). */
    responseTrend: { date: string; responded: number }[];
    invitations: { active: number; revoked: number };
    seating: { attending: number; seated: number; unseated: number; mealsUndecided: number } | null;
    communications: { drafts: number; queued: number; sent: number; failed: number } | null;
}

export interface PortalOverview {
    guests: number;
    pendingRsvps: number;
    attending: number;
    unseated: number;
    cateringUndecided: number;
    queuedMessages: number;
    failedDeliveries: number;
    activeInvitationLinks: number;
    revokedInvitationLinks: number;
}

// ---------------------------------------------------------------------------------------------
// Page payloads

export interface PortalContext {
    user: PortalUser;
    flags: Flags;
    wedding: WeddingDetails;
    environment: string;
}

export type PortalRoute =
    | { route: "portal-home"; applications: ApplicationId[] }
    | { route: "dashboard"; stats: DashboardStats; widgets: DashboardWidget[] }
    | {
          route: "guests";
          guests: Guest[];
          households: Pick<Household, "id" | "name">[];
          events: WeddingEvent[];
          customFields: CustomField[];
          mealCategories: MealCategory[];
          tables: Pick<SeatingTable, "id" | "name" | "capacity">[];
      }
    | {
          route: "households";
          households: HouseholdRow[];
          events: Pick<WeddingEvent, "id" | "name">[];
          emailDelivery: boolean;
          canGenerateLinks: boolean;
      }
    | {
          route: "guest-import";
          households: Pick<Household, "id" | "name" | "externalId">[];
          guests: { id: string; name: string; householdName: string | null }[];
          imports: ImportHistoryEntry[];
      }
    | { route: "events"; events: WeddingEvent[] }
    | {
          route: "rsvps";
          events: WeddingEvent[];
          stats: DashboardStats;
          submissions: RsvpSubmission[];
          settings: RsvpSettings;
          households: (Pick<Household, "id" | "name" | "rsvpCode"> & { guests: number; responded: number; status: HouseholdResponseStatus })[];
          questions: RsvpQuestion[];
          summaries: QuestionSummary[];
      }
    | {
          route: "communications";
          templates: MessageTemplate[];
          messages: Message[];
          events: WeddingEvent[];
          groups: string[];
          tags: string[];
          deliveryAvailable: boolean;
          comms: { status: CommsStatus; email: boolean; sms: boolean };
          unreadTexts: number;
      }
    | {
          route: "invitation-studio";
          households: InvitationStudioHousehold[];
          canGenerateLinks: boolean;
          template: InvitationTemplateSettings;
      }
    | { route: "provider-settings"; status: CommsStatus; emailEnabled: boolean; smsEnabled: boolean }
    | { route: "message"; message: Message; recipients: MessageRecipient[]; deliveryAvailable: boolean }
    | { route: "texts"; threads: SmsThread[]; status: CommsStatus; emailAvailable: boolean; smsAvailable: boolean }
    | { route: "tasks"; tasks: Task[]; assignees: { email: string; name: string | null }[] }
    | { route: "timeline"; items: TimelineItem[] }
    | { route: "seating"; state: SeatingState; canEdit: boolean }
    | { route: "catering"; summary: CateringSummary; events: Pick<WeddingEvent, "id" | "name">[] }
    | { route: "budget"; items: BudgetItem[]; suppliers: Pick<Supplier, "id" | "name">[]; settings: BudgetSettings }
    | { route: "suppliers"; suppliers: Supplier[] }
    | {
          route: "website";
          /** The draft being edited. */
          content: WebsiteContent;
          /** What the public site currently shows. */
          published: WebsiteContent;
          media: WebsiteMedia[];
          events: WeddingEvent[];
          rsvp: RsvpSettings;
      }
    | { route: "wedding-settings"; tab: "general" | "features" | "fields"; customFields: CustomField[] }
    | {
          route: "portal-settings";
          tab: "general" | "people" | "privacy";
          users: PortalUserRecord[] | null;
          privacy: { settings: PrivacySettings; deleted: DeletedRecord[]; retention: RetentionPreview | null } | null;
      }
    | { route: "audit"; entries: AuditEntry[]; page: number; totalPages: number; filters: { q: string; entity: string | null } }
    | { route: "forbidden"; message: string }
    | { route: "not-found"; path: string };

export type PortalPageData = PortalRoute & { context: PortalContext };

/** What the public RSVP form shows once a code is accepted. */
export interface RsvpHousehold {
    householdName: string;
    /** Present only for a signed guest-specific entry point; used to focus, never to limit or authorise. */
    highlightedGuestId?: string | null;
    deadlinePassed: boolean;
    guests: { id: string; firstName: string; lastName: string; ageGroup: AgeGroup; dietary: string | null }[];
    events: { id: string; name: string; startsAt: string | null; venueName: string | null }[];
    /** guestId → eventId → status. Only invited combinations appear. */
    responses: Record<string, Record<string, RsvpStatus>>;
    collectDietary: boolean;
    collectMessage: boolean;
    questions: RsvpQuestion[];
    answers: {
        household: Record<string, AnswerValue>;
        guests: Record<string, Record<string, AnswerValue>>;
    };
}

export interface PublicEvent {
    id: string;
    name: string;
    startsAt: string | null;
    endsAt: string | null;
    venueName: string | null;
    address: string | null;
    description: string | null;
    dressCode: string | null;
}

export interface WeddingPageData {
    route: "home" | "rsvp";
    details: WeddingDetails;
    content: WebsiteContent;
    heroImage: WebsiteMedia | null;
    /** Photos referenced by sections, keyed by media id. Only these (and the gallery) reach the page. */
    sectionImages: Record<string, WebsiteMedia>;
    gallery: WebsiteMedia[];
    events: PublicEvent[];
    rsvp: { mode: "native" | "external" | "closed"; externalUrl: string | null; deadline: string | null };
    /** Rendered inside the portal for a signed-in user: links stay inside the preview. */
    preview: boolean;
    /** Local/workers.dev compatibility only; production apex requests redirect to the canonical host. */
    legacyPaths?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Seating and catering

export interface SeatingTable {
    id: string;
    name: string;
    shape: "round" | "rectangle";
    capacity: number;
    sortOrder: number;
    notes: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface SeatingGuest {
    id: string;
    name: string;
    firstName: string;
    householdId: string | null;
    householdName: string | null;
    ageGroup: AgeGroup;
    dietary: string | null;
    allergies: string | null;
    mealCategory: string | null;
    isPlusOne: boolean;
    plusOneOf: string | null;
    groupName: string | null;
    side: Side;
    /** RSVP for the meal event. */
    status: RsvpStatus | "not_invited";
    tableId: string | null;
    position: number;
}

export interface SeatingSnapshot {
    id: string;
    name: string;
    createdAt: string;
    createdBy: string;
    seated: number;
}

export interface SeatingState {
    event: { id: string; name: string } | null;
    tables: SeatingTable[];
    guests: SeatingGuest[];
    snapshots: SeatingSnapshot[];
    categories: MealCategory[];
}

export interface CateringGuest {
    id: string;
    name: string;
    householdName: string | null;
    ageGroup: AgeGroup;
    status: RsvpStatus;
    /** The category actually counted (explicit, or the adult default). Null = needs a decision. */
    category: string | null;
    chosen: boolean;
    dietary: string | null;
    allergies: string | null;
    tableName: string | null;
}

export interface CateringSummary {
    event: { id: string; name: string } | null;
    settings: CateringSettings;
    attending: { adults: number; children: number; infants: number; total: number };
    awaiting: { adults: number; children: number; infants: number; total: number };
    /** Category id → counts among attending (and awaiting, as a range). */
    byCategory: { id: string; label: string; attending: number; awaiting: number }[];
    undecided: number;
    guests: CateringGuest[];
}

// ---------------------------------------------------------------------------------------------
// RSVP questions

export const QUESTION_TYPES = ["short_text", "long_text", "single_choice", "multiple_choice", "yes_no", "number", "date"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export interface QuestionCondition {
    /** Show this question only when the answer to that question… */
    questionId: string;
    /** …equals this (for yes/no: "yes" or "no"; for choices: one of the options). */
    equals: string;
}

export interface RsvpQuestion {
    id: string;
    label: string;
    help: string | null;
    type: QuestionType;
    options: string[];
    required: boolean;
    scope: "guest" | "household";
    audience: "all" | "adult" | "child";
    /** Ask only guests attending this event. Null = everyone the question applies to. */
    eventId: string | null;
    condition: QuestionCondition | null;
    published: boolean;
    sortOrder: number;
    version: number;
    archived: boolean;
    createdAt: string;
    updatedAt: string;
}

export type AnswerValue = string | number | boolean | string[];

export interface QuestionSummary {
    question: RsvpQuestion;
    answered: number;
    /** For choice and yes/no questions: option → count. */
    counts: { option: string; count: number }[];
    /** For number questions. */
    total: number | null;
    /** For text and date questions: the answers with who gave them. */
    responses: { who: string; value: string; version: number }[];
}
