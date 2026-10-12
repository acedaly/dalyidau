// The native RSVP, step by step: find the invitation (signed link or code), say who's coming,
// add details (dietary needs, configured questions, a note), review, send, and see a confirmation.
// The server re-validates everything; the checks here only make the form friendlier.
// In the portal preview it talks to the owners-only test endpoints, so it can be tried before the
// "rsvp.native" flag is turned on.
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, CalendarPlus01, Edit03 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { TextArea } from "@/components/base/textarea/textarea";
import { formatDate, formatTime } from "@/portal/lib/format";
import { answerText, questionApplies, validateAnswer } from "@/shared/portal/rsvp-questions";
import type { AnswerValue, RsvpHousehold, RsvpQuestion, WeddingDetails } from "@/shared/portal/types";
import { cx } from "@/utils/cx";
import { EucalyptusBranch, Sprig } from "@/wedding/components/ornament";
import { Eyebrow, longDate, weddingButton } from "@/wedding/components/ui";
import { downloadCalendarFile, weddingCalendarFile } from "@/wedding/rsvp/calendar";
import { Card, ChoiceGroup, QuestionField, StepIndicator, fieldProps } from "@/wedding/rsvp/fields";

type Status = "attending" | "declined";
type Answers = Record<string, { events: Record<string, Status | undefined>; dietary: string }>;
type QuestionAnswers = { household: Record<string, AnswerValue>; guests: Record<string, Record<string, AnswerValue>> };
type Guest = RsvpHousehold["guests"][number];
type Step = "find" | "attendance" | "details" | "review" | "done";

const STEPS = ["Who's coming", "Details", "Review"];
const STEP_INDEX: Partial<Record<Step, number>> = { attendance: 0, details: 1, review: 2 };

const answersFrom = (household: RsvpHousehold): Answers =>
    Object.fromEntries(
        household.guests.map((g) => [
            g.id,
            {
                dietary: g.dietary ?? "",
                events: Object.fromEntries(
                    Object.entries(household.responses[g.id] ?? {}).map(([eventId, status]) => [eventId, status === "pending" ? undefined : status]),
                ),
            },
        ]),
    );

async function post<T>(url: string, body: unknown): Promise<T> {
    let response: Response;
    try {
        response = await fetch(url, {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify(body),
        });
    } catch {
        throw new Error("We couldn't reach the website. Please check your internet connection and try again.");
    }
    const data = (await response.json().catch(() => ({}))) as { message?: string };
    if (!response.ok) throw new Error(data.message ?? "Something went wrong. Please try again.");
    return data as T;
}

const ageLabel = (guest: Guest) => (guest.ageGroup === "child" ? "Child" : guest.ageGroup === "infant" ? "Baby" : null);
const fullName = (guest: Guest) => `${guest.firstName} ${guest.lastName}`.trim();
const listNames = (names: string[]) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

const eventWhen = (event: RsvpHousehold["events"][number]) =>
    [
        event.startsAt ? formatDate(event.startsAt.slice(0, 10), { weekday: "long", day: "numeric", month: "long" }) : null,
        event.startsAt ? formatTime(event.startsAt) : null,
        event.venueName,
    ]
        .filter(Boolean)
        .join(" · ");

const ErrorNote = ({ message }: { message: string | null }) =>
    message ? (
        <p role="alert" className="bg-clay-50 text-clay-700 ring-clay-200 rounded-[2px] px-4 py-3 text-[0.9375rem] ring-1 ring-inset">
            {message}
        </p>
    ) : null;

