// The mobile number field used wherever a guest or household number is entered. It explains the
// expected format, checks the number once the person leaves the field (with the same rules the
// Worker applies), and shows the E.164 form it will be saved in. The Worker does the normalising.
import { useEffect, useState } from "react";
import { Input } from "@/components/base/input/input";
import { MOBILE_HINT, MOBILE_LABEL, MOBILE_PLACEHOLDER, parseMobile } from "@/shared/portal/phone";

interface MobileInputProps {
    value: string;
    onChange: (value: string) => void;
    /** The value as stored, so an untouched legacy number is flagged without blocking the save. */
    savedValue?: string | null;
    /** An error from the server. Shown, ahead of anything else, until the value is changed. */
    error?: string;
    label?: string;
    isDisabled?: boolean;
}

export const MobileInput = ({ value, onChange, savedValue, error, label = MOBILE_LABEL, isDisabled }: MobileInputProps) => {
    const [touched, setTouched] = useState(false);
    // The value the server refused, so its error doesn't linger once the number is corrected.
    const [refused, setRefused] = useState<string | null>(null);
    useEffect(() => setRefused(error ? value : null), [error]); // eslint-disable-line react-hooks/exhaustive-deps
    const serverError = error && (refused === null || refused === value) ? error : undefined;
    const trimmed = value.trim();
    const result = trimmed ? parseMobile(trimmed) : null;
    const untouchedLegacy = !!savedValue && value === savedValue && result !== null && !result.ok;

    let hint: string = MOBILE_HINT;
    let isInvalid = false;
    if (serverError) {
        hint = serverError;
        isInvalid = true;
    } else if (untouchedLegacy) {
        hint = "This saved number isn't a valid mobile, so it can't be texted. Correct it or clear it.";
        isInvalid = true;
    } else if (result && !result.ok && touched) {
        hint = result.message;
        isInvalid = true;
    } else if (result?.ok && result.e164 !== trimmed) {
        hint = `Will be saved as ${result.e164}.`;
    }

    return (
        <Input
            label={label}
            type="tel"
            autoComplete="tel"
            inputMode="tel"
            placeholder={MOBILE_PLACEHOLDER}
            value={value}
            onChange={(v) => {
                onChange(v);
                if (!v.trim()) setTouched(false);
            }}
            onBlur={() => setTouched(true)}
            isInvalid={isInvalid}
            isDisabled={isDisabled}
            hint={hint}
        />
    );
};
