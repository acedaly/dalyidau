// A labelled date field on Untitled UI's DatePicker. Values are "YYYY-MM-DD" strings. The picker
// edits a draft: Apply commits it, Cancel puts the previous value back.
import { useState } from "react";
import { type CalendarDate, parseDate } from "@internationalized/date";
import { DatePicker } from "@/components/application/date-picker/date-picker";
import { Button } from "@/components/base/buttons/button";
import { HintText } from "@/components/base/input/hint-text";
import { Label } from "@/components/base/input/label";

interface DateFieldProps {
    label: string;
    value: string | null;
    onChange: (value: string | null) => void;
    hint?: string;
    error?: string;
    isRequired?: boolean;
    isDisabled?: boolean;
}

const toDate = (value: string | null): CalendarDate | null => {
    if (!value) return null;
    try {
        return parseDate(value);
    } catch {
        return null;
    }
};

export const DateField = ({ label, value, onChange, hint, error, isRequired, isDisabled }: DateFieldProps) => {
    const [draft, setDraft] = useState<CalendarDate | null>(toDate(value));
    return (
        <div className="flex flex-col gap-1.5">
            <Label isRequired={isRequired}>{label}</Label>
            <div className="flex items-center gap-2">
                <DatePicker
                    aria-label={label}
                    size="md"
                    isDisabled={isDisabled}
                    value={draft}
                    onChange={(next) => setDraft(next as CalendarDate | null)}
                    onApply={() => onChange(draft ? draft.toString() : null)}
                    onCancel={() => setDraft(toDate(value))}
                />
                {value && !isDisabled && (
                    <Button
                        size="sm"
                        color="link-gray"
                        onClick={() => {
                            setDraft(null);
                            onChange(null);
                        }}
                    >
                        Clear
                    </Button>
                )}
            </div>
            {(error || hint) && <HintText isInvalid={!!error}>{error ?? hint}</HintText>}
        </div>
    );
};
