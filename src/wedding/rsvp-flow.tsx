// The native RSVP form: enter the household code, answer for each person and event, confirm.
// In the portal preview it talks to the owners-only test endpoints, so it can be tried before the
// "rsvp.native" flag is turned on.
import { useEffect, useState } from "react";
import { ArrowLeft, CheckCircle } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { RadioButton, RadioGroup } from "@/components/base/radio-buttons/radio-buttons";
import { TextArea } from "@/components/base/textarea/textarea";
import { formatDate, formatTime } from "@/portal/lib/format";
import { questionApplies } from "@/shared/portal/rsvp-questions";
import type { AnswerValue, RsvpHousehold, RsvpQuestion } from "@/shared/portal/types";
import { Sprig } from "@/wedding/components/ornament";

type Answers = Record<string, { events: Record<string, "attending" | "declined" | undefined>; dietary: string }>;
type QuestionAnswers = { household: Record<string, AnswerValue>; guests: Record<string, Record<string, AnswerValue>> };

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
        throw new Error("We couldn't reach the server. Check your connection and try again.");
    }
    const data = (await response.json().catch(() => ({}))) as { message?: string };
    if (!response.ok) throw new Error(data.message ?? "Something went wrong. Please try again.");
    return data as T;
}

const QuestionField = ({ question, value, onChange }: { question: RsvpQuestion; value: AnswerValue | undefined; onChange: (value: AnswerValue) => void }) => {
    const label = `${question.label}${question.required ? " *" : ""}`;
    if (question.type === "long_text")
        return <TextArea label={label} hint={question.help ?? undefined} rows={4} value={typeof value === "string" ? value : ""} onChange={onChange} />;
    if (question.type === "short_text" || question.type === "number" || question.type === "date")
        return (
            <Input
                label={label}
                hint={question.help ?? undefined}
                type={question.type === "short_text" ? "text" : question.type}
                value={value === undefined ? "" : String(value)}
                onChange={(next) => onChange(question.type === "number" && next !== "" ? Number(next) : next)}
            />
        );
    if (question.type === "multiple_choice") {
        const selected = Array.isArray(value) ? value : [];
        return (
            <fieldset className="flex flex-col gap-3">
                <legend className="text-sm font-medium text-secondary">{label}</legend>
                {question.help && <p className="text-sm text-tertiary">{question.help}</p>}
                {question.options.map((option) => (
                    <Checkbox
                        key={option}
                        size="md"
                        label={option}
                        isSelected={selected.includes(option)}
                        onChange={(checked) => onChange(checked ? [...selected, option] : selected.filter((item) => item !== option))}
                    />
                ))}
            </fieldset>
        );
    }
    const options = question.type === "yes_no" ? ["yes", "no"] : question.options;
    return (
        <RadioGroup
            aria-label={question.label}
            value={typeof value === "string" ? value : null}
            onChange={(next) => onChange(String(next))}
            className="flex flex-col gap-3"
        >
            <div>
                <p className="text-sm font-medium text-secondary">{label}</p>
                {question.help && <p className="text-sm text-tertiary">{question.help}</p>}
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:gap-x-6">
                {options.map((option) => (
                    <RadioButton key={option} value={option} label={question.type === "yes_no" ? (option === "yes" ? "Yes" : "No") : option} size="md" />
                ))}
            </div>
        </RadioGroup>
    );
};

