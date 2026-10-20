// One record's essentials and the things you can do with it: open the official source, make a
// follow-up task (optionally in a project, with a date as a reminder) or save it to Knowledge.
// Used by the map's detail panel and the record page.
import { useState } from "react";
import { BookOpen01, CheckDone01, LinkExternal01 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { PortalDialog } from "@/portal/components/dialog";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import { usePortal } from "@/portal/portal-context";
import { sourceById } from "@/shared/centre/sources";
import type { CentreRecord } from "@/shared/centre/types";
import { RECORD_KIND_LABELS } from "@/shared/centre/types";
import { centreApi } from "./centre-api";
import { KnowledgeSaveDialog } from "./history-ui";
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

export const RecordActions = ({ record }: { record: CentreRecord }) => {
    const { can } = usePortal();
    const toast = useToast();
    const [dialog, setDialog] = useState(false);
    const [title, setTitle] = useState(`Follow up: ${record.title}`.slice(0, 200));
    const [dueDate, setDueDate] = useState("");
    const [busy, setBusy] = useState<"task" | null>(null);
    const task = async () => {
        setBusy("task");
        try {
            const r = await centreApi.createTask(record.id, { title, dueDate: dueDate || null, clientId: `centre-${record.id}-${Date.now().toString(36)}` });
            toast.success("Task created", "It's in your Tasks Inbox, with a link back here.");
            setDialog(false);
            window.location.href = r.url;
        } catch (e) {
            toast.error("Couldn't create the task", errorMessage(e));
        } finally {
            setBusy(null);
        }
    };
    const [saving, setSaving] = useState(false);
    return (
        <div className="flex flex-wrap gap-2">
            {record.sourceUrl && (
                <Button size="sm" color="secondary" iconLeading={LinkExternal01} href={record.sourceUrl} target="_blank" rel="noopener noreferrer">
                    Official source
                </Button>
            )}
            {can("tasks.use") && (
                <Button size="sm" color="secondary" iconLeading={CheckDone01} onClick={() => setDialog(true)}>
                    Create task
                </Button>
            )}
            {can("knowledge.use") && (
                <Button size="sm" color="secondary" iconLeading={BookOpen01} onClick={() => setSaving(true)}>
                    Save to Knowledge
                </Button>
            )}
            <KnowledgeSaveDialog
                isOpen={saving}
                onOpenChange={setSaving}
                title="Save to Knowledge"
                description="A note with the record as published, its source and times. Saving again returns the same note."
                save={(target) => centreApi.saveToKnowledge(record.id, target)}
            />
            <PortalDialog
                isOpen={dialog}
                onOpenChange={setDialog}
                title="Create a follow-up task"
                description="The task links back to this record and includes its source and times. It goes to your Tasks Inbox."
                icon={CheckDone01}
                onSubmit={(e) => {
                    e.preventDefault();
                    void task();
                }}
                footer={
                    <>
                        <Button size="md" color="secondary" onClick={() => setDialog(false)}>
                            Cancel
                        </Button>
                        <Button size="md" type="submit" isLoading={busy === "task"} showTextWhileLoading>
                            Create task
                        </Button>
                    </>
                }
            >
                <div className="flex flex-col gap-4">
                    <Input label="Title" value={title} onChange={setTitle} isRequired maxLength={200} />
                    <Input
                        label="Remind me on (optional)"
                        type="date"
                        value={dueDate}
                        onChange={setDueDate}
                        hint="Sets the task's due date, so it appears on that day in Tasks and Today."
                    />
                </div>
            </PortalDialog>
        </div>
    );
};

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
