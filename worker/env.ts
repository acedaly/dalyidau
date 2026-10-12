import type { D1Database, Fetcher, R2Bucket, SendEmail } from "@cloudflare/workers-types";

export interface Env {
    DB: D1Database;
    MEDIA: R2Bucket;
    ASSETS: Fetcher;

    ENVIRONMENT: string;
    SITE_URL: string;
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
    /** Tests only, ignored in production: a JWKS document to verify Access tokens against. */
    ACCESS_TEST_JWKS?: string;
    /** Email delivery provider. Unset or "off" means nothing is ever sent. See docs/PORTAL.md. */
    EMAIL_DELIVERY?: string;
    /** From address for wedding emails once delivery is configured. */
    EMAIL_FROM?: string;
    /** Optional Cloudflare Email Service binding. Add it only after the sending domain is approved. */
    EMAIL?: SendEmail;
    /** HMAC key for long, revocable native RSVP invitation links. */
    RSVP_LINK_SECRET?: string;
}
