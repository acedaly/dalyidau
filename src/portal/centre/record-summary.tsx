// One record's essentials and the official source to open. Used by the map's detail panel and the record page.
import { LinkExternal01 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { sourceById } from "@/shared/centre/sources";
import type { CentreRecord } from "@/shared/centre/types";
import { RECORD_KIND_LABELS } from "@/shared/centre/types";
import { Attribution, GeometryNote, LevelBadge, RecordNature, When } from "./shared";

export const RecordFacts = ({ record }: { record: CentreRecord }) => (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-tertiary">Type</dt>
        <dd className="text-secondary">
            {RECORD_KIND_LABELS[record.kind]}
            {record.eventType ? `: ${record.eventType}` : ""}
        </dd>
        {record.status && (
            <>
                <dt className="text-tertiary">Status (as published)</dt>
                <dd className="text-secondary">{record.status}</dd>
            </>
        )}
        {record.areaName && (
            <>
                <dt className="text-tertiary">Location (as published)</dt>
                <dd className="text-secondary">{record.areaName}</dd>
            </>
        )}
        {record.metrics.map((m) => (
            <div key={m.key} className="contents">
                <dt className="text-tertiary">{m.label}</dt>
                <dd className="text-secondary tabular-nums">
                    {m.value}
                    {m.unit ? ` ${m.unit}` : ""}
                </dd>
            </div>
        ))}
        <dt className="text-tertiary">Published</dt>
        <dd className="text-secondary">
            <When iso={record.publishedAt} />
        </dd>
        <dt className="text-tertiary">Last official update</dt>
        <dd className="text-secondary">
            <When iso={record.updatedAt} />
        </dd>
        {record.observedAt && (
            <>
                <dt className="text-tertiary">Observed</dt>
                <dd className="text-secondary">
                    <When iso={record.observedAt} />
                </dd>
            </>
        )}
        <dt className="text-tertiary">First collected</dt>
        <dd className="text-secondary">
            <When iso={record.firstSeenAt} />
        </dd>
        <dt className="text-tertiary">Last seen in the feed</dt>
        <dd className="text-secondary">
            <When iso={record.lastSeenAt} />
        </dd>
        {record.missingSince && (
            <>
                <dt className="text-tertiary">No longer in the feed</dt>
                <dd className="text-warning-primary">
                    Since <When iso={record.missingSince} />. This doesn't mean it's resolved: check the official source.
                </dd>
            </>
        )}
    </dl>
);

export const RecordActions = ({ record }: { record: CentreRecord }) =>
    record.sourceUrl ? (
        <div className="flex flex-wrap gap-2">
            <Button size="sm" color="secondary" iconLeading={LinkExternal01} href={record.sourceUrl} target="_blank" rel="noopener noreferrer">
                Official source
            </Button>
        </div>
    ) : null;

export const RecordSummary = ({ record, compact = false }: { record: CentreRecord; compact?: boolean }) => {
    const source = sourceById(record.sourceId);
    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
                <RecordNature record={record} />
                <LevelBadge record={record} size="md" />
                {record.fixture && <span className="text-xs font-medium text-warning-primary">Recorded fixture, not live</span>}
            </div>
            {compact && <h2 className="text-lg font-semibold text-primary">{record.title}</h2>}
            <p className="text-sm text-tertiary">
                From {record.provider}
                {source ? `: ${source.dataset}` : ""}.
            </p>
            {record.description && !compact && <p className="text-sm whitespace-pre-line text-secondary">{record.description}</p>}
            <RecordFacts record={record} />
            <GeometryNote record={record} />
            <RecordActions record={record} />
            <Attribution sourceIds={[record.sourceId]} />
        </div>
    );
};
