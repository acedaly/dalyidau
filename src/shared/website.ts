// What Portal settings → Website & Blog shows: the blog's Capacities articles and their archive
// (worker/capacities/archive.ts). Never holds credentials: only whether the token is configured.

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
    /** Archived Capacities articles whose address was handed to an Amplenote note (before Amplenote was retired). */
    replaced: { id: string; slug: string; title: string; replacedBy: string; replacedAt: string | null }[];
    totals: { articles: number; images: number; missingImages: number | null; redirects: number };
    /** What must hold before the Capacities token is removed and the subscription cancelled. */
    checks: { id: string; label: string; ok: boolean; detail: string }[];
    safeToRetire: boolean;
    checkedAt: string | null;
}
