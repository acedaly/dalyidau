/** Constant-time check of an "Authorization: Bearer …" header against a secret of at least 24 characters. */
export async function bearerMatches(header: string | null, expected: string | undefined): Promise<boolean> {
    if (!expected || expected.length < 24 || !header?.startsWith("Bearer ")) return false;
    const encoder = new TextEncoder();
    const [a, b] = await Promise.all([
        crypto.subtle.digest("SHA-256", encoder.encode(header.slice(7))),
        crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    ]);
    const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean };
    if (subtle.timingSafeEqual) return subtle.timingSafeEqual(a, b);
    const x = new Uint8Array(a);
    const y = new Uint8Array(b);
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
    return diff === 0;
}
