const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-src https://www.youtube-nocookie.com https://player.vimeo.com",
    "media-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
].join("; ");

export const SECURITY_HEADERS: Record<string, string> = {
    "Content-Security-Policy": CSP,
    "Strict-Transport-Security": "max-age=31536000",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=(), browsing-topics=()",
    "Cross-Origin-Opener-Policy": "same-origin",
};

export const withSecurityHeaders = (response: Response): Response => {
    const res = new Response(response.body, response);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        // Pages opened from a signed link ask for no referrer at all; keep that stricter policy.
        if (name === "Referrer-Policy" && res.headers.get(name) === "no-referrer") continue;
        // Downloads sandbox themselves with a stricter policy than pages need; keep it.
        if (name === "Content-Security-Policy" && /\bsandbox\b/.test(res.headers.get(name) ?? "")) continue;
        res.headers.set(name, value);
    }
    return res;
};
