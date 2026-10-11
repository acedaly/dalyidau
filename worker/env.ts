import type { D1Database, Fetcher, R2Bucket } from "@cloudflare/workers-types";

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
}
