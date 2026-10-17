// Daily notes: one page per day in the space's time zone. Today opens ready to type; the note is
// only created when something is written, and from then on it saves, versions and links like any
// other object. Previous/next, a calendar marking days with notes, and recent notes alongside.
import { Suspense, lazy, useMemo } from "react";
import { parseDate } from "@internationalized/date";
import { ArrowLeft, ArrowRight, CalendarDate, ChevronLeft, ChevronRight, File04 } from "@untitledui/icons";
import { Calendar } from "@/components/application/date-picker/calendar";
import { BadgeWithDot } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Skeleton } from "@/portal/components/empty";
import { Notice } from "@/portal/components/notice";
import type { PageData } from "@/portal/lib/page-types";
import { EMPTY_DOCUMENT, type DocNode } from "@/shared/knowledge/content";
import { addDays, formatDailyTitle } from "@/shared/knowledge/dates";
import { roleAtLeast } from "@/shared/knowledge/types";
import { KnowledgeHeader } from "../knowledge-header";
import { TypeIconFor, dailyHref, knowledgeApi, objectHref, titleOf } from "../shared";
import { type SaveState, useObjectSaver } from "../use-object-saver";

const KnowledgeEditor = lazy(() => import("../editor/knowledge-editor"));

const SAVE_LABELS: Record<SaveState, { label: string; color: "success" | "gray" | "warning" | "error" }> = {
    saved: { label: "Saved", color: "success" },
    pending: { label: "Unsaved changes", color: "gray" },
    saving: { label: "Saving…", color: "gray" },
    error: { label: "Not saved", color: "error" },
    conflict: { label: "Not saved: newer version", color: "warning" },
};

const relative = (date: string, today: string) => {
    if (date === today) return "Today";
    if (date === addDays(today, -1)) return "Yesterday";
    if (date === addDays(today, 1)) return "Tomorrow";
    const days = Math.round((Date.parse(date) - Date.parse(today)) / 86_400_000);
    return days < 0 ? `${-days} days ago` : `In ${days} days`;
};

