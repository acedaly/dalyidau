// The Source Registry: every public dataset investigated, whether it's used and why, its licence
// and attribution, and for the implemented ones their status, freshness and errors. Owners and
// admins switch sources on and off and refresh them; nobody sees a key or a URL that carries one.
import { useState } from "react";
import { AlertTriangle, LinkExternal01, RefreshCw01 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Toggle } from "@/components/base/toggle/toggle";
import { Card } from "@/portal/components/card";
import { Notice } from "@/portal/components/notice";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import { formatNumber } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { sourceGapMessage } from "@/shared/centre/gaps";
import type { SourceReliability } from "@/shared/centre/history";
import { CATEGORY_LABELS } from "@/shared/centre/sources";
import type { SourceHealth } from "@/shared/centre/types";
import { centreApi } from "../centre-api";
import { CentreHeader, CentreNotices, SourceStatusBadge, When } from "../shared";

const ELIGIBILITY: Record<string, string> = {
    eligible: "Public, documented, terms checked",
    awaiting_verification: "Works; confirm the terms fit your use",
    needs_registration: "Needs a free key",
    restricted: "Needs the provider's permission",
    unsupported: "No permitted interface",
};

/** Small daily bars (records collected, or availability), drawn from the daily rollups; the values are in the title and the text beside it. */
const Bars = ({ values, label, max }: { values: (number | null)[]; label: string; max?: number }) => {
    const top = max ?? Math.max(1, ...values.map((v) => v ?? 0));
    return (
        <span className="inline-flex h-6 items-end gap-px align-middle" role="img" aria-label={label}>
            {values.map((v, i) => (
                <span
                    key={i}
                    className={v === null ? "w-1 bg-quaternary" : "w-1 bg-fg-brand-secondary"}
                    style={{ height: `${v === null ? 8 : Math.max(6, (v / top) * 100)}%` }}
                />
            ))}
        </span>
    );
};

