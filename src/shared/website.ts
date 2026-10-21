// What Portal settings → Website & Blog shows: Amplenote publishing (worker/amplenote/api.ts) and
// the retired Capacities integration (worker/capacities/archive.ts). Never holds credentials: only
// whether each one is configured.

export interface AmplenoteArticleStatus {
    uuid: string;
    /** Null for a tagged note that has never been published: its title is never stored. */
    title: string | null;
    slug: string | null;
    state: "pending" | "published" | "withdrawn";
    reason: string | null;
    linkStatus: string | null;
    pluginSeenAt: string | null;
    restSeenAt: string | null;
    updatedAt: string;
    /**
     * A note that takes over a Capacities article's address ("replaces:" in its Website section).
     * "waiting": needs the owner's approval; "approved": happens on the next check; "done": moved.
     */
    replacement: { slug: string; title: string; state: "waiting" | "approved" | "done" } | null;
}

export interface CapacitiesArticleStatus {
    id: string;
    slug: string;
    title: string;
    publishedAt: string;
    redirects: string[];
    images: number;
    /** Null until "Check and archive" has looked for each image in R2. */
    missingImages: number | null;
    /** Whether capacities_archive holds a copy matching what's published. */
    archive: "none" | "current" | "outdated";
    archivedAt: string | null;
}

export interface CapacitiesStatus {
    syncEnabled: boolean;
    tokenConfigured: boolean;
    lastSync: { finishedAt: string | null; status: string } | null;
    articles: CapacitiesArticleStatus[];
    /** Archived Capacities articles whose address now serves an Amplenote note. */
    replaced: { id: string; slug: string; title: string; replacedBy: string; replacedAt: string | null }[];
    totals: { articles: number; images: number; missingImages: number | null; redirects: number };
    /** What must hold before the Capacities token is removed and the subscription cancelled. */
    checks: { id: string; label: string; ok: boolean; detail: string }[];
    safeToRetire: boolean;
    checkedAt: string | null;
}

export interface AmplenoteRunStatus {
    id: number;
    trigger: string;
    finishedAt: string | null;
    status: string;
    published: number;
    updated: number;
    unpublished: number;
    errors: number;
    log: string[];
}

export interface AmplenoteStatus {
    tag: string;
    /** Where the plugin sends its reports. */
    ingestUrl: string;
    /** The address to register as the OAuth redirect URI with Amplenote. */
    redirectUri: string;
    configured: {
        /** AMPLENOTE_PUBLISH_TOKEN, shared with the plugin. */
        plugin: boolean;
        /** AMPLENOTE_CLIENT_ID and AMPLENOTE_TOKEN_KEY. */
        api: boolean;
    };
    connection: { connectedBy: string; connectedAt: string; fullListedAt: string | null; lastError: string | null } | null;
    articles: AmplenoteArticleStatus[];
    runs: AmplenoteRunStatus[];
    capacities: CapacitiesStatus;
}
