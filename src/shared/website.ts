// What Portal settings → Website shows about Amplenote publishing (worker/amplenote/api.ts).
// Never holds credentials: only whether each one is configured.

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
}