const minutes = (m: number) => (m < 120 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`);

const Reliability = ({ r }: { r: SourceReliability }) => (
    <div className="flex flex-col gap-2 rounded-lg bg-secondary p-3">
        <p className="text-xs font-semibold text-secondary">Reliability, last 30 days</p>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2 xl:grid-cols-3">
            <div>
                <dt className="inline text-tertiary">Availability: </dt>
                <dd className="inline text-secondary">{r.availability === null ? "–" : `${r.availability}% of attempts succeeded`}</dd>
            </div>
            <div>
                <dt className="inline text-tertiary">Average retrieval: </dt>
                <dd className="inline text-secondary">{r.avgMs === null ? "–" : `${formatNumber(r.avgMs)} ms`}</dd>
            </div>
            <div>
                <dt className="inline text-tertiary">Publication to collection: </dt>
                <dd className="inline text-secondary">
                    {r.avgDelayS === null ? "provider gives no time" : `${minutes(Math.round(r.avgDelayS / 60))} on average`}
                    {r.maxDelayS ? `, at most ${minutes(Math.round(r.maxDelayS / 60))}` : ""}
                </dd>
            </div>
            <div>
                <dt className="inline text-tertiary">Consecutive failures: </dt>
                <dd className="inline text-secondary">{r.consecutiveFailures}</dd>
            </div>
            <div>
                <dt className="inline text-tertiary">Longest gap: </dt>
                <dd className="inline text-secondary">{r.longestGapMinutes ? minutes(r.longestGapMinutes) : "–"}</dd>
            </div>
            <div>
                <dt className="inline text-tertiary">Last validated: </dt>
                <dd className="inline text-secondary">
                    <When iso={r.lastValidatedAt} />
                </dd>
            </div>
        </dl>
        {r.days.length > 1 && (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-tertiary">
                <span className="flex items-center gap-2">
                    Records per day{" "}
                    <Bars
                        values={r.days.map((d) => d.recordsMax)}
                        label={`Records collected per day: ${r.days.map((d) => `${d.date} ${d.recordsMax}`).join(", ")}`}
                    />
                </span>
                <span className="flex items-center gap-2">
                    Availability per day{" "}
                    <Bars
                        values={r.days.map((d) => d.availability)}
                        max={100}
                        label={`Availability per day: ${r.days.map((d) => `${d.date} ${d.availability ?? "none"}%`).join(", ")}`}
                    />
                </span>
            </div>
        )}
    </div>
);

const SourceCard = ({
    health,
    canManage,
    onChange,
    reliability,
}: {
    health: SourceHealth;
    canManage: boolean;
    onChange: (sources: SourceHealth[]) => void;
    reliability?: SourceReliability;
}) => {
    const toast = useToast();
    const [busy, setBusy] = useState<"toggle" | "refresh" | null>(null);
    const s = health.source;
    const toggle = async (on: boolean) => {
        setBusy("toggle");
        try {
            onChange((await centreApi.setSource(s.id, on)).sources);
        } catch (e) {
            toast.error("Couldn't change it", errorMessage(e));
        } finally {
            setBusy(null);
        }
    };
    const refresh = async () => {
        setBusy("refresh");
        try {
            const { result, sources } = await centreApi.refreshSource(s.id);
            onChange(sources);
            if (result.outcome === "error") toast.error("The source couldn't be read", result.message ?? "");
            else toast.success(result.outcome === "unchanged" ? "No changes since last time" : `Retrieved ${formatNumber(result.records)} records`);
        } catch (e) {
            toast.error("Couldn't refresh", errorMessage(e));
        } finally {
            setBusy(null);
        }
    };
    return (
        <li className="flex flex-col gap-3 px-4 py-4 sm:px-5">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-semibold text-primary">{s.provider}</h3>
                        <SourceStatusBadge status={health.status} />
                        {health.fixture && (
                            <Badge size="sm" type="color" color="warning">
                                Fixture data
                            </Badge>
                        )}
                    </div>
                    <p className="text-sm text-secondary">{s.dataset}</p>
                    <p className="text-xs text-tertiary">{health.statusDetail}</p>
                    {s.implemented && sourceGapMessage(health) && (
                        <p className="flex items-start gap-1.5 text-xs font-medium text-secondary">
                            <AlertTriangle aria-hidden="true" className="mt-px size-3.5 shrink-0 text-fg-warning-primary" />
                            {sourceGapMessage(health)}
                        </p>
                    )}
                </div>
                {s.implemented && canManage && (
                    <div className="flex shrink-0 items-center gap-3">
                        {health.enabled && (
                            <Button
                                size="sm"
                                color="secondary"
                                iconLeading={RefreshCw01}
                                onClick={() => void refresh()}
                                isLoading={busy === "refresh"}
                                showTextWhileLoading
                            >
                                Refresh now
                            </Button>
                        )}
                        <Toggle
                            label={health.enabled ? "On" : "Off"}
                            isSelected={health.enabled}
                            isDisabled={busy !== null || s.eligibility === "restricted" || s.eligibility === "unsupported"}
                            onChange={(on) => void toggle(on)}
                            aria-label={`Collect ${s.provider}: ${s.dataset}`}
                        />
                    </div>
                )}
            </div>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2 xl:grid-cols-3">
                <div>
                    <dt className="inline text-tertiary">Hazards: </dt>
                    <dd className="inline text-secondary">{s.categories.map((c) => CATEGORY_LABELS[c]).join(", ")}</dd>
                </div>
                <div>
                    <dt className="inline text-tertiary">Coverage: </dt>
                    <dd className="inline text-secondary">{s.coverage}</dd>
                </div>
                <div>
                    <dt className="inline text-tertiary">Format: </dt>
                    <dd className="inline text-secondary">{s.format}</dd>
                </div>
                <div>
                    <dt className="inline text-tertiary">Access: </dt>
                    <dd className="inline text-secondary">
                        {s.authentication === "none"
                            ? "Anonymous"
                            : s.authentication === "free_api_key"
                              ? `Free key (${health.credentialsPresent ? "added" : `not added: ${s.secretName}`})`
                              : "By permission"}
                    </dd>
                </div>
                <div>
                    <dt className="inline text-tertiary">Licence: </dt>
                    <dd className="inline text-secondary">{s.licence}</dd>
                </div>
                <div>
                    <dt className="inline text-tertiary">Eligibility: </dt>
                    <dd className="inline text-secondary">{ELIGIBILITY[s.eligibility]}</dd>
                </div>
                <div>
                    <dt className="inline text-tertiary">Refresh: </dt>
                    <dd className="inline text-secondary">
                        Every {s.refreshMinutes} minutes; stale after {Math.round(s.staleAfterMinutes / 60)} h
                    </dd>
                </div>
                <div>
                    <dt className="inline text-tertiary">Live-tested: </dt>
                    <dd className="inline text-secondary">{s.liveTested ?? "Not yet"}</dd>
                </div>
                <div className="sm:col-span-2 xl:col-span-3">
                    <dt className="inline text-tertiary">Endpoint: </dt>
                    <dd className="inline font-mono break-all text-secondary">{s.endpointLabel}</dd>
                </div>
                {s.implemented && (
                    <>
                        <div>
                            <dt className="inline text-tertiary">Last attempt: </dt>
                            <dd className="inline text-secondary">
                                <When iso={health.lastAttemptAt} />
                            </dd>
                        </div>
                        <div>
                            <dt className="inline text-tertiary">Last success: </dt>
                            <dd className="inline text-secondary">
                                <When iso={health.lastSuccessAt} />
                            </dd>
                        </div>
                        <div>
                            <dt className="inline text-tertiary">Newest publication seen: </dt>
                            <dd className="inline text-secondary">
                                <When iso={health.lastPublishedAt} />
                            </dd>
                        </div>
                        <div>
                            <dt className="inline text-tertiary">Current records: </dt>
                            <dd className="inline text-secondary">{formatNumber(health.recordCount)}</dd>
                        </div>
                        <div>
                            <dt className="inline text-tertiary">Next refresh: </dt>
                            <dd className="inline text-secondary">{health.nextDueAt ? <When iso={health.nextDueAt} /> : "–"}</dd>
                        </div>
                        {health.errorMessage && (
                            <div className="sm:col-span-2 xl:col-span-3">
                                <dt className="inline text-tertiary">Last error: </dt>
                                <dd className="inline text-error-primary">{health.errorMessage}</dd>
                            </div>
                        )}
                    </>
                )}
            </dl>
            {reliability && <Reliability r={reliability} />}
            <p className="text-xs text-tertiary">{s.notes}</p>
            {s.attribution && <p className="text-xs text-quaternary">Attribution: {s.attribution}</p>}
            <Button
                size="sm"
                color="link-gray"
                iconTrailing={LinkExternal01}
                href={s.documentationUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="self-start"
            >
                Provider documentation
            </Button>
        </li>
    );
};

export const CentreSourcesPage = ({ data }: { data: PageData<"centre-sources"> }) => {
    const [sources, setSources] = useState(data.sources);
    const implemented = sources.filter((s) => s.source.implemented);
    const other = sources.filter((s) => !s.source.implemented);
    return (
        <>
            <CentreHeader
                title="Sources"
                crumb="Sources"
                shell={data}
                description="Every public source investigated: what's connected, what needs a key or permission, and what can't be used. A source is Active only after a real retrieval was validated."
            />
            <CentreNotices shell={data} sources={sources} />
            {implemented.some((s) => sourceGapMessage(s)) && (
                <Notice title="Information gaps" color="warning">
                    <ul className="flex list-disc flex-col gap-1 pl-4">
                        {implemented
                            .map((s) => sourceGapMessage(s))
                            .filter((m): m is string => !!m)
                            .map((m) => (
                                <li key={m}>{m}</li>
                            ))}
                    </ul>
                </Notice>
            )}
            <Card title={`Connected and available (${implemented.length})`}>
                <ul className="divide-y divide-secondary">
                    {implemented.map((s) => (
                        <SourceCard
                            key={s.source.id}
                            health={s}
                            canManage={data.canManage}
                            onChange={setSources}
                            reliability={data.reliability.find((r) => r.sourceId === s.source.id)}
                        />
                    ))}
                </ul>
            </Card>
            <Card title={`Investigated, not used (${other.length})`}>
                <ul className="divide-y divide-secondary">
                    {other.map((s) => (
                        <SourceCard key={s.source.id} health={s} canManage={false} onChange={setSources} />
                    ))}
                </ul>
            </Card>
        </>
    );
};
