import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { Label } from "@/components/base/input/label";
import { Select } from "@/components/base/select/select";
import { TextArea } from "@/components/base/textarea/textarea";
import { Toggle } from "@/components/base/toggle/toggle";
import { DateField } from "@/portal/components/date-field";
import { FormGrid, FullWidth } from "@/portal/components/form";
import { MobileInput } from "@/portal/components/mobile-input";
import { usePortal } from "@/portal/portal-context";
import type { AgeGroup, ContactPreference, CustomField, Guest, Household, MealCategory, Side, WeddingEvent } from "@/shared/portal/types";

export interface GuestDraft {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    householdId: string | null;
    side: Side;
    groupName: string;
    ageGroup: AgeGroup;
    isPlusOne: boolean;
    plusOneOf: string | null;
    dietary: string;
    allergies: string;
    mealCategory: string | null;
    contactPreference: ContactPreference;
    accessibility: string;
    notes: string;
    tags: string;
    custom: Guest["custom"];
    events: string[];
}

export const draftFromGuest = (guest: Guest | null, defaults: Partial<GuestDraft> = {}): GuestDraft => ({
    firstName: guest?.firstName ?? "",
    lastName: guest?.lastName ?? "",
    email: guest?.email ?? "",
    phone: guest?.phone ?? "",
    householdId: guest?.householdId ?? null,
    side: guest?.side ?? "shared",
    groupName: guest?.groupName ?? "",
    ageGroup: guest?.ageGroup ?? "adult",
    isPlusOne: guest?.isPlusOne ?? false,
    plusOneOf: guest?.plusOneOf ?? null,
    dietary: guest?.dietary ?? "",
    allergies: guest?.allergies ?? "",
    mealCategory: guest?.mealCategory ?? null,
    contactPreference: guest?.contactPreference ?? "email",
    accessibility: guest?.accessibility ?? "",
    notes: guest?.notes ?? "",
    tags: guest?.tags.join(", ") ?? "",
    custom: guest?.custom ?? {},
    events: guest?.events.map((e) => e.eventId) ?? [],
    ...defaults,
});

export const draftToPayload = (draft: GuestDraft) => ({
    ...draft,
    tags: draft.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
});

interface GuestFormProps {
    draft: GuestDraft;
    onChange: (draft: GuestDraft) => void;
    households: Pick<Household, "id" | "name">[];
    events: WeddingEvent[];
    customFields: CustomField[];
    mealCategories: MealCategory[];
    /** Other guests, for choosing whose plus-one this is. */
    guests: Pick<Guest, "id" | "firstName" | "lastName" | "householdId">[];
    selfId: string | null;
    fieldError: (field: string) => string | undefined;
    readOnly?: boolean;
    /** The guest's stored mobile, so an untouched legacy value can be flagged. */
    savedPhone?: string | null;
}

