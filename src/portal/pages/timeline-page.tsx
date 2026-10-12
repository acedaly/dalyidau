import { useState } from "react";
import { Clock, Edit01, MarkerPin01, Plus, User01 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { TextArea } from "@/components/base/textarea/textarea";
import { Empty } from "@/portal/components/empty";
import { EntityPanel } from "@/portal/components/entity-panel";
import { FormGrid, FullWidth } from "@/portal/components/form";
import { PageHeader } from "@/portal/components/page-header";
import { useCollection } from "@/portal/hooks/use-collection";
import { formatDate, formatTime } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import type { TimelineItem } from "@/shared/portal/types";

type Draft = Record<"startsAt" | "endsAt" | "title" | "location" | "owner" | "notes", string>;

export const TimelinePage = ({ data }: { data: PageData<"timeline"> }) => {
    const { can, wedding } = usePortal();
    const items = useCollection<TimelineItem>("timeline", data.items);
    const [editing, setEditing] = useState<TimelineItem | null>(null);
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState<Draft>({ startsAt: "", endsAt: "", title: "", location: "", owner: "", notes: "" });
    const canEdit = can("wedding.planning.edit");

    const sorted = [...items.items].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    const days = [...new Set(sorted.map((i) => i.startsAt.slice(0, 10)))];

    const openPanel = (item: TimelineItem | null) => {
        // New items continue from the last one, or start on the wedding day.
        const last = sorted.at(-1);
        const start = item?.startsAt ?? (last ? (last.endsAt ?? last.startsAt) : wedding.date ? `${wedding.date}T15:00` : "");
        setEditing(item);
        setDraft({
            startsAt: start,
            endsAt: item?.endsAt ?? "",
            title: item?.title ?? "",
            location: item?.location ?? "",
            owner: item?.owner ?? "",
            notes: item?.notes ?? "",
        });
        setOpen(true);
    };

    return (
        <>
            <PageHeader
                title="Timeline"
                description="The run sheet for the day: who needs to be where, and when."
                breadcrumbs={[{ label: "Timeline" }]}
                actions={
                    canEdit && (
                        <Button iconLeading={Plus} onClick={() => openPanel(null)}>
                            Add to timeline
                        </Button>
                    )
                }
            />

            {sorted.length === 0 ? (
                <div className="rounded-xl py-10 ring-1 ring-secondary">
                    <Empty
                        icon={Clock}
                        title="The run sheet is empty"
                        description="Add hair and make-up, photos, the ceremony, speeches and the last dance. Suppliers and the bridal party can work from it on the day."
                        actions={
                            canEdit && (
                                <Button iconLeading={Plus} onClick={() => openPanel(null)}>
                                    Add the first item
                                </Button>
                            )
                        }
                    />
                </div>
            ) : (
                days.map((day) => (
                    <section key={day} aria-labelledby={`day-${day}`} className="flex flex-col gap-4">
                        <h2 id={`day-${day}`} className="text-lg font-semibold text-primary">
                            {formatDate(day, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
                        </h2>
                        <ol className="relative flex flex-col gap-4 border-l-2 border-secondary pl-6">
                            {sorted
                                .filter((i) => i.startsAt.startsWith(day))
                                .map((item) => (
                                    <li key={item.id} className="relative">
                                        <span
                                            aria-hidden="true"
                                            className="absolute top-5 -left-[33px] size-3.5 rounded-full border-2 border-bg-primary bg-brand-solid ring-2 ring-brand"
                                        />
                                        <div className="flex flex-col gap-3 rounded-xl bg-primary p-4 shadow-xs ring-1 ring-secondary ring-inset sm:flex-row sm:items-start sm:justify-between">
                                            <div className="flex flex-col gap-1.5">
                                                <p className="text-sm font-semibold text-brand-secondary tabular-nums">
                                                    {formatTime(item.startsAt)}
                                                    {item.endsAt && ` – ${formatTime(item.endsAt)}`}
                                                </p>
                                                <h3 className="text-md font-semibold text-primary">{item.title}</h3>
                                                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-tertiary">
                                                    {item.location && (
                                                        <span className="flex items-center gap-1.5">
                                                            <MarkerPin01 className="size-4 text-fg-quaternary" aria-hidden="true" />
                                                            {item.location}
                                                        </span>
                                                    )}
                                                    {item.owner && (
                                                        <span className="flex items-center gap-1.5">
                                                            <User01 className="size-4 text-fg-quaternary" aria-hidden="true" />
                                                            {item.owner}
                                                        </span>
                                                    )}
                                                </div>
                                                {item.notes && <p className="text-sm whitespace-pre-line text-tertiary">{item.notes}</p>}
                                            </div>
                                            <Button size="sm" color="secondary" iconLeading={Edit01} onClick={() => openPanel(item)} className="self-start">
                                                {canEdit ? "Edit" : "View"}
                                            </Button>
                                        </div>
                                    </li>
                                ))}
                        </ol>
                    </section>
                ))
            )}

            <EntityPanel
                isOpen={open}
                onOpenChange={setOpen}
                noun="timeline item"
                name={editing?.title ?? null}
                canEdit={canEdit}
                onSave={() => items.save(editing?.id ?? null, { ...draft, endsAt: draft.endsAt || null })}
                onDelete={editing ? () => items.remove(editing.id) : undefined}
            >
                {(fieldError) => (
                    <FormGrid>
                        <FullWidth>
                            <Input
                                label="What"
                                isRequired
                                placeholder="Ceremony"
                                value={draft.title}
                                onChange={(v) => setDraft({ ...draft, title: v })}
                                isInvalid={!!fieldError("title")}
                                hint={fieldError("title")}
                            />
                        </FullWidth>
                        <Input
                            label="Starts"
                            type="datetime-local"
                            isRequired
                            value={draft.startsAt}
                            onChange={(v) => setDraft({ ...draft, startsAt: v })}
                            isInvalid={!!fieldError("startsAt")}
                            hint={fieldError("startsAt")}
                        />
                        <Input
                            label="Ends"
                            type="datetime-local"
                            value={draft.endsAt}
                            onChange={(v) => setDraft({ ...draft, endsAt: v })}
                            isInvalid={!!fieldError("endsAt")}
                            hint={fieldError("endsAt")}
                        />
                        <Input label="Where" value={draft.location} onChange={(v) => setDraft({ ...draft, location: v })} />
                        <Input
                            label="Who's responsible"
                            placeholder="Celebrant, photographer…"
                            value={draft.owner}
                            onChange={(v) => setDraft({ ...draft, owner: v })}
                        />
                        <FullWidth>
                            <TextArea label="Notes" rows={4} value={draft.notes} onChange={(v) => setDraft({ ...draft, notes: v })} />
                        </FullWidth>
                    </FormGrid>
                )}
            </EntityPanel>
        </>
    );
};
