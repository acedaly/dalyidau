// SMS length and opt-out replies, shared by the worker and the portal. Mobile numbers live in phone.ts.

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