export const GuestForm = ({
    draft,
    onChange,
    households,
    events,
    customFields,
    mealCategories,
    guests,
    selfId,
    fieldError,
    readOnly,
    savedPhone,
}: GuestFormProps) => {
    const { sideLabel } = usePortal();
    const set = <K extends keyof GuestDraft>(key: K, value: GuestDraft[K]) => onChange({ ...draft, [key]: value });
    const setCustom = (key: string, value: string | number | boolean | null) => onChange({ ...draft, custom: { ...draft.custom, [key]: value } });

    return (
        <fieldset disabled={readOnly} className="flex flex-col gap-6">
            <FormGrid>
                <Input
                    label="First name"
                    isRequired
                    value={draft.firstName}
                    onChange={(v) => set("firstName", v)}
                    isInvalid={!!fieldError("firstName")}
                    hint={fieldError("firstName")}
                    autoFocus
                />
                <Input
                    label="Last name"
                    value={draft.lastName}
                    onChange={(v) => set("lastName", v)}
                    isInvalid={!!fieldError("lastName")}
                    hint={fieldError("lastName")}
                />
                <Input
                    label="Email"
                    type="email"
                    value={draft.email}
                    onChange={(v) => set("email", v)}
                    isInvalid={!!fieldError("email")}
                    hint={fieldError("email")}
                />
                <MobileInput value={draft.phone} onChange={(v) => set("phone", v)} savedValue={savedPhone} error={fieldError("phone")} />
                <Select
                    label="Household"
                    items={[{ id: "none", label: "No household" }, ...households.map((h) => ({ id: h.id, label: h.name }))]}
                    value={draft.householdId ?? "none"}
                    onChange={(value) => set("householdId", value === "none" ? null : String(value))}
                    hint={fieldError("householdId") ?? "RSVP codes belong to households."}
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
                <Select
                    label="Side"
                    items={(["partner_one", "partner_two", "shared"] as Side[]).map((side) => ({ id: side, label: sideLabel(side) }))}
                    value={draft.side}
                    onChange={(value) => set("side", value as Side)}
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
                <Input label="Group" placeholder="Family, friends, work…" value={draft.groupName} onChange={(v) => set("groupName", v)} />
                <Select
                    label="Age group"
                    items={[
                        { id: "adult", label: "Adult" },
                        { id: "child", label: "Child" },
                        { id: "infant", label: "Infant" },
                    ]}
                    value={draft.ageGroup}
                    onChange={(value) => set("ageGroup", value as AgeGroup)}
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
                <FullWidth>
                    <Checkbox label="Plus one" hint="This guest is someone's plus one." isSelected={draft.isPlusOne} onChange={(v) => set("isPlusOne", v)} />
                </FullWidth>
                {draft.isPlusOne && (
                    <FullWidth>
                        <Select
                            label="Plus one of"
                            items={[
                                { id: "none", label: "Not specified" },
                                ...guests
                                    .filter((g) => g.id !== selfId)
                                    .sort((a, b) => Number(b.householdId === draft.householdId) - Number(a.householdId === draft.householdId))
                                    .map((g) => ({ id: g.id, label: `${g.firstName} ${g.lastName}`.trim() })),
                            ]}
                            value={draft.plusOneOf ?? "none"}
                            onChange={(v) => set("plusOneOf", v === "none" ? null : String(v))}
                            hint={fieldError("plusOneOf") ?? "The seating planner warns if they're at different tables."}
                        >
                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                        </Select>
                    </FullWidth>
                )}
                <Select
                    label="Meal"
                    items={[
                        { id: "none", label: draft.ageGroup === "adult" ? "Default" : "Not decided" },
                        ...mealCategories
                            .filter((c) => c.appliesTo === "any" || c.appliesTo === (draft.ageGroup === "adult" ? "adult" : "child"))
                            .map((c) => ({ id: c.id, label: c.label })),
                    ]}
                    value={draft.mealCategory ?? "none"}
                    onChange={(v) => set("mealCategory", v === "none" ? null : String(v))}
                    hint={fieldError("mealCategory") ?? (draft.ageGroup === "adult" ? undefined : "Children are only counted once a meal is chosen.")}
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
                <Select
                    label="Contact by"
                    items={[
                        { id: "email", label: "Email" },
                        { id: "post", label: "Post" },
                        { id: "phone", label: "Phone" },
                        { id: "none", label: "Don't contact" },
                    ]}
                    value={draft.contactPreference}
                    onChange={(v) => set("contactPreference", v as ContactPreference)}
                    hint="Guests marked “Post”, “Phone” or “Don't contact” are left out of emails."
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
            </FormGrid>

            {events.length > 0 && (
                <div className="flex flex-col gap-3">
                    <Label>Invited to</Label>
                    <div className="flex flex-col gap-3">
                        {events.map((event) => (
                            <Checkbox
                                key={event.id}
                                label={event.name}
                                isSelected={draft.events.includes(event.id)}
                                onChange={(on) => set("events", on ? [...draft.events, event.id] : draft.events.filter((id) => id !== event.id))}
                            />
                        ))}
                    </div>
                </div>
            )}

            <FormGrid>
                <FullWidth>
                    <Input label="Dietary requirements" placeholder="Vegetarian, coeliac…" value={draft.dietary} onChange={(v) => set("dietary", v)} />
                </FullWidth>
                <FullWidth>
                    <Input
                        label="Allergies"
                        placeholder="Nuts, shellfish…"
                        value={draft.allergies}
                        onChange={(v) => set("allergies", v)}
                        hint="Highlighted for the caterer and on the seating plan."
                    />
                </FullWidth>
                <FullWidth>
                    <Input label="Accessibility needs" value={draft.accessibility} onChange={(v) => set("accessibility", v)} />
                </FullWidth>
                <FullWidth>
                    <Input
                        label="Tags"
                        placeholder="Comma separated"
                        value={draft.tags}
                        onChange={(v) => set("tags", v)}
                        hint={fieldError("tags") ?? "For example: bridal party, interstate"}
                    />
                </FullWidth>
                <FullWidth>
                    <TextArea label="Notes" rows={3} value={draft.notes} onChange={(v) => set("notes", v)} />
                </FullWidth>
            </FormGrid>

            {customFields.filter((f) => !f.archived).length > 0 && (
                <FormGrid>
                    {customFields
                        .filter((f) => !f.archived)
                        .map((field) => {
                            const value = draft.custom[field.key] ?? null;
                            const error = fieldError(`custom.${field.key}`) ?? fieldError("custom");
                            switch (field.type) {
                                case "boolean":
                                    return (
                                        <FullWidth key={field.key}>
                                            <Toggle
                                                label={field.label}
                                                hint={error ?? field.help ?? undefined}
                                                isSelected={value === true}
                                                onChange={(on) => setCustom(field.key, on)}
                                            />
                                        </FullWidth>
                                    );
                                case "select":
                                    return (
                                        <Select
                                            key={field.key}
                                            label={field.label}
                                            hint={error ?? field.help ?? undefined}
                                            items={[{ id: "__none", label: "Not set" }, ...field.options.map((o) => ({ id: o, label: o }))]}
                                            value={typeof value === "string" ? value : "__none"}
                                            onChange={(v) => setCustom(field.key, v === "__none" ? null : String(v))}
                                        >
                                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                                        </Select>
                                    );
                                case "date":
                                    return (
                                        <DateField
                                            key={field.key}
                                            label={field.label}
                                            hint={field.help ?? undefined}
                                            error={error}
                                            value={typeof value === "string" ? value : null}
                                            onChange={(v) => setCustom(field.key, v)}
                                        />
                                    );
                                default:
                                    return (
                                        <Input
                                            key={field.key}
                                            label={field.label}
                                            type={field.type === "number" ? "number" : "text"}
                                            hint={error ?? field.help ?? undefined}
                                            isInvalid={!!error}
                                            value={value === null || value === undefined ? "" : String(value)}
                                            onChange={(v) => setCustom(field.key, field.type === "number" ? (v === "" ? null : Number(v)) : v)}
                                        />
                                    );
                            }
                        })}
                </FormGrid>
            )}
        </fieldset>
    );
};
