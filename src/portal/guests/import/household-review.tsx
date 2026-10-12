// One proposed household in the import preview, with its guests. Everything here edits the
// "decisions" sent back to the server, which re-plans; the card always shows the server's plan.
import { useState } from "react";
import { AlertCircle, Edit03, InfoCircle } from "@untitledui/icons";
import { BadgeWithDot } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { RadioButton, RadioGroup } from "@/components/base/radio-buttons/radio-buttons";
import { Select } from "@/components/base/select/select";
import {
    ADDRESS_FIELDS,
    type ImportFieldChange,
    type ImportGuestPlan,
    type ImportHouseholdPlan,
    type ImportIssue,
    type PostalAddress,
    formatAddress,
    parseAddress,
} from "@/shared/portal/guest-import";
import { cx } from "@/utils/cx";

export type GuestDecision = { firstName?: string; lastName?: string; target?: string; confirm?: string[] };
export type HouseholdDecision = { name?: string; address?: PostalAddress | null; target?: string; confirm?: string[] };

export interface Directory {
    households: { id: string; name: string; externalId: string | null }[];
    guests: { id: string; name: string; householdName: string | null }[];
}

const ACTION_BADGES: Record<string, { label: string; color: "success" | "brand" | "gray" | "warning" | "blue" }> = {
    create: { label: "New", color: "success" },
    update: { label: "Update", color: "brand" },
    link: { label: "Link to household", color: "blue" },
    unchanged: { label: "Up to date", color: "gray" },
    skip: { label: "Skipped", color: "warning" },
};

export const ActionBadge = ({ action }: { action: string }) => {
    const badge = ACTION_BADGES[action] ?? { label: action, color: "gray" as const };
    return (
        <BadgeWithDot size="sm" type="pill-color" color={badge.color}>
            {badge.label}
        </BadgeWithDot>
    );
};

const ISSUE_ICONS = { error: AlertCircle, warning: AlertCircle, info: InfoCircle };
const ISSUE_COLOURS = { error: "text-error-primary", warning: "text-warning-primary", info: "text-tertiary" };

export const Issues = ({ issues }: { issues: ImportIssue[] }) =>
    issues.length ? (
        <ul className="flex flex-col gap-1.5">
            {issues.map((issue) => {
                const Icon = ISSUE_ICONS[issue.level];
                return (
                    <li key={issue.message} className={cx("flex items-start gap-2 text-sm", ISSUE_COLOURS[issue.level])}>
                        <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                        <span>{issue.message}</span>
                    </li>
                );
            })}
        </ul>
    ) : null;

/** What will change, with a "Replace" checkbox for anything that overwrites recorded data. */
const Changes = ({
    changes,
    onConfirm,
    idPrefix,
}: {
    changes: ImportFieldChange[];
    onConfirm: (field: string, confirmed: boolean) => void;
    idPrefix: string;
}) => {
    const shown = changes.filter((c) => c.from !== null || c.needsConfirmation);
    if (!shown.length) return null;
    return (
        <ul className="flex flex-col gap-2 rounded-lg bg-secondary p-3 text-sm" aria-label="Changes to existing records">
            {shown.map((change) => (
                <li key={`${idPrefix}-${change.field}`} className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                    <span className="min-w-0 text-secondary">
                        <span className="font-semibold">{change.label}:</span> <span className="text-tertiary">{change.from ?? "—"}</span>
                        {" → "}
                        <span className={cx(change.applied ? "text-primary" : "text-quaternary line-through")}>{change.to ?? "(clear)"}</span>
                    </span>
                    {change.needsConfirmation && (
                        <Checkbox
                            size="sm"
                            label="Replace"
                            hint={change.applied ? undefined : "Kept unless you tick this"}
                            isSelected={change.applied}
                            onChange={(selected) => onConfirm(change.field, selected)}
                            className="shrink-0"
                        />
                    )}
                </li>
            ))}
        </ul>
    );
};

const toggle = (list: string[] | undefined, field: string, on: boolean) => {
    const set = new Set(list ?? []);
    if (on) set.add(field);
    else set.delete(field);
    return [...set];
};

