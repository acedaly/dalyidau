import type { D1Database, Fetcher, R2Bucket, SendEmail } from "@cloudflare/workers-types";
import type { AiBinding, VectorIndex } from "./intelligence/bindings";

export interface Env {
    DB: D1Database;
    MEDIA: R2Bucket;
    ASSETS: Fetcher;

    ENVIRONMENT: string;
    SITE_URL: string;
    /** Canonical public wedding origin. */
    WEDDING_URL?: string;
    CAPACITIES_API_BASE: string;
    CAPACITIES_STRUCTURE_NAME: string;
    /** Optional: pin the Blog Post type by id instead of by name. */
    CAPACITIES_STRUCTURE_ID?: string;
    SYNC_MAX_REQUESTS: string;
    SYNC_REQUEST_SPACING_MS: string;
    IMAGE_TRANSFORMS: string;

    // Secrets (wrangler secret put …)
    CAPACITIES_API_TOKEN?: string;
    ADMIN_TOKEN?: string;

    // Portal (see docs/PORTAL.md). Without ACCESS_TEAM_DOMAIN and ACCESS_AUD every portal request is refused.
    /** e.g. "daly.cloudflareaccess.com" */
    ACCESS_TEAM_DOMAIN?: string;
    /** Application Audience (AUD) tag(s) of the Access application, comma-separated. */
    ACCESS_AUD?: string;
    /** Comma-separated emails that always have the owner role. */
    PORTAL_OWNER_EMAILS?: string;
    /** Local development only (ENVIRONMENT=development on localhost): act as this email without Access. */
    ACCESS_DEV_EMAIL?: string;
    /** Local development only: a second identity, chosen with the portal_dev_identity=alt cookie (browser tests). */
    ACCESS_DEV_ALT_EMAIL?: string;
    /**
     * AUD tag of the separate Access application in front of mcp.daly.id.au (the MCP gateway).
     * PortalMcpEntrypoint accepts only tokens for this audience; without it every MCP call is refused.
     */
    MCP_ACCESS_AUD?: string;
    /** Tests only, ignored in production: a JWKS document to verify Access tokens against. */
    ACCESS_TEST_JWKS?: string;
    /** Email delivery provider: "fastmail", "smtp", "smtp2go", "cloudflare", or "log" (development only). */
    EMAIL_DELIVERY?: string;
    /** From address for wedding emails, e.g. "Amelia & Aidan" <wedding@daly.id.au>. */
    EMAIL_FROM?: string;
    /** Optional Reply-To for wedding emails. */
    EMAIL_REPLY_TO?: string;
    /** Secret: SMTP2Go API key (send-only permissions). */
    SMTP2GO_API_KEY?: string;
    /** Optional, e.g. https://au-api.smtp2go.com/v3 for the Australian region. */
    SMTP2GO_API_BASE?: string;
    /** Secret Fastmail JMAP API token with the Email Submission scope. */
    FASTMAIL_API_TOKEN?: string;
    /** Optional override for tests; defaults to Fastmail's official session endpoint. */
    FASTMAIL_SESSION_URL?: string;
    /** Generic authenticated SMTP. Password is always a Worker secret. */
    SMTP_HOST?: string;
    SMTP_PORT?: string;
    SMTP_USERNAME?: string;
    SMTP_PASSWORD?: string;
    SMTP_SECURITY?: string;
    /** SMS delivery provider: "clicksend", or "log" (development only). Unset or "off" means nothing is ever sent. */
    SMS_DELIVERY?: string;
    /** Secret: ClickSend API username. */
    CLICKSEND_USERNAME?: string;
    /** Secret: ClickSend API key. */
    CLICKSEND_API_KEY?: string;
    /** Optional, for tests. */
    CLICKSEND_API_BASE?: string;
    /** Sender: a dedicated number in E.164 (needed for two-way replies) or a registered alphanumeric sender ID. */
    SMS_FROM?: string;
    /** Secret: the path segment that authenticates provider webhooks (/api/comms/webhooks/<provider>/<secret>). */
    COMMS_WEBHOOK_SECRET?: string;
    /** Optional Cloudflare Email Service binding. Add it only after the sending domain is approved. */
    EMAIL?: SendEmail;
    /** "on" enables the owner-only DalyHub migration routes (docs/DALYHUB_MIGRATION.md). Off when unset. */
    DALYHUB_MIGRATION?: string;
    /** HMAC key for long, revocable native RSVP invitation links. */
    RSVP_LINK_SECRET?: string;

    // Daly Intelligence (docs/INTELLIGENCE.md). Neither binding is in wrangler.jsonc yet: until the
    // owner adds them, every AI feature reports itself unavailable and nothing is called or billed.
    /** Workers AI. */
    AI?: AiBinding;
    /** Vectorize index for semantic Knowledge search (one namespace per Knowledge space). */
    VECTORS?: VectorIndex;
    /** Optional AI Gateway id. Calls then go through the gateway for analytics; turn its log collection off. */
    AI_GATEWAY_ID?: string;
    /** Local development and browser tests only: "mock" answers with deterministic local responses instead of Workers AI. */
    AI_PROVIDER?: string;
}
