// Portal settings → Website & Blog: the retired Capacities integration. Shows what's archived in
// Cloudflare, checks every image in R2 ("Check and archive"), and says when it's safe to remove the
// Capacities token and cancel (docs/CAPACITIES_RETIREMENT.md). The sync switch itself lives in
// Portal settings → Features; this card only shows it.
import { useState } from "react";
import { Archive } from "@untitledui/icons";
import { Badge, BadgeWithDot } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Notice } from "@/portal/components/notice";
import { Timestamp } from "@/portal/components/timestamp";
import { useToast } from "@/portal/components/toast";
import { api, errorMessage } from "@/portal/lib/api";
import { SettingsCard, StatusRow } from "@/portal/settings/settings-card";
import { SwitchSummary } from "@/portal/settings/switch-summary";
import type { AmplenoteStatus, CapacitiesStatus } from "@/shared/website";

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const ARCHIVE = {
    current: { label: "Archived", color: "success" },
    outdated: { label: "Archive out of date", color: "warning" },
    none: { label: "Not archived", color: "gray" },
} as const;

export const CapacitiesCard = ({ status, onStatus }: { status: CapacitiesStatus; onStatus: (status: AmplenoteStatus) => void }) => {
    const toast = useToast();
    const [busy, setBusy] = useState(false);
    const [checked, setChecked] = useState<CapacitiesStatus | null>(null);
    // The page loads without checking R2; after "Check and archive" the checked result is shown.
    const view = checked ?? status;

    const archive = async () => {
        setBusy(true);
        try {
            const result = await api<{ capacities: CapacitiesStatus; status: AmplenoteStatus }>("POST", "/api/portal/website/capacities/archive", {});
            setChecked(result.capacities);
            onStatus(result.status);
            const missing = result.capacities.totals.missingImages ?? 0;
            if (missing) toast.error("Archived, but images are missing", `${missing} image(s) aren't in R2. Don't cancel Capacities yet.`);
            else
                toast.success(
                    "Archived",
                    `${count(result.capacities.totals.articles, "article")} and ${count(result.capacities.totals.images, "image")} checked`,
                );
        } catch (error) {
            toast.error("That didn't work", errorMessage(error));
        } finally {
            setBusy(false);
        }
    };

    return (
        <SettingsCard
            id="website-capacities"
            icon={Archive}
            title="Capacities archive"
            description="Articles first published from Capacities. They're served entirely from Cloudflare (D1 and R2), so they stay online whether or not Capacities is connected."
            actions={
                <Button size="sm" color="secondary" isLoading={busy} onClick={archive}>
                    Check and archive
                </Button>
            }
        >
            <SwitchSummary area="website" />

            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                    ["Articles", view.totals.articles],
                    ["Images", view.totals.images],
                    ["Missing images", view.totals.missingImages ?? "Not checked"],
                    ["Old addresses", view.totals.redirects],
                ].map(([label, value]) => (
                    <div key={label} className="rounded-lg bg-secondary px-3 py-2">
                        <dt className="text-xs text-tertiary">{label}</dt>
                        <dd className="text-lg font-semibold text-primary">{value}</dd>
                    </div>
                ))}
            </dl>

            <div className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-primary">Before removing the Capacities token and cancelling</h3>
                <dl className="flex flex-col divide-y divide-secondary" aria-label="Retirement checks">
                    {view.checks.map((check) => (
                        <StatusRow key={check.id} label={check.label} detail={check.detail} value={check.ok ? "Done" : "Not yet"} ok={check.ok} />
                    ))}
                </dl>
                {view.safeToRetire ? (
                    <Notice title="Safe to retire Capacities" color="success">
                        Take a backup (npm run db:backup, and npm run capacities:inventory -- --download for the images), then delete the CAPACITIES_API_TOKEN
                        secret and cancel the subscription. Nothing on the site changes.
                    </Notice>
                ) : (
                    <p className="text-sm text-tertiary">
                        Keep the Capacities token until every check passes.{" "}
                        {view.checkedAt ? (
                            <>
                                Checked <Timestamp iso={view.checkedAt} relative />.
                            </>
                        ) : (
                            "Images are checked with Check and archive."
                        )}
                    </p>
                )}
                <p className="text-xs text-quaternary">
                    Token {view.tokenConfigured ? "still set on the Worker" : "removed"}.{" "}
                    {view.lastSync?.finishedAt && (
                        <>
                            Last Capacities sync <Timestamp iso={view.lastSync.finishedAt} relative /> ({view.lastSync.status}).
                        </>
                    )}
                </p>
            </div>

            {view.articles.length > 0 && (
                <details className="rounded-lg ring-1 ring-secondary ring-inset">
                    <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-primary">
                        {view.articles.length} Capacities article{view.articles.length === 1 ? "" : "s"}
                    </summary>
                    <ul className="flex flex-col divide-y divide-secondary border-t border-secondary" aria-label="Capacities articles">
                        {view.articles.map((article) => (
                            <li key={article.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                                <div className="min-w-0">
                                    <a href={`/blog/${article.slug}`} className="text-sm font-medium break-words text-primary underline underline-offset-2">
                                        {article.title}
                                    </a>
                                    <p className="text-xs text-tertiary">
                                        /blog/{article.slug} · {article.images} image{article.images === 1 ? "" : "s"}
                                        {article.missingImages ? `, ${article.missingImages} missing` : ""}
                                        {article.redirects.length > 0 && ` · also at ${article.redirects.map((r) => `/blog/${r}`).join(", ")}`}
                                    </p>
                                </div>
                                <BadgeWithDot size="sm" type="pill-color" color={ARCHIVE[article.archive].color} className="shrink-0">
                                    {ARCHIVE[article.archive].label}
                                </BadgeWithDot>
                            </li>
                        ))}
                    </ul>
                </details>
            )}

            {view.replaced.length > 0 && (
                <div className="flex flex-col gap-2">
                    <h3 className="text-sm font-semibold text-primary">Moved to Amplenote</h3>
                    <ul className="flex flex-col gap-1 text-sm text-tertiary" aria-label="Moved to Amplenote">
                        {view.replaced.map((r) => (
                            <li key={r.id} className="flex flex-wrap items-center gap-2">
                                <a href={`/blog/${r.slug}`} className="text-primary underline underline-offset-2">
                                    {r.title}
                                </a>
                                <Badge size="sm" color="brand">
                                    Same address
                                </Badge>
                                <span>The Capacities copy is kept in the archive and can be restored from the article below.</span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </SettingsCard>
    );
};