const GuestRow = ({
    guest,
    decision,
    directory,
    onChange,
}: {
    guest: ImportGuestPlan;
    decision: GuestDecision | undefined;
    directory: Directory;
    onChange: (patch: GuestDecision) => void;
}) => {
    const matched = guest.target.kind === "existing" ? guest.target : null;
    const options = [
        { id: "new", label: "Add as a new guest" },
        ...(matched && matched.matchedBy !== "chosen"
            ? [{ id: matched.id, label: `Same person as ${matched.name}${matched.householdName ? ` (${matched.householdName})` : ""}` }]
            : []),
        ...guest.suggestions
            .filter((s) => s.id !== matched?.id)
            .map((s) => ({ id: s.id, label: `${s.name}${s.detail ? ` (${s.detail})` : ""}: ${s.reason.toLowerCase()}` })),
        ...(matched?.matchedBy === "chosen" ? [{ id: matched.id, label: `Same person as ${matched.name}` }] : []),
        ...directory.guests
            .filter((g) => g.id !== matched?.id && !guest.suggestions.some((s) => s.id === g.id))
            .map((g) => ({ id: g.id, label: `${g.name}${g.householdName ? ` (${g.householdName})` : ""}` })),
        { id: "skip", label: "Don't import this guest" },
    ];
    const selected = decision?.target ?? (guest.target.kind === "existing" ? guest.target.id : guest.target.kind === "skip" ? "skip" : "new");

    return (
        <li className="flex flex-col gap-3 py-4" data-testid={`import-guest-${guest.line}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold text-primary">
                    {`${guest.firstName} ${guest.lastName}`.trim()}
                    <span className="ml-2 font-normal text-quaternary">line {guest.line}</span>
                </p>
                <div className="flex flex-wrap items-center gap-1.5">
                    <BadgeWithDot size="sm" type="modern" color={guest.rsvp === "attending" ? "success" : guest.rsvp === "declined" ? "error" : "gray"}>
                        {guest.rsvp === "attending" ? "Said yes" : guest.rsvp === "declined" ? "Said no" : "No RSVP yet"}
                    </BadgeWithDot>
                    <ActionBadge action={guest.action} />
                </div>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Input
                    size="sm"
                    label="First name"
                    value={decision?.firstName ?? guest.firstName}
                    isDisabled={guest.action === "skip"}
                    onChange={(v) => onChange({ firstName: v })}
                />
                <Input
                    size="sm"
                    label="Last name"
                    value={decision?.lastName ?? guest.lastName}
                    isDisabled={guest.action === "skip"}
                    onChange={(v) => onChange({ lastName: v })}
                />
            </div>
            {(guest.nameReview.length > 0 || guest.suggestedName) && (
                <div className="flex flex-col gap-2 rounded-lg bg-warning-primary p-3 text-sm text-warning-primary sm:flex-row sm:items-center sm:justify-between">
                    <span className="flex items-start gap-2">
                        <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                        <span>
                            {guest.nameReview.join(" ") || "Check the capitalisation."} From the file: “{guest.rawName}”.
                        </span>
                    </span>
                    {guest.suggestedName && (
                        <Button size="sm" color="secondary" onClick={() => onChange({ ...guest.suggestedName! })} className="shrink-0">
                            Use “{`${guest.suggestedName.firstName} ${guest.suggestedName.lastName}`.trim()}”
                        </Button>
                    )}
                </div>
            )}
            <Select
                size="sm"
                label="Match"
                items={options}
                value={selected}
                onChange={(value) => onChange({ target: String(value) })}
                hint={
                    guest.target.kind === "existing"
                        ? `Updates ${guest.target.name} instead of adding someone new${guest.target.matchedBy === "email" ? " (same email)" : ""}.`
                        : guest.target.kind === "skip"
                          ? guest.target.reason
                          : undefined
                }
            >
                {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
            </Select>
            <Issues issues={guest.issues} />
            <Changes idPrefix={guest.key} changes={guest.changes} onConfirm={(field, on) => onChange({ confirm: toggle(decision?.confirm, field, on) })} />
        </li>
    );
};

const AddressEditor = ({ address, onSave, onCancel }: { address: PostalAddress | null; onSave: (a: PostalAddress | null) => void; onCancel: () => void }) => {
    const [draft, setDraft] = useState<PostalAddress>(
        address ?? { addressLine1: null, addressLine2: null, locality: null, region: null, postcode: null, country: null },
    );
    const labels: Record<(typeof ADDRESS_FIELDS)[number], string> = {
        addressLine1: "Address",
        addressLine2: "Address line 2",
        locality: "Suburb or town",
        region: "State",
        postcode: "Postcode",
        country: "Country",
    };
    return (
        <div className="flex flex-col gap-3 rounded-lg p-3 ring-1 ring-secondary ring-inset">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {ADDRESS_FIELDS.map((field) => (
                    <Input
                        key={field}
                        size="sm"
                        label={labels[field]}
                        value={draft[field] ?? ""}
                        onChange={(v) => setDraft({ ...draft, [field]: v || null })}
                        className={field === "addressLine1" || field === "addressLine2" ? "sm:col-span-2" : undefined}
                    />
                ))}
            </div>
            <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => onSave(draft)}>
                    Use this address
                </Button>
                <Button size="sm" color="secondary" onClick={() => onSave(null)}>
                    No address
                </Button>
                <Button size="sm" color="tertiary" onClick={onCancel}>
                    Cancel
                </Button>
            </div>
        </div>
    );
};

export const HouseholdReview = ({
    household,
    guests,
    decision,
    guestDecisions,
    directory,
    onHousehold,
    onGuest,
}: {
    household: ImportHouseholdPlan;
    guests: ImportGuestPlan[];
    decision: HouseholdDecision | undefined;
    guestDecisions: Record<string, GuestDecision>;
    directory: Directory;
    onHousehold: (patch: HouseholdDecision) => void;
    onGuest: (key: string, patch: GuestDecision) => void;
}) => {
    const [editingAddress, setEditingAddress] = useState(false);
    // Which of the conflicting addresses is chosen; null once a custom address is typed.
    const [chosenChoice, setChosenChoice] = useState<string | null>(household.addressChoices[0]?.text ?? null);
    const matched = household.target.kind === "existing" ? household.target : null;
    const options = [
        { id: "new", label: "Create a new household" },
        ...(matched ? [{ id: matched.id, label: `Existing: ${matched.name}` }] : []),
        ...household.suggestions.filter((s) => s.id !== matched?.id).map((s) => ({ id: s.id, label: `${s.name}: ${s.reason.toLowerCase()}` })),
        ...directory.households
            // A household already standing for another Say I Do party can't take this one too.
            .filter((h) => !household.externalId || !h.externalId || h.externalId === household.externalId)
            .filter((h) => h.id !== matched?.id && !household.suggestions.some((s) => s.id === h.id))
            .map((h) => ({ id: h.id, label: h.name })),
        { id: "skip", label: "Skip this party" },
    ];
    const selected = decision?.target ?? (matched ? matched.id : household.target.kind === "skip" ? "skip" : "new");
    const chosenAddress = household.address ? formatAddress(household.address) : null;
    const headingId = `household-${household.key.replace(/[^a-z0-9]/gi, "-")}`;

    return (
        <section
            aria-labelledby={headingId}
            className="flex flex-col gap-4 rounded-xl bg-primary p-4 shadow-xs ring-1 ring-secondary ring-inset md:p-5"
            data-testid="import-household"
        >
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <h3 id={headingId} className="text-md font-semibold text-primary">
                        {household.name}
                    </h3>
                    <p className="text-sm text-tertiary">
                        {guests.length === 1 ? "1 guest" : `${guests.length} guests`}
                        {household.externalId && ` · Say I Do party ${household.externalId}`}
                        {matched &&
                            ` · matches “${matched.name}”${matched.matchedBy === "link" ? " by its Say I Do link" : matched.matchedBy === "guests" ? " by its guests" : matched.matchedBy === "name" ? " by name" : ""}`}
                    </p>
                </div>
                <ActionBadge action={household.action} />
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Input
                    size="sm"
                    label="Household name"
                    hint="Shown on the RSVP as “Replying for …”."
                    value={decision?.name ?? household.name}
                    isDisabled={household.action === "skip"}
                    onChange={(v) => onHousehold({ name: v })}
                />
                <Select size="sm" label="Household" items={options} value={selected} onChange={(value) => onHousehold({ target: String(value) })}>
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
            </div>
            {household.suggestedName && household.suggestedName !== (decision?.name ?? household.name) && (
                <div className="flex flex-col gap-2 text-sm text-tertiary sm:flex-row sm:items-center sm:justify-between">
                    <span>Some names in this party aren't capitalised.</span>
                    <Button size="sm" color="secondary" onClick={() => onHousehold({ name: household.suggestedName! })}>
                        Use “{household.suggestedName}”
                    </Button>
                </div>
            )}

            {household.action !== "skip" && (
                <div className="flex flex-col gap-2">
                    <p className="text-sm font-medium text-secondary">Postal address</p>
                    {household.addressConflict && !editingAddress && (
                        <RadioGroup
                            aria-label={`Address for ${household.name}`}
                            value={chosenChoice}
                            onChange={(text) => {
                                setChosenChoice(text);
                                onHousehold({ address: parseAddress(text) });
                            }}
                        >
                            {household.addressChoices.map((choice) => (
                                <RadioButton key={choice.text} value={choice.text} label={choice.text} hint={`Given by ${choice.guests.join(", ")}`} />
                            ))}
                        </RadioGroup>
                    )}
                    {(!household.addressConflict || chosenChoice === null) && !editingAddress && (
                        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-tertiary">
                            {chosenAddress ? (
                                <span className="text-secondary">{chosenAddress}</span>
                            ) : (
                                <span>No address in the file{household.addressChoices.length === 0 ? "" : " (cleared)"}.</span>
                            )}
                            {household.addressChoices.length > 0 && household.addressChoices[0].text !== chosenAddress && (
                                <span className="text-quaternary">From the file: “{household.addressChoices.map((c) => c.text).join("” / “")}”</span>
                            )}
                        </p>
                    )}
                    {editingAddress ? (
                        <AddressEditor
                            address={household.address}
                            onCancel={() => setEditingAddress(false)}
                            onSave={(address) => {
                                onHousehold({ address });
                                setChosenChoice(null);
                                setEditingAddress(false);
                            }}
                        />
                    ) : (
                        <div>
                            <Button size="sm" color="link-gray" iconLeading={Edit03} onClick={() => setEditingAddress(true)}>
                                Edit address
                            </Button>
                        </div>
                    )}
                </div>
            )}

            <Issues issues={household.issues} />
            <Changes
                idPrefix={household.key}
                changes={household.changes}
                onConfirm={(field, on) => onHousehold({ confirm: toggle(decision?.confirm, field, on) })}
            />

            <ul className="flex flex-col divide-y divide-secondary border-t border-secondary" aria-label={`Guests in ${household.name}`}>
                {guests.map((guest) => (
                    <GuestRow
                        key={guest.key}
                        guest={guest}
                        decision={guestDecisions[guest.key]}
                        directory={directory}
                        onChange={(patch) => onGuest(guest.key, patch)}
                    />
                ))}
            </ul>
        </section>
    );
};

/** Guests without a party: listed together, each still editable. */
export const LooseGuests = ({
    guests,
    guestDecisions,
    directory,
    onGuest,
}: {
    guests: ImportGuestPlan[];
    guestDecisions: Record<string, GuestDecision>;
    directory: Directory;
    onGuest: (key: string, patch: GuestDecision) => void;
}) => (
    <section aria-labelledby="loose-guests" className="flex flex-col gap-2 rounded-xl bg-primary p-4 shadow-xs ring-1 ring-secondary ring-inset md:p-5">
        <h3 id="loose-guests" className="text-md font-semibold text-primary">
            Not in a household
        </h3>
        <p className="text-sm text-tertiary">These rows have no party or household. Add them to households later from the guest list.</p>
        <ul className="flex flex-col divide-y divide-secondary">
            {guests.map((guest) => (
                <GuestRow
                    key={guest.key}
                    guest={guest}
                    decision={guestDecisions[guest.key]}
                    directory={directory}
                    onChange={(patch) => onGuest(guest.key, patch)}
                />
            ))}
        </ul>
    </section>
);

export const needsAttention = (household: ImportHouseholdPlan, guests: ImportGuestPlan[]) =>
    household.action !== "skip" &&
    (household.addressConflict ||
        household.issues.some((i) => i.level !== "info") ||
        household.changes.some((c) => c.needsConfirmation) ||
        !!household.suggestedName ||
        guests.some(
            (g) =>
                g.action !== "skip" &&
                (g.nameReview.length > 0 ||
                    g.issues.some((i) => i.level !== "info") ||
                    g.changes.some((c) => c.needsConfirmation) ||
                    (g.target.kind === "new" && g.suggestions.length > 0)),
        ));
