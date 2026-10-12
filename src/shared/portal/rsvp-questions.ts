// Which RSVP questions apply to whom, and whether an answer is valid. Shared by the guest-facing
// form and the server, so they can never disagree.
import type { AgeGroup, AnswerValue, QuestionType, RsvpQuestion } from "./types";

export interface QuestionContext {
    ageGroup: AgeGroup | null; // null for household-level questions
    /** eventId → the answer given for this guest (or anyone in the household, for household questions). */
    attending: (eventId: string) => boolean;
    /** The current answer to another question in the same scope. */
    answerTo: (questionId: string) => AnswerValue | undefined;
}

export const answerText = (value: AnswerValue | undefined): string => {
    if (value === undefined || value === null) return "";
    if (Array.isArray(value)) return value.join(", ");
    if (typeof value === "boolean") return value ? "yes" : "no";
    return String(value);
};

/** Whether a question should be asked in this context. */
export function questionApplies(question: Pick<RsvpQuestion, "scope" | "audience" | "eventId" | "condition">, ctx: QuestionContext): boolean {
    if (question.scope === "guest" && question.audience !== "all") {
        const isAdult = ctx.ageGroup === "adult";
        if (question.audience === "adult" ? !isAdult : isAdult) return false;
    }
    if (question.eventId && !ctx.attending(question.eventId)) return false;
    if (question.condition) {
        const answer = ctx.answerTo(question.condition.questionId);
        const values = Array.isArray(answer) ? answer : [answerText(answer)];
        if (!values.some((v) => v.toLowerCase() === question.condition!.equals.toLowerCase())) return false;
    }
    return true;
}

const empty = (value: AnswerValue | undefined) => value === undefined || value === "" || (Array.isArray(value) && value.length === 0);

/** Normalises an answer, or returns an error message. Empty answers are null (and only fail when required). */
export function validateAnswer(
    question: Pick<RsvpQuestion, "type" | "options" | "required" | "label">,
    value: unknown,
): { value: AnswerValue | null } | { error: string } {
    if (empty(value as AnswerValue)) return question.required ? { error: `“${question.label}” needs an answer` } : { value: null };
    const type: QuestionType = question.type;
    switch (type) {
        case "short_text":
        case "long_text": {
            if (typeof value !== "string") return { error: "Expected text" };
            const max = type === "short_text" ? 200 : 2000;
            return value.trim().length > max ? { error: `Keep it under ${max} characters` } : { value: value.trim() };
        }
        case "yes_no":
            if (value === true || value === "yes") return { value: "yes" };
            if (value === false || value === "no") return { value: "no" };
            return { error: "Choose yes or no" };
        case "single_choice":
            return typeof value === "string" && question.options.includes(value) ? { value } : { error: "Choose one of the options" };
        case "multiple_choice":
            return Array.isArray(value) && value.every((v) => typeof v === "string" && question.options.includes(v))
                ? { value: [...new Set(value as string[])] }
                : { error: "Choose from the options" };
        case "number": {
            const n = typeof value === "number" ? value : Number(value);
            return Number.isFinite(n) && n >= 0 && n <= 1000 ? { value: n } : { error: "Enter a number from 0 to 1000" };
        }
        case "date":
            return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? { value } : { error: "Enter a date" };
    }
}
