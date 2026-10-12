// Data shapes shared by the worker and the portal/wedding browser bundles.
import type { Flags } from "./flags";
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

export interface WebsiteSection {
    id: string;
    title: string;
    body: string;
}

export interface WebsiteContent {
    heroEyebrow: string;
    heroTitle: string;
    heroSubtitle: string;
    welcome: string;
    sections: WebsiteSection[];
    contactEmail: string;
    /** Keep search engines away. On by default. */
    noindex: boolean;
}

export interface RsvpSettings {
    /** Link to the RSVP form currently in use (Say I Do). */
    externalUrl: string;
    /** YYYY-MM-DD. After this date the native form is read-only. Empty means no deadline. */
    deadline: string;
    collectDietary: boolean;
    collectMessage: boolean;
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
    wedding: WeddingDetails;
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
    dietary: string | null;
    accessibility: string | null;
    notes: string | null;
    tags: string[];
    custom: Record<string, string | number | boolean | null>;
    events: GuestEventStatus[];
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
    createdAt: string;
    updatedAt: string;
}

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
    guests: { guestId: string; name: string; events: Record<string, "attending" | "declined">; dietary?: string | null }[];
    email?: string | null;
}

export interface MessageTemplate {
    id: string;
    name: string;
    subject: string;
    body: string;
    createdAt: string;
    updatedAt: string;
}

export type MessageStatus = "draft" | "queued" | "sending" | "sent" | "partial" | "failed";

export interface Audience {
    rsvp?: (RsvpStatus | "not_invited")[];
    eventId?: string | null;
    side?: Side[];
    groupName?: string | null;
    tag?: string | null;
    /** When set, only these guests (still filtered to guests with an email address). */
    guestIds?: string[];
}

export interface Message {
    id: string;
    templateId: string | null;
    subject: string;
    body: string;
    audience: Audience;
    status: MessageStatus;
    recipientCount: number;
    deliveryNote: string | null;
    createdBy: string;
    createdAt: string;
    sentAt: string | null;
}

export interface MessageRecipient {
    guestId: string;
    name: string;
    email: string | null;
    status: "pending" | "sent" | "failed" | "skipped";
    error: string | null;
    sentAt: string | null;
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
    | { route: "dashboard"; stats: DashboardStats; widgets: DashboardWidget[] }
    | { route: "guests"; guests: Guest[]; households: Pick<Household, "id" | "name">[]; events: WeddingEvent[]; customFields: CustomField[] }
    | { route: "households"; households: Household[] }
    | { route: "events"; events: WeddingEvent[] }
    | {
          route: "rsvps";
          events: WeddingEvent[];
          stats: DashboardStats;
          submissions: RsvpSubmission[];
          settings: RsvpSettings;
          households: (Pick<Household, "id" | "name" | "rsvpCode"> & { guests: number; responded: number })[];
      }
    | {
          route: "communications";
          templates: MessageTemplate[];
          messages: Message[];
          events: WeddingEvent[];
          groups: string[];
          tags: string[];
          deliveryAvailable: boolean;
      }
    | { route: "message"; message: Message; recipients: MessageRecipient[]; deliveryAvailable: boolean }
    | { route: "tasks"; tasks: Task[]; assignees: { email: string; name: string | null }[] }
    | { route: "timeline"; items: TimelineItem[] }
    | { route: "budget"; items: BudgetItem[]; suppliers: Pick<Supplier, "id" | "name">[]; settings: BudgetSettings }
    | { route: "suppliers"; suppliers: Supplier[] }
    | { route: "website"; content: WebsiteContent; events: WeddingEvent[]; rsvp: RsvpSettings }
    | {
          route: "settings";
          tab: "general" | "features" | "fields" | "people" | "privacy";
          customFields: CustomField[];
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
    deadlinePassed: boolean;
    guests: { id: string; firstName: string; lastName: string; ageGroup: AgeGroup; dietary: string | null }[];
    events: { id: string; name: string; startsAt: string | null; venueName: string | null }[];
    /** guestId → eventId → status. Only invited combinations appear. */
    responses: Record<string, Record<string, RsvpStatus>>;
    collectDietary: boolean;
    collectMessage: boolean;
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
    events: PublicEvent[];
    rsvp: { mode: "native" | "external" | "closed"; externalUrl: string | null; deadline: string | null };
    /** Rendered inside the portal for a signed-in user: links stay inside the preview. */
    preview: boolean;
}
