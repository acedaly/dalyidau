import { useEffect, useMemo, useState } from "react";
import { Edit03, HelpCircle, Plus, Trash01 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { TextArea } from "@/components/base/textarea/textarea";
import { Toggle } from "@/components/base/toggle/toggle";
import { ConfirmDialog, PortalDialog } from "@/portal/components/dialog";
import { FormError, FormGrid, FullWidth, useSubmit } from "@/portal/components/form";
import { api } from "@/portal/lib/api";
import type { QuestionSummary, QuestionType, RsvpQuestion, WeddingEvent } from "@/shared/portal/types";

const TYPE_LABELS: Record<QuestionType, string> = {
    short_text: "Short text",
    long_text: "Long text",
    single_choice: "Single choice",
    multiple_choice: "Multiple choice",
    yes_no: "Yes or no",
    number: "Number",
    date: "Date",
};

const emptyDraft = (): Omit<RsvpQuestion, "id" | "version" | "createdAt" | "updatedAt"> => ({
    label: "",
    help: null,
    type: "short_text",
    options: [],
    required: false,
    scope: "guest",
    audience: "all",
    eventId: null,
    condition: null,
    published: false,
    sortOrder: 0,
    archived: false,
});

export const QuestionBuilder = ({
    initialQuestions,
    initialSummaries,
    events,
    canEdit,
}: {
    initialQuestions: RsvpQuestion[];
    initialSummaries: QuestionSummary[];
    events: WeddingEvent[];
    canEdit: boolean;
}) => {
    const [questions, setQuestions] = useState(initialQuestions);
    const [summaries, setSummaries] = useState(initialSummaries);
    const [editing, setEditing] = useState<RsvpQuestion | null | undefined>(undefined);
    const [archiving, setArchiving] = useState<RsvpQuestion | null>(null);
    const [draft, setDraft] = useState(emptyDraft());
    const choiceType = draft.type === "single_choice" || draft.type === "multiple_choice";

    useEffect(() => {
        if (editing === undefined) return;
        setDraft(editing ? { ...editing } : emptyDraft());
    }, [editing]);

    const parentQuestions = useMemo(
        () =>
            questions.filter(
                (question) => !question.archived && question.id !== editing?.id && ["yes_no", "single_choice", "multiple_choice"].includes(question.type),
            ),
        [editing?.id, questions],
    );
    const parent = parentQuestions.find((question) => question.id === draft.condition?.questionId);
    const conditionValues = parent ? (parent.type === "yes_no" ? ["yes", "no"] : parent.options) : [];

    const refresh = async () => {
        const result = await api<{ questions: RsvpQuestion[]; summaries: QuestionSummary[] }>("GET", "/api/portal/wedding/rsvp-questions");
        setQuestions(result.questions);
        setSummaries(result.summaries);
    };
    const save = useSubmit(
        () =>
            api<{ question: RsvpQuestion }>(editing ? "PATCH" : "POST", `/api/portal/wedding/rsvp-questions${editing ? `/${editing.id}` : ""}`, {
                ...draft,
                help: draft.help || null,
                audience: draft.scope === "household" ? "all" : draft.audience,
                options: choiceType ? draft.options : [],
                updatedAt: editing?.updatedAt,
            }),
        {
            success: editing ? "Question saved" : "Question created",
            onSuccess: async () => {
                await refresh();
                setEditing(undefined);
            },
        },
    );

    const active = questions.filter((question) => !question.archived);
    const archived = questions.filter((question) => question.archived);
    const bus = summaries.find((summary) => summary.question.id === "q_bus");
    const busSeats = bus?.counts.find((count) => count.option.toLowerCase() === "yes")?.count ?? 0;

    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <h2 className="text-md font-semibold text-primary">Custom questions</h2>
                    <p className="text-sm text-tertiary">
                        Published questions appear in the native form only. Editing wording or choices creates a new version.
                    </p>
                </div>
                {canEdit && (
                    <Button iconLeading={Plus} onClick={() => setEditing(null)}>
                        Add question
                    </Button>
                )}
            </div>

            {bus && (
                <div className="rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset">
                    <p className="text-sm font-medium text-secondary">Courtesy bus interest</p>
                    <p className="mt-1 text-display-xs font-semibold text-primary">{busSeats}</p>
                    <p className="text-sm text-tertiary">guest{busSeats === 1 ? "" : "s"} would like a seat</p>
                </div>
            )}

            <div className="flex flex-col gap-3">
                {active.map((question) => {
                    const summary = summaries.find((item) => item.question.id === question.id);
                    return (
                        <article
                            key={question.id}
                            className="flex flex-col gap-4 rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset sm:flex-row sm:items-start sm:justify-between"
                        >
                            <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                    <h3 className="font-semibold text-primary">{question.label}</h3>
                                    <Badge size="sm" color={question.published ? "success" : "gray"}>
                                        {question.published ? "Published" : "Draft"}
                                    </Badge>
                                    <Badge size="sm" color="brand">
                                        v{question.version}
                                    </Badge>
                                </div>
                                <p className="mt-1 text-sm text-tertiary">
                                    {TYPE_LABELS[question.type]} ·{" "}
                                    {question.scope === "household"
                                        ? "Once per household"
                                        : question.audience === "all"
                                          ? "Every guest"
                                          : `${question.audience}s`}{" "}
                                    · {summary?.answered ?? 0} answers
                                </p>
                                {!!summary?.counts.length && (
                                    <p className="mt-2 text-sm text-secondary">
                                        {summary.counts.map((count) => `${count.option}: ${count.count}`).join(" · ")}
                                    </p>
                                )}
                                {summary?.total !== null && summary?.total !== undefined && (
                                    <p className="mt-2 text-sm text-secondary">Total: {summary.total}</p>
                                )}
                                {!!summary?.responses.length && (
                                    <ul className="mt-2 space-y-1 text-sm text-secondary">
                                        {summary.responses.slice(0, 5).map((response, index) => (
                                            <li key={`${response.who}-${index}`}>
                                                <span className="font-medium">{response.who}:</span> {response.value}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                            {canEdit && (
                                <div className="flex shrink-0 gap-2">
                                    <Button size="sm" color="secondary" iconLeading={Edit03} onClick={() => setEditing(question)}>
                                        Edit
                                    </Button>
                                    <Button size="sm" color="tertiary-destructive" iconLeading={Trash01} onClick={() => setArchiving(question)}>
                                        Archive
                                    </Button>
                                </div>
                            )}
                        </article>
                    );
                })}
                {active.length === 0 && (
                    <p className="rounded-xl bg-secondary p-5 text-sm text-tertiary">
                        No questions yet. The standard attendance fields still appear in the form.
                    </p>
                )}
            </div>

            {!!archived.length && (
                <p className="text-sm text-quaternary">
                    {archived.length} archived question{archived.length === 1 ? "" : "s"}; their existing answers remain in reports.
                </p>
            )}

            <PortalDialog
                isOpen={editing !== undefined}
                onOpenChange={(open) => !open && setEditing(undefined)}
                title={editing ? "Edit RSVP question" : "Add RSVP question"}
                description="Questions can be limited by guest age, event attendance or another answer."
                icon={HelpCircle}
                size="lg"
                onSubmit={save.submit}
                footer={
                    <>
                        <Button color="secondary" size="lg" onClick={() => setEditing(undefined)}>
                            Cancel
                        </Button>
                        <Button type="submit" size="lg" isLoading={save.busy} showTextWhileLoading>
                            Save question
                        </Button>
                    </>
                }
            >
                <FormError message={save.error?.issues.length ? null : save.error?.message} />
                <FormGrid>
                    <FullWidth>
                        <Input
                            label="Question"
                            isRequired
                            value={draft.label}
                            onChange={(label) => setDraft({ ...draft, label })}
                            isInvalid={!!save.fieldError("label")}
                            hint={save.fieldError("label")}
                        />
                    </FullWidth>
                    <FullWidth>
                        <Input label="Help text" value={draft.help ?? ""} onChange={(help) => setDraft({ ...draft, help })} />
                    </FullWidth>
                    <Select
                        label="Answer type"
                        items={Object.entries(TYPE_LABELS).map(([id, label]) => ({ id, label }))}
                        value={draft.type}
                        onChange={(value) =>
                            setDraft({
                                ...draft,
                                type: value as QuestionType,
                                options: ["single_choice", "multiple_choice"].includes(String(value)) ? draft.options : [],
                            })
                        }
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                    <Select
                        label="Ask"
                        items={[
                            { id: "guest", label: "Each guest" },
                            { id: "household", label: "Once per household" },
                        ]}
                        value={draft.scope}
                        onChange={(value) =>
                            setDraft({ ...draft, scope: value as RsvpQuestion["scope"], audience: value === "household" ? "all" : draft.audience })
                        }
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                    {choiceType && (
                        <FullWidth>
                            <TextArea
                                label="Options"
                                hint="One option per line."
                                rows={5}
                                value={draft.options.join("\n")}
                                onChange={(value) =>
                                    setDraft({
                                        ...draft,
                                        options: value
                                            .split("\n")
                                            .map((item) => item.trim())
                                            .filter(Boolean),
                                    })
                                }
                                isInvalid={!!save.fieldError("options")}
                            />
                        </FullWidth>
                    )}
                    {draft.scope === "guest" && (
                        <Select
                            label="Guests"
                            items={[
                                { id: "all", label: "All ages" },
                                { id: "adult", label: "Adults only" },
                                { id: "child", label: "Children and infants" },
                            ]}
                            value={draft.audience}
                            onChange={(value) => setDraft({ ...draft, audience: value as RsvpQuestion["audience"] })}
                        >
                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                        </Select>
                    )}
                    <Select
                        label="Event condition"
                        items={[{ id: "none", label: "Any attendance" }, ...events.map((event) => ({ id: event.id, label: `Attending ${event.name}` }))]}
                        value={draft.eventId ?? "none"}
                        onChange={(value) => setDraft({ ...draft, eventId: value === "none" ? null : String(value) })}
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                    <Select
                        label="Depends on"
                        items={[{ id: "none", label: "No other answer" }, ...parentQuestions.map((question) => ({ id: question.id, label: question.label }))]}
                        value={draft.condition?.questionId ?? "none"}
                        onChange={(value) => setDraft({ ...draft, condition: value === "none" ? null : { questionId: String(value), equals: "" } })}
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                    {draft.condition && (
                        <Select
                            label="Show when answer is"
                            items={conditionValues.map((value) => ({ id: value, label: value }))}
                            value={draft.condition.equals || undefined}
                            onChange={(value) => setDraft({ ...draft, condition: { ...draft.condition!, equals: String(value) } })}
                        >
                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                        </Select>
                    )}
                    <FullWidth>
                        <Toggle label="Required" isSelected={draft.required} onChange={(required) => setDraft({ ...draft, required })} />
                    </FullWidth>
                    <FullWidth>
                        <Toggle label="Published in the native form" isSelected={draft.published} onChange={(published) => setDraft({ ...draft, published })} />
                    </FullWidth>
                </FormGrid>
            </PortalDialog>

            <ConfirmDialog
                isOpen={!!archiving}
                onOpenChange={(open) => !open && setArchiving(null)}
                title={archiving ? `Archive “${archiving.label}”?` : "Archive question?"}
                description="It will disappear from the guest form. Existing answers and their original wording are preserved."
                confirmLabel="Archive question"
                onConfirm={async () => {
                    if (!archiving) return;
                    await api("DELETE", `/api/portal/wedding/rsvp-questions/${archiving.id}`);
                    await refresh();
                    setArchiving(null);
                }}
            />
        </div>
    );
};
