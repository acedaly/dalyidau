// Form pieces for the guest RSVP flow: large, clear choices that work for every age group, styled
// to match the wedding stationery. Choice controls are React Aria radio groups, following the same
// pattern as Untitled UI's radio-group cards; text fields are Untitled UI's Input and TextArea.
import type { ReactNode } from "react";
import { Check, Minus, Plus } from "@untitledui/icons";
import {
    Button as AriaButton,
    Group as AriaGroup,
    Input as AriaInput,
    Label as AriaLabel,
    NumberField as AriaNumberField,
    Radio as AriaRadio,
    RadioGroup as AriaRadioGroup,
    Text as AriaText,
} from "react-aria-components";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { TextArea } from "@/components/base/textarea/textarea";
import type { AnswerValue, RsvpQuestion } from "@/shared/portal/types";
import { cx } from "@/utils/cx";

/** Shared styling for Untitled UI text fields inside the RSVP flow. */
export const fieldProps = {
    size: "lg" as const,
    wrapperClassName: "rounded-none bg-paper shadow-none ring-sandstone focus-within:ring-forest",
    inputClassName: "text-[1.0625rem] text-charcoal placeholder:text-tertiary/70",
};

export interface Choice {
    value: string;
    label: string;
    /** Shown instead of `label` on narrow phones, so a pair of choices fits side by side. */
    shortLabel?: string;
    tone?: "accept" | "decline" | "neutral";
}

/** Large stationery-style single choice (e.g. "Joyfully accepts" / "Regretfully declines"). */
export const ChoiceGroup = ({
    label,
    description,
    choices,
    value,
    onChange,
    invalid,
    isDisabled,
    hideLabel = false,
}: {
    label: string;
    description?: ReactNode;
    choices: Choice[];
    value: string | null;
    onChange: (value: string) => void;
    invalid?: boolean;
    isDisabled?: boolean;
    hideLabel?: boolean;
}) => (
    <AriaRadioGroup
        value={value}
        onChange={onChange}
        isDisabled={isDisabled}
        isInvalid={invalid}
        aria-label={hideLabel ? label : undefined}
        className="flex flex-col gap-3"
    >
        {!hideLabel && (
            <div className="flex flex-col gap-0.5">
                <AriaLabel className="text-charcoal text-[1.0625rem] font-medium">{label}</AriaLabel>
                {description && (
                    <AriaText slot="description" className="text-sm text-tertiary">
                        {description}
                    </AriaText>
                )}
            </div>
        )}
        <div className={cx("grid gap-3", choices.length === 2 ? "grid-cols-2" : "grid-cols-1 sm:grid-cols-2")}>
            {choices.map((choice) => (
                <AriaRadio
                    key={choice.value}
                    value={choice.value}
                    className={({ isSelected, isFocusVisible, isHovered, isDisabled: disabled }) =>
                        cx(
                            "relative flex min-h-16 cursor-pointer items-center gap-2.5 rounded-none px-4 py-3.5 text-[1rem] ring-1 transition duration-100 ease-linear ring-inset sm:gap-3 sm:px-5",
                            isSelected
                                ? choice.tone === "decline"
                                    ? "bg-sandstone-light text-forest ring-clay ring-2"
                                    : "bg-forest text-ivory ring-forest"
                                : cx("bg-paper text-charcoal", invalid ? "ring-clay" : "ring-sandstone", isHovered && "ring-forest/50"),
                            isFocusVisible && "outline-forest outline-2 outline-offset-2",
                            disabled && "cursor-not-allowed opacity-60",
                        )
                    }
                >
                    {({ isSelected }) => (
                        <>
                            <span
                                aria-hidden="true"
                                className={cx(
                                    "flex size-6 shrink-0 items-center justify-center rounded-full ring-1 ring-inset",
                                    isSelected
                                        ? choice.tone === "decline"
                                            ? "bg-clay text-ivory ring-clay"
                                            : "bg-ivory text-forest ring-ivory"
                                        : "ring-sandstone",
                                )}
                            >
                                {isSelected && <Check className="size-4" strokeWidth={2.5} />}
                            </span>
                            {choice.shortLabel ? (
                                <>
                                    <span className="font-medium sm:hidden">{choice.shortLabel}</span>
                                    <span className="font-medium max-sm:hidden">{choice.label}</span>
                                </>
                            ) : (
                                <span className="font-medium">{choice.label}</span>
                            )}
                        </>
                    )}
                </AriaRadio>
            ))}
        </div>
    </AriaRadioGroup>
);

