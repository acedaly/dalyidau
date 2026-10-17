// The native RSVP, step by step: find the invitation (signed link or code), say who's coming,
// add details (dietary needs, configured questions, a note), say how they're getting there and
// where they're staying (optional, once per household), review, send, and see a confirmation.
// Each person can be accepted, declined or left unanswered to finish later with the same link.
// The server re-validates everything; the checks here only make the form friendlier.
// In the portal preview it talks to the owners-only test endpoints, so it can be tried before the
// "rsvp.native" flag is turned on.
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Bus, CalendarPlus01, Edit03, Home02 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { TextArea } from "@/components/base/textarea/textarea";
import { formatDate, formatTime } from "@/portal/lib/format";
import { icsFile, icsFilename, weddingCalendarEvent } from "@/shared/portal/calendar";
import { answerText, questionApplies, validateAnswer } from "@/shared/portal/rsvp-questions";
import {
    BUS_CHOICES,
    BUS_LABELS,
    type BusChoice,
    EMPTY_TRAVEL,
    type RsvpTravel,
    STAY_CHOICES,
    STAY_LABELS,
    STAY_LOCATION_MAX,
    type StayChoice,
    needsOutbound,
    needsReturn,
} from "@/shared/portal/travel";
import type { AnswerValue, RsvpHousehold, RsvpQuestion, WeddingDetails } from "@/shared/portal/types";
import { cx } from "@/utils/cx";
import { EucalyptusBranch, Sprig } from "@/wedding/components/ornament";
import { Eyebrow, longDate, weddingButton } from "@/wedding/components/ui";
import { downloadCalendarFile } from "@/wedding/rsvp/calendar";
import { Card, ChoiceGroup, CountField, QuestionField, StepIndicator, fieldProps } from "@/wedding/rsvp/fields";

type Status = "attending" | "declined";
type Answers = Record<string, { events: Record<string, Status | undefined>; dietary: string }>;
type QuestionAnswers = { household: Record<string, AnswerValue>; guests: Record<string, Record<string, AnswerValue>> };
type Guest = RsvpHousehold["guests"][number];
type Step = "find" | "attendance" | "details" | "travel" | "review" | "done";

/**
 * The travel answer as it will be sent: counts only for the chosen direction, defaulting to everyone
 * coming and never more than that, so changing attendance can't leave impossible numbers behind.
 */
const effectiveTravel = (travel: RsvpTravel, coming: number): RsvpTravel => {
    const clamp = (n: number) => Math.min(Math.max(n || coming, 1), coming);
    return {
        ...travel,
        outbound: needsOutbound(travel.bus) ? clamp(travel.outbound) : 0,
        return: needsReturn(travel.bus) ? clamp(travel.return) : 0,
        stayLocation: travel.stay === "dubbo" ? travel.stayLocation : null,
    };
};

const passengers = (n: number) => `${n} ${n === 1 ? "passenger" : "passengers"}`;

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
        <p role="alert" className="border-leaf bg-clay-50 text-clay-700 border-l-4 px-4 py-3 text-[0.9375rem] font-medium">
            {message}
        </p>
    ) : null;

