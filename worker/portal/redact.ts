// What the audit log keeps about personal data. It records that a sensitive field changed and who
// changed it, but not the old or new value: the current value lives in the record itself, and
// keeping every past dietary note or phone number adds risk without adding accountability.

export const REDACTED = "[redacted]";

/** Fields whose values are never copied into the audit log. */
export const SENSITIVE_FIELDS = new Set([
    "email",
    "phone",
    "dietary",
    "accessibility",
    "notes",
    "custom",
    "addressLine1",
    "addressLine2",
    "locality",
    "region",
    "postcode",
    "country",
    "contactName",
]);

export const redactChanges = (changes: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, SENSITIVE_FIELDS.has(key) ? [REDACTED, REDACTED] : value]));

/** A record snapshot with sensitive values removed, for delete entries. */
export const redactSnapshot = (record: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(record).map(([key, value]) => [key, SENSITIVE_FIELDS.has(key) && value !== null && value !== "" ? REDACTED : value]));

/**
 * RSVP codes and signed invitation links are credentials: whoever holds one can change that
 * household's RSVP on the public form. Only roles that may edit RSVPs see them; for everyone else
 * (viewers) they're removed from every portal API response and page, wherever they appear.
 */
export const CREDENTIAL_PERMISSION = "wedding.rsvp.edit" as const;

const SIGNED_LINK = /([?&]invite=)[A-Za-z0-9._~%-]+/g;
const CREDENTIAL_KEYS = new Set(["rsvpCode", "qrDataUrl"]);

export function hideCredentials<T>(value: T): T {
    if (typeof value === "string") return value.replace(SIGNED_LINK, "$1[hidden]") as T;
    if (Array.isArray(value)) return value.map(hideCredentials) as T;
    if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, CREDENTIAL_KEYS.has(key) && item ? null : hideCredentials(item)])) as T;
    return value;
}