export const RsvpFlow = ({ apiBase, deadline, wedding, homeHref }: { apiBase: string; deadline: string | null; wedding: WeddingDetails; homeHref: string }) => {
    const [code, setCode] = useState("");
    const [household, setHousehold] = useState<RsvpHousehold | null>(null);
    const [answers, setAnswers] = useState<Answers>({});
    const [questionAnswers, setQuestionAnswers] = useState<QuestionAnswers>({ household: {}, guests: {} });
    const [token, setToken] = useState<string | null>(null);
    const [clientId, setClientId] = useState(() => crypto.randomUUID());
    const [message, setMessage] = useState("");
    const [email, setEmail] = useState("");
    const [step, setStep] = useState<Step>("find");
    const [opening, setOpening] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showErrors, setShowErrors] = useState(false);
    const [returning, setReturning] = useState(false);
    const [confirmationSent, setConfirmationSent] = useState(false);
    const top = useRef<HTMLDivElement>(null);

    const go = (next: Step) => {
        setStep(next);
        setError(null);
        setShowErrors(false);
        // Move focus to the new step's heading so screen readers and keyboards follow along.
        requestAnimationFrame(() => {
            top.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
            top.current?.querySelector<HTMLElement>("[data-step-heading]")?.focus({ preventScroll: true });
        });
    };

    const openInvitation = async (credential: { code?: string; token?: string }) => {
        setBusy(true);
        setError(null);
        try {
            const { household: found } = await post<{ household: RsvpHousehold }>(`${apiBase}/lookup`, credential);
            setHousehold(found);
            setAnswers(answersFrom(found));
            setQuestionAnswers(found.answers);
            setReturning(Object.values(found.responses).some((events) => Object.values(events).some((s) => s !== "pending")));
            go(found.deadlinePassed ? "review" : "attendance");
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(false);
            setOpening(false);
        }
    };

    // Signed invitation links open directly; short codes remain available only when enabled in settings.
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const invite = params.get("invite");
        const fromLink = params.get("code");
        if (invite) {
            setToken(invite);
            setOpening(true);
            void openInvitation({ token: invite });
        } else if (fromLink) setCode(fromLink.toUpperCase());
        // The URL credential is immutable for this mounted flow.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (opening) {
        return (
            <Card className="mx-auto max-w-lg">
                <div className="flex flex-col items-center gap-4 py-6 text-center" role="status">
                    <Sprig className="animate-pulse" />
                    <p className="wedding-display text-forest text-[1.75rem]">Opening your invitation…</p>
                </div>
            </Card>
        );
    }

    // -----------------------------------------------------------------------------------------
    // Find the invitation

    if (step === "find" || !household) {
        const ready = code.replace(/[^A-Z0-9]/gi, "").length >= 6;
        return (
            <div ref={top} className="scroll-mt-24">
                <Card className="mx-auto max-w-lg">
                    <form
                        className="flex flex-col gap-6"
                        onSubmit={(e) => {
                            e.preventDefault();
                            if (ready) void openInvitation({ code });
                        }}
                    >
                        <div className="flex flex-col items-center gap-3 text-center">
                            <h2 data-step-heading tabIndex={-1} className="wedding-display text-forest text-[2rem] outline-none sm:text-[2.25rem]">
                                Find your invitation
                            </h2>
                            <p className="wedding-prose text-charcoal max-w-sm">
                                Enter the code printed on your invitation and you can reply for everyone in your household.
                            </p>
                            {deadline && <p className="wedding-eyebrow text-clay-600">Kindly reply by {longDate(deadline)}</p>}
                        </div>
                        <ErrorNote message={error} />
                        <Input
                            {...fieldProps}
                            label="Invitation code"
                            isRequired
                            autoComplete="off"
                            spellCheck="false"
                            placeholder="e.g. K7MXQ4RD"
                            value={code}
                            onChange={(v) => setCode(v.toUpperCase())}
                            inputClassName={cx(fieldProps.inputClassName, "font-mono text-[1.25rem] tracking-[0.3em] uppercase")}
                        />
                        <Button type="submit" size="xl" isLoading={busy} showTextWhileLoading isDisabled={!ready} className={weddingButton.primary}>
                            Find my invitation
                        </Button>
                        <p className="text-center text-sm text-tertiary">
                            Received a personal link by email or text? Just open it and your invitation will appear here.
                        </p>
                    </form>
                </Card>
            </div>
        );
    }

    // -----------------------------------------------------------------------------------------
    // Helpers that depend on the household

    const invitedEvents = (guest: Guest) => household.events.filter((event) => event.id in (household.responses[guest.id] ?? {}));
    const attendingAny = (guest: Guest) => Object.values(answers[guest.id]?.events ?? {}).some((s) => s === "attending");
    const setEvent = (guestId: string, eventId: string, status: Status) =>
        setAnswers((current) => ({ ...current, [guestId]: { ...current[guestId], events: { ...current[guestId].events, [eventId]: status } } }));
    const unanswered = household.guests.filter((g) => invitedEvents(g).some((event) => !answers[g.id]?.events[event.id]));

    const appliesToGuest = (question: RsvpQuestion, guest: Guest) =>
        questionApplies(question, {
            ageGroup: guest.ageGroup,
            attending: (eventId) => answers[guest.id]?.events[eventId] === "attending",
            answerTo: (questionId) => questionAnswers.guests[guest.id]?.[questionId],
        });
    const appliesToHousehold = (question: RsvpQuestion) =>
        questionApplies(question, {
            ageGroup: null,
            attending: (eventId) => household.guests.some((guest) => answers[guest.id]?.events[eventId] === "attending"),
            answerTo: (questionId) => questionAnswers.household[questionId],
        });
    const guestQuestions = (guest: Guest) => household.questions.filter((q) => q.scope === "guest" && appliesToGuest(q, guest));
    const householdQuestions = household.questions.filter((q) => q.scope === "household" && appliesToHousehold(q));
    const detailGuests = household.guests.filter((g) => (household.collectDietary && attendingAny(g)) || guestQuestions(g).length > 0);

    const questionError = (question: RsvpQuestion, value: AnswerValue | undefined) => {
        const checked = validateAnswer(question, value);
        return "error" in checked ? checked.error : undefined;
    };
    const detailErrors = [
        ...household.guests.flatMap((g) => guestQuestions(g).map((q) => questionError(q, questionAnswers.guests[g.id]?.[q.id]))),
        ...householdQuestions.map((q) => questionError(q, questionAnswers.household[q.id])),
        email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? "email" : undefined,
    ].filter(Boolean);

    const submit = async () => {
        setBusy(true);
        setError(null);
        try {
            const result = await post<{ household: RsvpHousehold; confirmationSent?: boolean }>(`${apiBase}/submit`, {
                ...(token ? { token } : { code }),
                clientId,
                guests: household.guests.map((g) => ({
                    guestId: g.id,
                    events: answers[g.id].events,
                    ...(household.collectDietary ? { dietary: attendingAny(g) ? answers[g.id].dietary : (g.dietary ?? "") } : {}),
                })),
                message: household.collectMessage ? message : null,
                email,
                answers: questionAnswers,
            });
            setHousehold(result.household);
            setConfirmationSent(!!result.confirmationSent);
            setClientId(crypto.randomUUID());
            go("done");
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(false);
        }
    };

    const header = (title: string, intro?: string) => (
        <div className="flex flex-col items-center gap-5 text-center">
            {STEP_INDEX[step] !== undefined && !household.deadlinePassed && <StepIndicator steps={STEPS} current={STEP_INDEX[step]!} />}
            <div className="flex flex-col items-center gap-2">
                <Eyebrow>Replying for</Eyebrow>
                <p className="wedding-display text-clay-600 text-[1.375rem] italic">{household.householdName}</p>
            </div>
            <h2 data-step-heading tabIndex={-1} className="wedding-display text-forest text-[2rem] leading-tight outline-none sm:text-[2.5rem]">
                {title}
            </h2>
            {intro && <p className="wedding-prose text-charcoal max-w-md">{intro}</p>}
        </div>
    );

    // -----------------------------------------------------------------------------------------
    // Step 1: who's coming

    if (step === "attendance") {
        const allEvents = household.guests.flatMap((g) => invitedEvents(g).map((e) => [g.id, e.id] as const));
        return (
            <div ref={top} className="scroll-mt-24">
                <Card>
                    {header(
                        "Who's coming?",
                        household.guests.length > 1 ? "Please let us know for each person in your household." : "Please let us know if you can make it.",
                    )}
                    {returning && (
                        <p className="bg-eucalypt-light text-forest rounded-xl px-4 py-3 text-center text-[0.9375rem]">
                            You've already replied. Your answers are filled in below, and you can change anything
                            {deadline ? ` until ${longDate(deadline)}` : ""}.
                        </p>
                    )}
                    {household.guests.length > 1 && (
                        <div className="flex justify-center">
                            <Button
                                size="md"
                                className={cx(weddingButton.outline, "min-h-11 py-2.5 text-[0.75rem]")}
                                onClick={() => allEvents.forEach(([guestId, eventId]) => setEvent(guestId, eventId, "attending"))}
                            >
                                We're all coming
                            </Button>
                        </div>
                    )}
                    <ul className="divide-sandstone/70 border-sandstone/70 flex flex-col divide-y border-y">
                        {household.guests.map((guest) => {
                            const events = invitedEvents(guest);
                            const missing = showErrors && unanswered.includes(guest);
                            return (
                                <li key={guest.id} className="flex flex-col gap-5 py-7">
                                    <div className="flex items-baseline justify-between gap-3">
                                        <h3 className="wedding-display text-forest text-[1.75rem]">{fullName(guest)}</h3>
                                        {ageLabel(guest) && <span className="wedding-eyebrow text-[0.625rem] text-olive-600">{ageLabel(guest)}</span>}
                                    </div>
                                    {events.map((event) => (
                                        <ChoiceGroup
                                            key={event.id}
                                            label={events.length > 1 || household.events.length > 1 ? event.name : `${guest.firstName}: ${event.name}`}
                                            hideLabel={events.length === 1 && household.events.length === 1}
                                            description={eventWhen(event) || undefined}
                                            invalid={missing && !answers[guest.id]?.events[event.id]}
                                            value={answers[guest.id]?.events[event.id] ?? null}
                                            onChange={(value) => setEvent(guest.id, event.id, value as Status)}
                                            choices={[
                                                { value: "attending", label: "Joyfully accepts", shortLabel: "Accepts", tone: "accept" },
                                                { value: "declined", label: "Regretfully declines", shortLabel: "Declines", tone: "decline" },
                                            ]}
                                        />
                                    ))}
                                    {missing && <p className="text-sm text-error-primary">Please choose an answer for {guest.firstName}.</p>}
                                </li>
                            );
                        })}
                    </ul>
                    {showErrors && unanswered.length > 0 && (
                        <ErrorNote message={`We still need an answer for ${listNames(unanswered.map((g) => g.firstName))}.`} />
                    )}
                    <div className="flex flex-col-reverse gap-4 sm:flex-row sm:items-center sm:justify-between">
                        <Button
                            color="tertiary"
                            iconLeading={ArrowLeft}
                            className="justify-center text-tertiary"
                            onClick={() => {
                                setToken(null);
                                setHousehold(null);
                                go("find");
                            }}
                        >
                            Not you? Use another code
                        </Button>
                        <Button
                            size="xl"
                            iconTrailing={ArrowRight}
                            className={weddingButton.primary}
                            onClick={() => {
                                if (unanswered.length) setShowErrors(true);
                                else go("details");
                            }}
                        >
                            Continue
                        </Button>
                    </div>
                </Card>
            </div>
        );
    }

    // -----------------------------------------------------------------------------------------
    // Step 2: details

    if (step === "details") {
        const nobody = !household.guests.some(attendingAny);
        return (
            <div ref={top} className="scroll-mt-24">
                <Card>
                    {header(
                        nobody ? "We'll miss you" : "A few details",
                        nobody
                            ? "Thanks for letting us know. Is there anything you'd like to tell us?"
                            : "Help us look after everyone on the day. Anything not marked with a * is optional.",
                    )}
                    {detailGuests.map((guest) => (
                        <section key={guest.id} aria-labelledby={`details-${guest.id}`} className="border-sandstone/70 flex flex-col gap-5 border-t pt-7">
                            <div className="flex items-baseline justify-between gap-3">
                                <h3 id={`details-${guest.id}`} className="wedding-display text-forest text-[1.75rem]">
                                    {fullName(guest)}
                                </h3>
                                {ageLabel(guest) && <span className="wedding-eyebrow text-[0.625rem] text-olive-600">{ageLabel(guest)}</span>}
                            </div>
                            {household.collectDietary && attendingAny(guest) && (
                                <Input
                                    {...fieldProps}
                                    label="Dietary requirements or allergies"
                                    placeholder="e.g. vegetarian, nut allergy"
                                    hint="Leave blank if there's nothing we need to know."
                                    value={answers[guest.id]?.dietary ?? ""}
                                    onChange={(v) => setAnswers((current) => ({ ...current, [guest.id]: { ...current[guest.id], dietary: v } }))}
                                />
                            )}
                            {guestQuestions(guest).map((question) => (
                                <QuestionField
                                    key={question.id}
                                    idPrefix={guest.id}
                                    question={question}
                                    value={questionAnswers.guests[guest.id]?.[question.id]}
                                    error={showErrors ? questionError(question, questionAnswers.guests[guest.id]?.[question.id]) : undefined}
                                    onChange={(value) =>
                                        setQuestionAnswers((current) => ({
                                            ...current,
                                            guests: { ...current.guests, [guest.id]: { ...current.guests[guest.id], [question.id]: value } },
                                        }))
                                    }
                                />
                            ))}
                        </section>
                    ))}

                    <section aria-labelledby="household-details" className="border-sandstone/70 flex flex-col gap-5 border-t pt-7">
                        <h3 id="household-details" className="wedding-display text-forest text-[1.75rem]">
                            {household.guests.length > 1 ? "For your household" : "Anything else"}
                        </h3>
                        {householdQuestions.map((question) => (
                            <QuestionField
                                key={question.id}
                                idPrefix="household"
                                question={question}
                                value={questionAnswers.household[question.id]}
                                error={showErrors ? questionError(question, questionAnswers.household[question.id]) : undefined}
                                onChange={(value) =>
                                    setQuestionAnswers((current) => ({ ...current, household: { ...current.household, [question.id]: value } }))
                                }
                            />
                        ))}
                        {household.collectMessage && (
                            <TextArea
                                label="A note for us"
                                hint="Optional"
                                rows={4}
                                value={message}
                                onChange={setMessage}
                                textAreaClassName="rounded-[2px] bg-paper text-[1.0625rem] ring-sandstone"
                            />
                        )}
                        <Input
                            {...fieldProps}
                            label="Email address"
                            type="email"
                            autoComplete="email"
                            inputMode="email"
                            hint={
                                showErrors && email && detailErrors.includes("email")
                                    ? "Please check the email address."
                                    : "Optional. So we can send you a confirmation and updates closer to the day."
                            }
                            isInvalid={showErrors && !!email && detailErrors.includes("email")}
                            value={email}
                            onChange={setEmail}
                        />
                    </section>

                    {showErrors && detailErrors.length > 0 && <ErrorNote message="A couple of answers need attention. They're highlighted above." />}
                    <div className="flex flex-col-reverse gap-4 sm:flex-row sm:items-center sm:justify-between">
                        <Button color="tertiary" iconLeading={ArrowLeft} className="justify-center text-tertiary" onClick={() => go("attendance")}>
                            Back
                        </Button>
                        <Button
                            size="xl"
                            iconTrailing={ArrowRight}
                            className={weddingButton.primary}
                            onClick={() => (detailErrors.length ? setShowErrors(true) : go("review"))}
                        >
                            Review my RSVP
                        </Button>
                    </div>
                </Card>
            </div>
        );
    }

    // -----------------------------------------------------------------------------------------
    // Step 3: review (also the read-only view after the deadline)

    const summary = (editable: boolean) => (
        <div className="flex flex-col gap-6">
            <section aria-labelledby="summary-attendance" className="flex flex-col gap-4">
                <div className="flex items-center justify-between gap-3">
                    <h3 id="summary-attendance" className="wedding-eyebrow text-olive-600">
                        Attendance
                    </h3>
                    {editable && (
                        <Button color="link-gray" size="sm" iconLeading={Edit03} onClick={() => go("attendance")} aria-label="Change attendance">
                            Change
                        </Button>
                    )}
                </div>
                <ul className="divide-sandstone/60 border-sandstone/60 flex flex-col divide-y border-y">
                    {household.guests.map((guest) => (
                        <li key={guest.id} className="flex flex-col gap-1.5 py-4">
                            <p className="wedding-display text-forest text-[1.375rem]">{fullName(guest)}</p>
                            {invitedEvents(guest).map((event) => {
                                const status = answers[guest.id]?.events[event.id];
                                return (
                                    <p key={event.id} className="flex flex-wrap items-baseline justify-between gap-x-4 text-[0.9375rem]">
                                        <span className="text-tertiary">{event.name}</span>
                                        <span
                                            className={cx("font-medium", status === "attending" ? "text-forest" : status ? "text-clay-700" : "text-tertiary")}
                                        >
                                            {status === "attending" ? "Joyfully accepts" : status === "declined" ? "Regretfully declines" : "No answer yet"}
                                        </span>
                                    </p>
                                );
                            })}
                            {household.collectDietary && attendingAny(guest) && answers[guest.id]?.dietary.trim() && (
                                <p className="text-[0.9375rem] text-tertiary">Dietary: {answers[guest.id].dietary}</p>
                            )}
                            {guestQuestions(guest)
                                .filter((q) => answerText(questionAnswers.guests[guest.id]?.[q.id]))
                                .map((q) => (
                                    <p key={q.id} className="text-[0.9375rem] text-tertiary">
                                        {q.label}: <span className="text-charcoal">{answerText(questionAnswers.guests[guest.id]?.[q.id])}</span>
                                    </p>
                                ))}
                        </li>
                    ))}
                </ul>
            </section>
            {(householdQuestions.some((q) => answerText(questionAnswers.household[q.id])) || message.trim() || email.trim()) && (
                <section aria-labelledby="summary-household" className="flex flex-col gap-3">
                    <div className="flex items-center justify-between gap-3">
                        <h3 id="summary-household" className="wedding-eyebrow text-olive-600">
                            Details
                        </h3>
                        {editable && (
                            <Button color="link-gray" size="sm" iconLeading={Edit03} onClick={() => go("details")} aria-label="Change details">
                                Change
                            </Button>
                        )}
                    </div>
                    <dl className="flex flex-col gap-2 text-[0.9375rem]">
                        {householdQuestions
                            .filter((q) => answerText(questionAnswers.household[q.id]))
                            .map((q) => (
                                <div key={q.id}>
                                    <dt className="inline text-tertiary">{q.label}: </dt>
                                    <dd className="text-charcoal inline">{answerText(questionAnswers.household[q.id])}</dd>
                                </div>
                            ))}
                        {email.trim() && (
                            <div>
                                <dt className="inline text-tertiary">Email: </dt>
                                <dd className="text-charcoal inline">{email}</dd>
                            </div>
                        )}
                        {message.trim() && (
                            <div>
                                <dt className="text-tertiary">Your note</dt>
                                <dd className="wedding-display text-charcoal mt-1 text-[1.25rem] whitespace-pre-line italic">{message}</dd>
                            </div>
                        )}
                    </dl>
                </section>
            )}
        </div>
    );

    if (step === "review") {
        return (
            <div ref={top} className="scroll-mt-24">
                <Card>
                    {household.deadlinePassed
                        ? header("Your RSVP", "Replies have closed, so this can't be changed online. If your plans have changed, please contact us directly.")
                        : header("Does this look right?", "Check your answers, then send your RSVP.")}
                    {summary(!household.deadlinePassed)}
                    <ErrorNote message={error} />
                    {!household.deadlinePassed && (
                        <div className="flex flex-col-reverse gap-4 sm:flex-row sm:items-center sm:justify-between">
                            <Button color="tertiary" iconLeading={ArrowLeft} className="justify-center text-tertiary" onClick={() => go("details")}>
                                Back
                            </Button>
                            <Button size="xl" className={weddingButton.primary} isLoading={busy} showTextWhileLoading onClick={() => void submit()}>
                                Send our RSVP
                            </Button>
                        </div>
                    )}
                </Card>
            </div>
        );
    }

    // -----------------------------------------------------------------------------------------
    // Done

    const coming = household.guests.filter((g) => Object.values(household.responses[g.id] ?? {}).some((s) => s === "attending"));
    const firstEvent = household.events.find((e) => coming.some((g) => household.responses[g.id]?.[e.id] === "attending"));
    return (
        <div ref={top} className="scroll-mt-24">
            <Card>
                <div className="flex flex-col items-center gap-5 text-center" role="status">
                    <EucalyptusBranch draw className="text-eucalypt w-48" />
                    <h2 data-step-heading tabIndex={-1} className="wedding-display text-forest text-[3rem] leading-none outline-none sm:text-[3.5rem]">
                        Thank you
                    </h2>
                    <p className="wedding-display text-charcoal max-w-md text-[1.5rem] leading-snug">
                        {coming.length > 0
                            ? `We can't wait to celebrate with ${listNames(coming.map((g) => g.firstName))}.`
                            : "We'll miss you, and we're so grateful you let us know."}
                    </p>
                    <p className="text-[0.9375rem] text-tertiary">
                        Your RSVP has been saved
                        {confirmationSent && email ? `, and we've emailed a confirmation to ${email}` : ""}.
                        {!household.deadlinePassed && " You can come back and change it any time before the deadline using the same link or code."}
                    </p>
                </div>
                {summary(false)}
                <div className="flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
                    {coming.length > 0 && wedding.date && (
                        <Button
                            size="xl"
                            iconLeading={CalendarPlus01}
                            className={weddingButton.primary}
                            onClick={() =>
                                downloadCalendarFile(
                                    weddingCalendarFile({
                                        title: `${wedding.partnerOne} & ${wedding.partnerTwo}'s wedding`,
                                        date: wedding.date,
                                        timeZone: wedding.timeZone,
                                        location: [firstEvent?.venueName, wedding.location].filter(Boolean).join(", "),
                                        startsAt: firstEvent?.startsAt ?? null,
                                        url: `${window.location.origin}${homeHref}`,
                                    }),
                                    "wedding.ics",
                                )
                            }
                        >
                            Add to calendar
                        </Button>
                    )}
                    <Button href={homeHref} size="xl" className={weddingButton.outline}>
                        Back to the website
                    </Button>
                </div>
                {!household.deadlinePassed && (
                    <div className="flex justify-center">
                        <Button color="link-gray" onClick={() => go("attendance")}>
                            Change our RSVP
                        </Button>
                    </div>
                )}
            </Card>
        </div>
    );
};
