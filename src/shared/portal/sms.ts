// Phone numbers and SMS length, shared by the worker and the portal so both agree on what can be texted.

/**
 * Normalises a number for SMS to E.164 (+61412345678). Australian mobiles may be written locally
 * (0412 345 678); other countries need a leading +. Landlines and anything ambiguous return null.
 */
export function normaliseMobile(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const trimmed = raw.trim();
    const digits = trimmed.replace(/[^\d]/g, "");
    if (trimmed.startsWith("+")) {
        if (digits.startsWith("61")) return /^614\d{8}$/.test(digits) ? `+${digits}` : null;
        return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
    }
    if (/^04\d{8}$/.test(digits)) return `+61${digits.slice(1)}`;
    if (/^614\d{8}$/.test(digits)) return `+${digits}`;
    if (/^4\d{8}$/.test(digits)) return `+61${digits}`;
    return null;
}

// Characters in the GSM 03.38 default alphabet (plus its extension table, which costs two).
const GSM = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED = "^{}\\[~]|€";

/** How many SMS parts a message needs. Curly quotes or emoji switch the whole message to Unicode. */
export function smsSegments(text: string): { encoding: "gsm" | "unicode"; length: number; segments: number } {
    let gsmLength = 0;
    let unicode = false;
    for (const char of text) {
        if (GSM.includes(char)) gsmLength += 1;
        else if (GSM_EXTENDED.includes(char)) gsmLength += 2;
        else {
            unicode = true;
            break;
        }
    }
    if (!unicode) return { encoding: "gsm", length: gsmLength, segments: gsmLength <= 160 ? 1 : Math.ceil(gsmLength / 153) };
    const length = [...text].reduce((n, char) => n + (char.codePointAt(0)! > 0xffff ? 2 : 1), 0);
    return { encoding: "unicode", length, segments: length <= 70 ? 1 : Math.ceil(length / 67) };
}

/** Replies that mean "stop texting me" (case-insensitive, whole message). */
export const isOptOutReply = (body: string) => /^\s*(stop|stop all|unsubscribe|opt out|optout|cancel|end|quit)\s*[.!]?\s*$/i.test(body);