/** One configured RSVP question, rendered with the right control for its type. */
export const QuestionField = ({
    question,
    value,
    onChange,
    error,
    idPrefix,
}: {
    question: RsvpQuestion;
    value: AnswerValue | undefined;
    onChange: (value: AnswerValue) => void;
    error?: string;
    idPrefix: string;
}) => {
    const label = question.label;
    const hint = error ?? question.help ?? (question.required ? undefined : "Optional");
    if (question.type === "long_text")
        return (
            <TextArea
                label={label}
                isRequired={question.required}
                hint={hint}
                isInvalid={!!error}
                rows={4}
                value={typeof value === "string" ? value : ""}
                onChange={onChange}
                textAreaClassName="rounded-[2px] bg-paper text-[1.0625rem] ring-sandstone"
            />
        );
    if (question.type === "short_text" || question.type === "number" || question.type === "date")
        return (
            <Input
                {...fieldProps}
                label={label}
                isRequired={question.required}
                hint={hint}
                isInvalid={!!error}
                type={question.type === "short_text" ? "text" : question.type}
                inputMode={question.type === "number" ? "numeric" : undefined}
                value={value === undefined ? "" : String(value)}
                onChange={(next) => onChange(question.type === "number" && next !== "" ? Number(next) : next)}
            />
        );
    if (question.type === "multiple_choice") {
        const selected = Array.isArray(value) ? value : [];
        return (
            <fieldset className="flex flex-col gap-3" aria-describedby={hint ? `${idPrefix}-${question.id}-hint` : undefined}>
                <legend className="text-charcoal mb-1 text-[1.0625rem] font-medium">
                    {label}
                    {question.required && <span className="text-clay-600"> *</span>}
                </legend>
                {hint && (
                    <p id={`${idPrefix}-${question.id}-hint`} className={cx("-mt-2 text-sm", error ? "text-error-primary" : "text-tertiary")}>
                        {hint}
                    </p>
                )}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {question.options.map((option) => (
                        <div key={option} className="bg-paper ring-sandstone rounded-[2px] px-4 py-3.5 ring-1 ring-inset">
                            <Checkbox
                                size="md"
                                label={option}
                                isSelected={selected.includes(option)}
                                onChange={(checked) => onChange(checked ? [...selected, option] : selected.filter((item) => item !== option))}
                            />
                        </div>
                    ))}
                </div>
            </fieldset>
        );
    }
    const options = question.type === "yes_no" ? ["yes", "no"] : question.options;
    return (
        <div className="flex flex-col gap-1">
            <ChoiceGroup
                label={question.required ? `${label} *` : label}
                description={hint && !error ? hint : undefined}
                invalid={!!error}
                value={typeof value === "string" ? value : null}
                onChange={onChange}
                choices={options.map((option) => ({
                    value: option,
                    label: question.type === "yes_no" ? (option === "yes" ? "Yes" : "No") : option,
                }))}
            />
            {error && <p className="text-sm text-error-primary">{error}</p>}
        </div>
    );
};

/** A whole-number stepper (e.g. bus passengers) with large −/+ buttons for phones. */
export const CountField = ({
    label,
    description,
    value,
    min,
    max,
    onChange,
}: {
    label: string;
    description?: ReactNode;
    value: number;
    min: number;
    max: number;
    onChange: (value: number) => void;
}) => {
    const step = cx(
        "bg-paper text-forest ring-sandstone flex size-14 shrink-0 cursor-pointer items-center justify-center ring-1 transition duration-100 ease-linear ring-inset",
        "hover:ring-forest/50 focus-visible:outline-forest focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
    );
    return (
        <AriaNumberField
            value={value}
            minValue={min}
            maxValue={max}
            step={1}
            onChange={(next) => onChange(Number.isFinite(next) ? Math.round(next) : min)}
            formatOptions={{ maximumFractionDigits: 0 }}
            className="flex flex-col gap-3"
        >
            <div className="flex flex-col gap-0.5">
                <AriaLabel className="text-charcoal text-[1.0625rem] font-medium">{label}</AriaLabel>
                {description && (
                    <AriaText slot="description" className="text-sm text-tertiary">
                        {description}
                    </AriaText>
                )}
            </div>
            <AriaGroup className="flex items-stretch gap-2 self-start">
                <AriaButton slot="decrement" className={step}>
                    <Minus className="size-5" aria-hidden="true" />
                </AriaButton>
                <AriaInput
                    inputMode="numeric"
                    className="text-forest bg-paper ring-sandstone focus:ring-forest w-20 text-center text-[1.375rem] font-medium tabular-nums ring-1 outline-none ring-inset focus:ring-2"
                />
                <AriaButton slot="increment" className={step}>
                    <Plus className="size-5" aria-hidden="true" />
                </AriaButton>
            </AriaGroup>
        </AriaNumberField>
    );
};

/** "1 · Who's coming  2 · Details  3 · Review" with the current step emphasised. */
export const StepIndicator = ({ steps, current }: { steps: string[]; current: number }) => (
    <ol className="border-sandstone/80 flex w-full items-center justify-center gap-2 border-y py-4 sm:gap-4" aria-label="RSVP progress">
        {steps.map((step, i) => {
            const state = i < current ? "done" : i === current ? "current" : "upcoming";
            return (
                <li key={step} className="flex items-center gap-2 sm:gap-4" aria-current={state === "current" ? "step" : undefined}>
                    <span className="flex items-center gap-2">
                        <span
                            className={cx(
                                "flex size-7 items-center justify-center rounded-full text-xs font-medium ring-1 ring-inset",
                                state === "current" && "bg-leaf text-ivory ring-leaf",
                                state === "done" && "bg-eucalypt-light text-forest ring-eucalypt",
                                state === "upcoming" && "ring-sandstone text-tertiary",
                            )}
                        >
                            {state === "done" ? <Check className="size-3.5" strokeWidth={2.5} aria-hidden="true" /> : i + 1}
                        </span>
                        <span className={cx("wedding-eyebrow text-[0.625rem]", state === "current" ? "text-forest" : "text-tertiary", "max-[400px]:sr-only")}>
                            {step}
                            {state === "done" && <span className="sr-only"> (done)</span>}
                        </span>
                    </span>
                    {i < steps.length - 1 && <span aria-hidden="true" className="bg-sandstone h-px w-5 sm:w-10" />}
                </li>
            );
        })}
    </ol>
);

/** A paper card with a fine double rule, used for each step of the flow. */
export const Card = ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={cx("bg-paper border-forest/15 border shadow-[0_28px_70px_-42px_rgb(82_32_38/0.35)]", className)}>
        <div className="border-sandstone/80 m-1.5 flex flex-col gap-8 border px-5 pt-8 pb-[calc(2rem+env(safe-area-inset-bottom))] sm:m-2 sm:px-10 sm:py-11">
            {children}
        </div>
    </div>
);