export const KnowledgeDailyPage = ({ data }: { data: PageData<"knowledge-daily"> }) => {
    const { space, spaces, types, date, today, recent, marked } = data;
    const canEdit = roleAtLeast(space.role, "editor");
    const ensure = useMemo(() => () => knowledgeApi.ensureDaily(space.id, date), [space.id, date]);
    const saver = useObjectSaver(data.note, ensure);
    const note = saver.detail;
    const trashed = note?.object.status === "trashed";
    const editable = canEdit && !trashed;
    const save = SAVE_LABELS[saver.state];
    const go = (next: string) => window.location.assign(dailyHref(space, next === today ? undefined : next));
    const highlighted = useMemo(() => marked.map((d) => parseDate(d)), [marked]);

    return (
        <>
            <KnowledgeHeader
                title={formatDailyTitle(date)}
                description={
                    <span className="flex items-center gap-2">
                        <CalendarDate aria-hidden="true" className="size-4 text-fg-quaternary" />
                        {relative(date, today)}
                        {date === today && <span className="sr-only">(this is today's note)</span>}
                    </span>
                }
                space={space}
                spaces={spaces}
                types={types}
                templates={data.templates}
                crumb="Daily notes"
            />

            <nav aria-label="Days" className="-mt-4 flex flex-wrap items-center gap-2">
                <Button size="sm" color="secondary" iconLeading={ArrowLeft} href={dailyHref(space, addDays(date, -1))}>
                    Previous day
                </Button>
                <Button size="sm" color={date === today ? "primary" : "secondary"} href={dailyHref(space)} aria-current={date === today ? "date" : undefined}>
                    Today
                </Button>
                <Button size="sm" color="secondary" iconTrailing={ArrowRight} href={dailyHref(space, addDays(date, 1))}>
                    Next day
                </Button>
                {note && editable && (
                    <span aria-live="polite" className="ml-auto">
                        <BadgeWithDot size="sm" color={save.color}>
                            {save.label}
                        </BadgeWithDot>
                    </span>
                )}
            </nav>

            <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
                <div className="flex min-w-0 flex-col gap-4">
                    {trashed && (
                        <Notice
                            title="This day's note is in the trash"
                            color="warning"
                            actions={
                                <Button size="sm" color="secondary" href={objectHref(note!.object.id)}>
                                    Open it to restore
                                </Button>
                            }
                        />
                    )}
                    {saver.state === "conflict" && (
                        <Notice
                            title="Someone else saved a newer version"
                            color="warning"
                            actions={
                                <>
                                    <Button size="sm" onClick={() => void saver.keepMine()}>
                                        Keep my changes
                                    </Button>
                                    <Button size="sm" color="secondary" onClick={() => window.location.reload()}>
                                        Discard mine and load theirs
                                    </Button>
                                </>
                            }
                        >
                            This note changed while you were writing (another tab, or a quick capture). Keeping yours saves it on top; theirs stays in the history.
                        </Notice>
                    )}
                    {saver.state === "error" && (
                        <Notice
                            title="Your changes haven't been saved"
                            color="error"
                            actions={
                                <Button size="sm" color="secondary" onClick={() => void saver.flush()}>
                                    Try again
                                </Button>
                            }
                        >
                            {saver.error}
                        </Notice>
                    )}
                    {!note && !canEdit && <p className="text-sm text-tertiary">Nobody has written anything for this day.</p>}
                    {(note || canEdit) && (
                        <Suspense fallback={<Skeleton className="h-64 w-full" />}>
                            <KnowledgeEditor
                                initial={(note?.object.content as DocNode | undefined) ?? EMPTY_DOCUMENT}
                                editable={editable}
                                placeholder={date === today ? "What's happening today? Type [[ to link to something…" : "Write about this day…"}
                                onChange={(doc) => saver.queue({ content: doc })}
                                lookup={async (q) => {
                                    const { results } = await knowledgeApi.lookup(space.id, q);
                                    return results
                                        .filter((r) => r.id !== note?.object.id)
                                        .map((r) => ({ id: r.id, title: r.title, hint: types.find((t) => t.id === r.typeId)?.name }));
                                }}
                                createPage={async (title) => {
                                    const created = await knowledgeApi.create(space.id, { title });
                                    return { id: created.object.id, title: created.object.title };
                                }}
                            />
                        </Suspense>
                    )}
                </div>

                <aside className="flex flex-col gap-6 lg:sticky lg:top-6 lg:self-start" aria-label="Other days">
                    <section className="rounded-xl bg-primary p-4 shadow-xs ring-1 ring-secondary ring-inset">
                        <h2 className="sr-only">Calendar</h2>
                        <Calendar
                            aria-label="Choose a day"
                            value={parseDate(date)}
                            highlightedDates={highlighted}
                            onChange={(value) => value && go(value.toString())}
                            className="items-center"
                        >
                            <p className="text-center text-xs text-tertiary">Dots mark days with a note.</p>
                        </Calendar>
                    </section>

                    {note && (
                        <section className="flex flex-col gap-2">
                            <h2 className="text-sm font-semibold text-primary">This note</h2>
                            <Button size="sm" color="secondary" iconLeading={File04} href={objectHref(note.object.id)}>
                                Tags, links and history
                            </Button>
                            {note.backlinks.length > 0 && (
                                <ul className="mt-2 flex flex-col gap-1.5" aria-label="Linked from">
                                    {note.backlinks.map((link) => (
                                        <li key={link.relationId} className="flex items-center gap-2 text-sm">
                                            <TypeIconFor type={types.find((t) => t.id === link.object.typeId)} />
                                            <a href={objectHref(link.object.id)} className="truncate font-medium text-secondary hover:underline">
                                                {titleOf(link.object.title)}
                                            </a>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </section>
                    )}

                    <section className="flex flex-col gap-2">
                        <div className="flex items-center justify-between">
                            <h2 className="text-sm font-semibold text-primary">Recent days</h2>
                            <div className="flex gap-1">
                                <ButtonUtility size="xs" color="tertiary" icon={ChevronLeft} tooltip="A week earlier" href={dailyHref(space, addDays(date, -7))} />
                                <ButtonUtility size="xs" color="tertiary" icon={ChevronRight} tooltip="A week later" href={dailyHref(space, addDays(date, 7))} />
                            </div>
                        </div>
                        {recent.length ? (
                            <ul className="flex flex-col divide-y divide-secondary rounded-xl ring-1 ring-secondary ring-inset">
                                {recent.map((day) => (
                                    <li key={day.id}>
                                        <a
                                            href={dailyHref(space, day.date)}
                                            aria-current={day.date === date ? "page" : undefined}
                                            className="block px-3 py-2.5 transition duration-100 ease-linear hover:bg-primary_hover aria-[current=page]:bg-active"
                                        >
                                            <span className="block text-sm font-medium text-secondary">{formatDailyTitle(day.date)}</span>
                                            {day.excerpt && <span className="line-clamp-1 text-xs text-tertiary">{day.excerpt}</span>}
                                        </a>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="text-sm text-tertiary">Your daily notes will be listed here.</p>
                        )}
                    </section>
                </aside>
            </div>
        </>
    );
};