export const RsvpFlow = ({ apiBase, deadline, wedding, homeHref }: { apiBase: string; deadline: string | null; wedding: WeddingDetails; homeHref: string }) => {
    const [code, setCode] = useState("");
    const [household, setHousehold] = useState<RsvpHousehold | null>(null);
    const [answers, setAnswers] = useState<Answers>({});
    const [questionAnswers, setQuestionAnswers] = useState<QuestionAnswers>({ household: {}, guests: {} });
    const [travel, setTravel] = useState<RsvpTravel>(EMPTY_TRAVEL);
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
            // An edited reply starts from the household's saved transport answer.
            setTravel(found.travel ?? EMPTY_TRAVEL);
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
    const clearGuest = (guestId: string) => setAnswers((current) => ({ ...current, [guestId]: { ...current[guestId], events: {} } }));
    const answeredAny = (guest: Guest) => invitedEvents(guest).some((event) => !!answers[guest.id]?.events[event.id]);
    const unanswered = household.guests.filter((g) => invitedEvents(g).some((event) => !answers[g.id]?.events[event.id]));
    const someoneAnswered = household.guests.some(answeredAny);
    const declinedAll = (guest: Guest) => invitedEvents(guest).every((event) => answers[guest.id]?.events[event.id] === "declined");

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
    const comingCount = household.guests.filter(attendingAny).length;
    // Transport is only asked of households with someone coming, and is entirely optional.
    const askTravel = household.collectTravel && comingCount > 0;
    const sentTravel = effectiveTravel(travel, comingCount);
    const steps = askTravel ? ["Who's coming", "Details", "Travel", "Review"] : ["Who's coming", "Details", "Review"];
    const stepIndex: Partial<Record<Step, number>> = askTravel ? { attendance: 0, details: 1, travel: 2, review: 3 } : { attendance: 0, details: 1, review: 2 };

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
                    // Anyone left unanswered is sent as "pending": answered later with the same link.
                    events: Object.fromEntries(invitedEvents(g).map((event) => [event.id, answers[g.id].events[event.id] ?? "pending"])),
                    ...(household.collectDietary ? { dietary: attendingAny(g) ? answers[g.id].dietary : (g.dietary ?? "") } : {}),
                })),
                message: household.collectMessage ? message : null,
                email,
                answers: questionAnswers,
                // Left out entirely when not asked, so an earlier answer is kept as it is.
                ...(askTravel ? { travel: sentTravel } : {}),
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
            {stepIndex[step] !== undefined && !household.deadlinePassed && <StepIndicator steps={steps} current={stepIndex[step]!} />}
            <div className="flex flex-col items-center gap-2 pt-1">
                <Eyebrow>Replying for</Eyebrow>
                <p className="wedding-display text-leaf max-w-lg text-[2.15rem] leading-none sm:text-[2.65rem]">{household.householdName}</p>
            </div>
            <h2 data-step-heading tabIndex={-1} className="wedding-eyebrow text-forest text-[0.75rem] font-semibold outline-none sm:text-[0.8125rem]">
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
                            {household.guests.some((g) => Object.values(household.responses[g.id] ?? {}).includes("pending"))
                                ? "Welcome back. Your answers so far are filled in below; finish the rest whenever you're ready"
                                : "You've already replied. Your answers are filled in below, and you can change anything"}
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
                                        <h3 className="wedding-display text-forest text-[2rem] leading-none sm:text-[2.25rem]">{fullName(guest)}</h3>
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
                                    {answeredAny(guest) && household.guests.length > 1 && (
                                        <Button
                                            color="link-gray"
                                            size="sm"
                                            className="self-start"
                                            aria-label={`Answer for ${fullName(guest)} later`}
                                            onClick={() => clearGuest(guest.id)}
                                        >
                                            Not sure yet? Answer later
                                        </Button>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                    {showErrors && unanswered.length > 0 && (
                        <div className="flex flex-col gap-3">
                            <ErrorNote message={`We still need an answer for ${listNames(unanswered.map((g) => g.firstName))}.`} />
                            {someoneAnswered && (
                                <Button
                                    size="md"
                                    className={cx(weddingButton.outline, "min-h-11 justify-center py-2.5 text-[0.75rem]")}
                                    onClick={() => go("details")}
                                >
                                    Reply now and answer for {listNames(unanswered.map((g) => g.firstName))} later
                                </Button>
                            )}
                        </div>
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
                            className={cx(weddingButton.primary, "min-h-14")}
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
                                <h3 id={`details-${guest.id}`} className="wedding-display text-forest text-[2rem] leading-none">
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
                            className={cx(weddingButton.primary, "min-h-14")}
                            onClick={() => (detailErrors.length ? setShowErrors(true) : go(askTravel ? "travel" : "review"))}
                        >
                            {askTravel ? "Continue" : "Review my RSVP"}
                        </Button>
                    </div>
                </Card>
            </div>
        );
    }

    // -----------------------------------------------------------------------------------------
    // Step 3: getting there and staying (optional, once per household)

    if (step === "travel" && askTravel) {
        const several = comingCount > 1;
        const clear = (patch: Partial<RsvpTravel>, label: string) => (
            <Button color="link-gray" size="sm" className="self-start" onClick={() => setTravel((current) => ({ ...current, ...patch }))}>
                {label}
            </Button>
        );
        return (
            <div ref={top} className="scroll-mt-24">
                <Card>
                    {header(
                        "Getting there and staying",
                        "Both questions are optional. Your answers help us plan the courtesy bus and accommodation; they don't book a seat or a room.",
                    )}
                    <section aria-labelledby="travel-bus" className="border-sandstone/70 flex flex-col gap-5 border-t pt-7">
                        <div className="flex items-center gap-3">
                            <Bus className="text-leaf size-6 shrink-0" aria-hidden="true" />
                            <h3 id="travel-bus" className="wedding-display text-forest text-[1.75rem] leading-tight">
                                Courtesy bus
                            </h3>
                        </div>
                        <ChoiceGroup
                            label="Will you need the courtesy bus?"
                            description="It leaves from Dubbo RSL at a prearranged time. We'll share confirmed pick-up points and times closer to the wedding."
                            value={travel.bus}
                            onChange={(bus) => setTravel((current) => ({ ...current, bus: bus as BusChoice }))}
                            choices={BUS_CHOICES.map((choice) => ({ value: choice, label: BUS_LABELS[choice] }))}
                        />
                        {several && needsOutbound(travel.bus) && (
                            <CountField
                                label="How many of you need the bus to the wedding?"
                                description={`${comingCount} of you are coming.`}
                                value={sentTravel.outbound}
                                min={1}
                                max={comingCount}
                                onChange={(outbound) => setTravel((current) => ({ ...current, outbound }))}
                            />
                        )}
                        {several && needsReturn(travel.bus) && (
                            <CountField
                                label="How many of you need the bus home after the reception?"
                                description="Return trips may run at set times or be requested through the bar staff on the night, subject to the driver's availability."
                                value={sentTravel.return}
                                min={1}
                                max={comingCount}
                                onChange={(back) => setTravel((current) => ({ ...current, return: back }))}
                            />
                        )}
                        {travel.bus && clear({ bus: null, outbound: 0, return: 0 }, "Clear this answer")}
                    </section>

                    <section aria-labelledby="travel-stay" className="border-sandstone/70 flex flex-col gap-5 border-t pt-7">
                        <div className="flex items-center gap-3">
                            <Home02 className="text-leaf size-6 shrink-0" aria-hidden="true" />
                            <h3 id="travel-stay" className="wedding-display text-forest text-[1.75rem] leading-tight">
                                Accommodation
                            </h3>
                        </div>
                        <ChoiceGroup
                            label="Where are you planning to stay?"
                            value={travel.stay}
                            onChange={(stay) => setTravel((current) => ({ ...current, stay: stay as StayChoice }))}
                            choices={STAY_CHOICES.map((choice) => ({ value: choice, label: STAY_LABELS[choice] }))}
                        />
                        {travel.stay === "glamping" && (
                            <p className="bg-eucalypt-light text-forest px-4 py-3 text-[0.9375rem]">
                                Glamping at Rhino Lodge is limited and first-in, first-served. We're coordinating it with Rhino Lodge and will be in touch to
                                point you in the right direction. Choosing it here doesn't reserve a place.
                            </p>
                        )}
                        {travel.stay === "dubbo" && (
                            <Input
                                {...fieldProps}
                                label="Accommodation name or location"
                                placeholder="e.g. The Westbury Dubbo"
                                hint="Optional. It helps us work out possible bus pick-up points, though we can't promise a pick-up from every hotel."
                                maxLength={STAY_LOCATION_MAX}
                                value={travel.stayLocation ?? ""}
                                onChange={(stayLocation) => setTravel((current) => ({ ...current, stayLocation }))}
                            />
                        )}
                        {travel.stay && clear({ stay: null, stayLocation: null }, "Clear this answer")}
                    </section>

                    <div className="flex flex-col-reverse gap-4 sm:flex-row sm:items-center sm:justify-between">
                        <Button color="tertiary" iconLeading={ArrowLeft} className="justify-center text-tertiary" onClick={() => go("details")}>
                            Back
                        </Button>
                        <Button size="xl" iconTrailing={ArrowRight} className={cx(weddingButton.primary, "min-h-14")} onClick={() => go("review")}>
                            Review my RSVP
                        </Button>
                    </div>
                </Card>
            </div>
        );
    }

    // -----------------------------------------------------------------------------------------
    // Step 4: review (also the read-only view after the deadline)

    const coming = household.guests.filter((g) => invitedEvents(g).some((event) => answers[g.id]?.events[event.id] === "attending"));
    const notComing = household.guests.filter((g) => !coming.includes(g) && !unanswered.includes(g) && declinedAll(g));
    const summary = (editable: boolean) => (
        <div className="flex flex-col gap-6">
            {household.guests.length > 1 && (
                <section aria-label="Household summary" className="flex flex-col gap-2">
                    <ul className="grid grid-cols-3 gap-2 text-center">
                        {[
                            { label: "Coming", count: coming.length, tone: "text-forest" },
                            { label: "Can't make it", count: notComing.length, tone: "text-clay-700" },
                            { label: "Not answered", count: unanswered.length, tone: "text-tertiary" },
                        ].map((item) => (
                            <li key={item.label} className="bg-paper ring-sandstone/70 flex flex-col rounded-[2px] px-2 py-3 ring-1 ring-inset">
                                <span className={cx("wedding-display text-[2rem] leading-none", item.tone)}>{item.count}</span>
                                <span className="mt-1 text-xs text-tertiary">{item.label}</span>
                            </li>
                        ))}
                    </ul>
                    {unanswered.length > 0 && !household.deadlinePassed && (
                        <p className="text-[0.9375rem] text-tertiary">
                            {listNames(unanswered.map((g) => g.firstName))} {unanswered.length === 1 ? "hasn't" : "haven't"} been answered yet. You can send
                            this now and use the same link to finish{deadline ? ` by ${longDate(deadline)}` : " later"}.
                        </p>
                    )}
                </section>
            )}
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
            {askTravel && (
                <section aria-labelledby="summary-travel" className="flex flex-col gap-3">
                    <div className="flex items-center justify-between gap-3">
                        <h3 id="summary-travel" className="wedding-eyebrow text-olive-600">
                            Getting there
                        </h3>
                        {editable && (
                            <Button
                                color="link-gray"
                                size="sm"
                                iconLeading={Edit03}
                                onClick={() => go("travel")}
                                aria-label="Change transport and accommodation"
                            >
                                Change
                            </Button>
                        )}
                    </div>
                    <dl className="flex flex-col gap-2 text-[0.9375rem]">
                        <div>
                            <dt className="inline text-tertiary">Courtesy bus: </dt>
                            <dd className="text-charcoal inline">
                                {sentTravel.bus ? BUS_LABELS[sentTravel.bus] : "Not answered"}
                                {comingCount > 1 &&
                                    sentTravel.bus === "both" &&
                                    sentTravel.outbound === sentTravel.return &&
                                    ` (${passengers(sentTravel.outbound)})`}
                                {comingCount > 1 && sentTravel.bus === "to" && ` (${passengers(sentTravel.outbound)})`}
                                {comingCount > 1 && sentTravel.bus === "home" && ` (${passengers(sentTravel.return)})`}
                            </dd>
                            {comingCount > 1 && sentTravel.bus === "both" && sentTravel.outbound !== sentTravel.return && (
                                <dd className="text-charcoal">
                                    {passengers(sentTravel.outbound)} to the wedding, {passengers(sentTravel.return)} home
                                </dd>
                            )}
                        </div>
                        <div>
                            <dt className="inline text-tertiary">Staying: </dt>
                            <dd className="text-charcoal inline">
                                {sentTravel.stay ? STAY_LABELS[sentTravel.stay] : "Not answered"}
                                {sentTravel.stayLocation?.trim() ? ` · ${sentTravel.stayLocation.trim()}` : ""}
                            </dd>
                        </div>
                    </dl>
                </section>
            )}
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

    if (step === "review" || step === "travel") {
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
                            <Button
                                color="tertiary"
                                iconLeading={ArrowLeft}
                                className="justify-center text-tertiary"
                                onClick={() => go(askTravel ? "travel" : "details")}
                            >
                                Back
                            </Button>
                            <Button
                                size="xl"
                                className={cx(weddingButton.primary, "min-h-14")}
                                isLoading={busy}
                                showTextWhileLoading
                                onClick={() => void submit()}
                            >
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

    const saved = household.guests.filter((g) => Object.values(household.responses[g.id] ?? {}).some((s) => s === "attending"));
    const stillToAnswer = household.guests.filter((g) => Object.values(household.responses[g.id] ?? {}).some((s) => s === "pending"));
    // The calendar event spans the events someone is coming to, when their times are confirmed.
    const attendedEvents = household.events.filter((e) => saved.some((g) => household.responses[g.id]?.[e.id] === "attending"));
    return (
        <div ref={top} className="scroll-mt-24">
            <Card>
                <div className="flex flex-col items-center gap-5 text-center" role="status">
                    <EucalyptusBranch draw className="text-eucalypt w-48" />
                    <h2 data-step-heading tabIndex={-1} className="wedding-display text-forest text-[3rem] leading-none outline-none sm:text-[3.5rem]">
                        Thank you
                    </h2>
                    <p className="wedding-display text-charcoal max-w-md text-[1.5rem] leading-snug">
                        {saved.length > 0
                            ? `We can't wait to celebrate with ${listNames(saved.map((g) => g.firstName))}.`
                            : stillToAnswer.length > 0
                              ? "Thank you for letting us know so far."
                              : "We'll miss you, and we're so grateful you let us know."}
                    </p>
                    <p className="text-[0.9375rem] text-tertiary">
                        Your RSVP has been saved
                        {confirmationSent && email ? `, and we've emailed a confirmation to ${email}` : ""}.
                        {!household.deadlinePassed && " You can come back and change it any time before the deadline using the same link or code."}
                    </p>
                    {stillToAnswer.length > 0 && !household.deadlinePassed && (
                        <p className="bg-eucalypt-light text-forest rounded-xl px-4 py-3 text-[0.9375rem]">
                            We still need an answer for {listNames(stillToAnswer.map((g) => g.firstName))}. Open your invitation again to finish
                            {deadline ? ` by ${longDate(deadline)}` : ""}.
                        </p>
                    )}
                </div>
                {summary(false)}
                <div className="flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
                    {saved.length > 0 && wedding.date && (
                        <Button
                            size="xl"
                            iconLeading={CalendarPlus01}
                            className={weddingButton.primary}
                            onClick={() => {
                                const site = `${window.location.origin}${homeHref}`.replace(/\/+$/, "");
                                downloadCalendarFile(
                                    icsFile(weddingCalendarEvent({ details: wedding, events: attendedEvents, site, description: `Details: ${site}` })!),
                                    icsFilename(wedding),
                                );
                            }}
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
                            {stillToAnswer.length > 0 ? "Finish our RSVP" : "Change our RSVP"}
                        </Button>
                    </div>
                )}
            </Card>
        </div>
    );
};
