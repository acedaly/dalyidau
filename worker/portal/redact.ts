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