export const RsvpFlow = ({ apiBase, deadline }: { apiBase: string; deadline: string | null }) => {
    const [code, setCode] = useState("");
    const [household, setHousehold] = useState<RsvpHousehold | null>(null);
    const [answers, setAnswers] = useState<Answers>({});
    const [questionAnswers, setQuestionAnswers] = useState<QuestionAnswers>({ household: {}, guests: {} });
    const [token, setToken] = useState<string | null>(null);
    const [clientId, setClientId] = useState(() => crypto.randomUUID());
    const [message, setMessage] = useState("");
    const [email, setEmail] = useState("");
    const [step, setStep] = useState<"code" | "form" | "done">("code");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const openInvitation = async (credential: { code?: string; token?: string }) => {
        setBusy(true);
        setError(null);
        try {
            const { household: found } = await post<{ household: RsvpHousehold }>(`${apiBase}/lookup`, credential);
            setHousehold(found);
            setAnswers(answersFrom(found));
            setQuestionAnswers(found.answers);
            setStep("form");
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(false);
        }
    };

    // Signed invitation links open directly; short codes remain available only when enabled in settings.
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const invite = params.get("invite");
        const fromLink = params.get("code");
        if (invite) {
            setToken(invite);
            void openInvitation({ token: invite });
        } else if (fromLink) setCode(fromLink.toUpperCase());
        // The URL credential is immutable for this mounted flow.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const lookup = async () => {
        await openInvitation({ code });
    };

    const complete = household?.guests.every((g) => Object.keys(household.responses[g.id] ?? {}).every((eventId) => answers[g.id]?.events[eventId])) ?? false;

    const submit = async () => {
        if (!household) return;
        if (!complete) {
            setError("Please answer for everyone before sending.");
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const { household: updated } = await post<{ household: RsvpHousehold }>(`${apiBase}/submit`, {
                ...(token ? { token } : { code }),
                clientId,
                guests: household.guests.map((g) => ({
                    guestId: g.id,
                    events: answers[g.id].events,
                    ...(household.collectDietary ? { dietary: answers[g.id].dietary } : {}),
                })),
                message: household.collectMessage ? message : null,
                email,
                answers: questionAnswers,
            });
            setHousehold(updated);
            setClientId(crypto.randomUUID());
            setStep("done");
            window.scrollTo({ top: 0, behavior: "smooth" });
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(false);
        }
    };

    const errorBox = error && (
        <p role="alert" className="bg-clay-50 text-clay-700 ring-clay-200 rounded-lg px-4 py-3 text-sm ring-1">
            {error}
        </p>
    );

    const appliesToGuest = (question: RsvpQuestion, guest: RsvpHousehold["guests"][number]) =>
        questionApplies(question, {
            ageGroup: guest.ageGroup,
            attending: (eventId) => answers[guest.id]?.events[eventId] === "attending",
            answerTo: (questionId) => questionAnswers.guests[guest.id]?.[questionId],
        });
    const appliesToHousehold = (question: RsvpQuestion) =>
        questionApplies(question, {
            ageGroup: null,
            attending: (eventId) => household?.guests.some((guest) => answers[guest.id]?.events[eventId] === "attending") ?? false,
            answerTo: (questionId) => questionAnswers.household[questionId],
        });

    if (step === "code" || !household) {
        return (
            <form
                className="mx-auto flex w-full max-w-md flex-col gap-5"
                onSubmit={(e) => {
                    e.preventDefault();
                    void lookup();
                }}
            >
                <p className="text-center text-lg text-secondary">Enter the code from your invitation to reply for everyone in your party.</p>
                {deadline && (
                    <p className="text-center text-sm text-tertiary">
                        Kindly reply by {formatDate(deadline, { day: "numeric", month: "long", year: "numeric" })}.
                    </p>
                )}
                {errorBox}
                <Input
                    label="RSVP code"
                    size="md"
                    isRequired
                    autoComplete="off"
                    placeholder="e.g. K7MXQ4RD"
                    value={code}
                    onChange={(v) => setCode(v.toUpperCase())}
                    inputClassName="font-mono tracking-[0.2em] uppercase"
                />
                <Button type="submit" size="xl" isLoading={busy} showTextWhileLoading isDisabled={code.replace(/[^A-Z0-9]/gi, "").length < 6}>
                    Find my invitation
                </Button>
            </form>
        );
    }

    if (step === "done") {
        const coming = household.guests.filter((g) => Object.values(household.responses[g.id] ?? {}).some((s) => s === "attending"));
        return (
            <div className="mx-auto flex max-w-lg flex-col items-center gap-5 text-center" role="status">
                <CheckCircle className="size-10 text-brand-600" aria-hidden="true" />
                <h2 className="wedding-display text-display-sm text-primary">Thank you</h2>
                <p className="text-lg text-secondary">
                    {coming.length > 0
                        ? `We can't wait to celebrate with ${coming.map((g) => g.firstName).join(coming.length > 2 ? ", " : " and ")}.`
                        : "We'll miss you, and we're grateful you let us know."}
                </p>
                <Sprig />
                <Button color="secondary" onClick={() => setStep("form")} isDisabled={household.deadlinePassed}>
                    Change our reply
                </Button>
            </div>
        );
    }

    return (
        <form
            noValidate
            className="mx-auto flex w-full max-w-2xl flex-col gap-8"
            onSubmit={(e) => {
                e.preventDefault();
                void submit();
            }}
        >
            <div className="flex flex-col items-center gap-2 text-center">
                <p className="text-sm tracking-[0.2em] text-tertiary uppercase">Replying for</p>
                <h2 className="wedding-display text-display-sm text-primary">{household.householdName}</h2>
                {household.deadlinePassed && (
                    <p className="text-clay-700 text-sm">Replies have closed, so this can't be changed online. Please contact us directly.</p>
                )}
            </div>

            <fieldset disabled={household.deadlinePassed} className="flex flex-col gap-6">
                {household.guests.map((guest) => (
                    <section
                        key={guest.id}
                        aria-labelledby={`guest-${guest.id}`}
                        className="flex flex-col gap-5 rounded-2xl bg-primary p-5 shadow-xs ring-1 ring-secondary sm:p-6"
                    >
                        <h3 id={`guest-${guest.id}`} className="wedding-display text-xl text-primary">
                            {guest.firstName} {guest.lastName}
                        </h3>
                        {household.events
                            .filter((event) => event.id in (household.responses[guest.id] ?? {}))
                            .map((event) => (
                                <RadioGroup
                                    key={event.id}
                                    aria-label={`${guest.firstName}: ${event.name}`}
                                    value={answers[guest.id]?.events[event.id] ?? null}
                                    onChange={(value) =>
                                        setAnswers({
                                            ...answers,
                                            [guest.id]: {
                                                ...answers[guest.id],
                                                events: { ...answers[guest.id].events, [event.id]: value as "attending" | "declined" },
                                            },
                                        })
                                    }
                                    className="flex flex-col gap-3"
                                >
                                    <div>
                                        <p className="font-semibold text-secondary">{event.name}</p>
                                        {event.startsAt && (
                                            <p className="text-sm text-tertiary">
                                                {formatDate(event.startsAt.slice(0, 10), { weekday: "long", day: "numeric", month: "long" })} ·{" "}
                                                {formatTime(event.startsAt)}
                                                {event.venueName && ` · ${event.venueName}`}
                                            </p>
                                        )}
                                    </div>
                                    <div className="flex flex-wrap gap-x-6 gap-y-3">
                                        <RadioButton value="attending" label="Joyfully accepts" size="md" />
                                        <RadioButton value="declined" label="Regretfully declines" size="md" />
                                    </div>
                                </RadioGroup>
                            ))}
                        {household.collectDietary && (
                            <Input
                                label="Dietary requirements"
                                placeholder="Leave blank if none"
                                value={answers[guest.id]?.dietary ?? ""}
                                onChange={(v) => setAnswers({ ...answers, [guest.id]: { ...answers[guest.id], dietary: v } })}
                            />
                        )}
                        {household.questions
                            .filter((question) => question.scope === "guest" && appliesToGuest(question, guest))
                            .map((question) => (
                                <QuestionField
                                    key={question.id}
                                    question={question}
                                    value={questionAnswers.guests[guest.id]?.[question.id]}
                                    onChange={(value) =>
                                        setQuestionAnswers({
                                            ...questionAnswers,
                                            guests: {
                                                ...questionAnswers.guests,
                                                [guest.id]: { ...questionAnswers.guests[guest.id], [question.id]: value },
                                            },
                                        })
                                    }
                                />
                            ))}
                    </section>
                ))}

                {household.questions.some((question) => question.scope === "household" && appliesToHousehold(question)) && (
                    <section
                        aria-labelledby="household-questions"
                        className="flex flex-col gap-5 rounded-2xl bg-primary p-5 shadow-xs ring-1 ring-secondary sm:p-6"
                    >
                        <h3 id="household-questions" className="wedding-display text-xl text-primary">
                            For your party
                        </h3>
                        {household.questions
                            .filter((question) => question.scope === "household" && appliesToHousehold(question))
                            .map((question) => (
                                <QuestionField
                                    key={question.id}
                                    question={question}
                                    value={questionAnswers.household[question.id]}
                                    onChange={(value) =>
                                        setQuestionAnswers({
                                            ...questionAnswers,
                                            household: { ...questionAnswers.household, [question.id]: value },
                                        })
                                    }
                                />
                            ))}
                    </section>
                )}

                {household.collectMessage && <TextArea label="A note for us (optional)" rows={4} value={message} onChange={setMessage} />}
                <Input
                    label="Email for updates (optional)"
                    type="email"
                    hint="So we can send you details closer to the day."
                    value={email}
                    onChange={setEmail}
                />
            </fieldset>

            {errorBox}
            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
                <Button
                    color="tertiary"
                    iconLeading={ArrowLeft}
                    onClick={() => {
                        setToken(null);
                        setHousehold(null);
                        setStep("code");
                    }}
                >
                    Use a different code
                </Button>
                {!household.deadlinePassed && (
                    <Button type="submit" size="xl" isLoading={busy} showTextWhileLoading>
                        Send our reply
                    </Button>
                )}
            </div>
        </form>
    );
};
