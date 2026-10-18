// One capture: its processing status (updated while it runs), the source as captured, the generated
// summary kept apart from it, the transcript for recordings, and its suggestions to review.
import { useEffect, useState } from "react";
import { Download01, PauseCircle, RefreshCw01 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Notice } from "@/portal/components/notice";
import { PageHeader } from "@/portal/components/page-header";
import { useToast } from "@/portal/components/toast";
import { Card } from "@/portal/knowledge/pages/knowledge-home-page";
import { errorMessage } from "@/portal/lib/api";
import { formatNumber } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import type { CaptureDetail } from "@/shared/intelligence/types";
import { downloadUrl, intelligenceApi } from "../api";
import { CaptureStatusBadge, ERROR_TEXT, SuggestionCard } from "../shared";

const FINAL = new Set(["ready", "failed", "cancelled"]);
const SOURCE_LABEL = {
    text: "Pasted text",
    document: "Document",
    audio: "Recording",
    knowledge: "Knowledge note",
    mcp: "From an AI assistant",
    app: "From another application",
};

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export const IntelligenceCaptureDetailPage = ({ data }: { data: PageData<"intelligence-capture-detail"> }) => {
    const toast = useToast();
    const [capture, setCapture] = useState<CaptureDetail>(data.capture);
    const [busy, setBusy] = useState(false);
    const job = capture.job;
    const running = !FINAL.has(capture.status) && job?.status !== "waiting_approval" && job?.status !== "cancelled";

    // While it's processing: ask the server to work on it (bounded) and refresh.
    useEffect(() => {
        if (!running) return;
        let stopped = false;
        const tick = async () => {
            try {
                if (job && (job.status === "queued" || job.status === "running")) await intelligenceApi.runJob(job.id).catch(() => undefined);
                const next = (await intelligenceApi.getCapture(capture.id)).capture;
                if (!stopped) setCapture(next);
            } catch {
                // A dropped connection: try again on the next tick.
            }
        };
        const timer = setInterval(tick, 4000);
        return () => {
            stopped = true;
            clearInterval(timer);
        };
    }, [running, capture.id, job]);

    const act = async (action: "retry" | "approve" | "cancel") => {
        if (!job) return;
        setBusy(true);
        try {
            if (action === "retry") await intelligenceApi.retryJob(job.id);
            if (action === "approve") await intelligenceApi.approveJob(job.id);
            if (action === "cancel") await intelligenceApi.cancelCapture(capture.id);
            setCapture((await intelligenceApi.getCapture(capture.id)).capture);
        } catch (e) {
            toast.error("That didn't work", errorMessage(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <PageHeader
                title={capture.title}
                description={
                    <span className="flex flex-wrap items-center gap-2">
                        {SOURCE_LABEL[capture.source]} · <CaptureStatusBadge status={capture.status} job={job} />
                    </span>
                }
                breadcrumbs={[
                    { label: "Intelligence", href: "/portal/intelligence" },
                    {
                        label: capture.source === "audio" ? "Meetings" : "Capture",
                        href: capture.source === "audio" ? "/portal/intelligence/meetings" : "/portal/intelligence/capture",
                    },
                    { label: capture.title },
                ]}
                actions={
                    <>
                        {running && (
                            <Button size="sm" color="secondary" iconLeading={PauseCircle} isLoading={busy} onClick={() => act("cancel")}>
                                Cancel
                            </Button>
                        )}
                        {capture.attachment && capture.attachment.status !== "deleted" && (
                            <Button size="sm" color="secondary" iconLeading={Download01} href={downloadUrl(capture.attachment.id)}>
                                Original file
                            </Button>
                        )}
                    </>
                }
            />

            {job?.status === "waiting_approval" && (
                <Notice
                    title="Confirm the cost"
                    color="warning"
                    actions={
                        <>
                            <Button size="sm" isLoading={busy} onClick={() => act("approve")}>
                                Go ahead
                            </Button>
                            <Button size="sm" color="secondary" onClick={() => act("cancel")}>
                                Cancel
                            </Button>
                        </>
                    }
                >
                    This is estimated at about {formatNumber(Math.round(job.estimateNeurons ?? 0))} Neurons of AI usage, above your confirmation threshold.
                </Notice>
            )}
            {capture.status === "failed" && (
                <Notice
                    title="Processing failed"
                    color="error"
                    actions={
                        job && (
                            <Button size="sm" iconLeading={RefreshCw01} isLoading={busy} onClick={() => act("retry")}>
                                Try again
                            </Button>
                        )
                    }
                >
                    {ERROR_TEXT[capture.errorCode ?? job?.errorCode ?? ""] ?? "Something went wrong. Nothing was changed."}
                </Notice>
            )}
            {job?.errorCode === "budget_exceeded" && capture.status !== "failed" && (
                <Notice title="Waiting for the AI budget" color="warning">
                    {ERROR_TEXT.budget_exceeded}
                </Notice>
            )}
            {running && (
                <p className="text-sm text-tertiary" aria-live="polite">
                    Working on it{job?.progress?.total ? `: ${job.progress.done ?? 0} of ${job.progress.total}` : "…"} You can leave this page; it carries on.
                </p>
            )}

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                <Card title={`Suggestions${capture.pending ? ` (${capture.pending} to review)` : ""}`}>
                    {capture.suggestions.length ? (
                        <ul className="divide-y divide-secondary">
                            {capture.suggestions.map((s) => (
                                <SuggestionCard
                                    key={s.id}
                                    suggestion={s}
                                    showCapture={false}
                                    onChange={(next) =>
                                        setCapture((c) => ({ ...c, suggestions: c.suggestions.map((x) => (x.id === s.id && next ? next : x)) }))
                                    }
                                />
                            ))}
                        </ul>
                    ) : (
                        <p className="px-4 py-4 text-sm text-tertiary sm:px-5">
                            {FINAL.has(capture.status) ? "Nothing to suggest from this." : "Suggestions appear here when the analysis is done."}
                        </p>
                    )}
                </Card>
                <div className="flex min-w-0 flex-col gap-6">
                    {capture.summary && (
                        <Card
                            title="Summary"
                            action={
                                <Badge size="sm" type="pill-color" color="brand">
                                    Generated
                                </Badge>
                            }
                        >
                            <p className="px-4 py-4 text-sm whitespace-pre-line text-secondary sm:px-5">{capture.summary}</p>
                        </Card>
                    )}
                    {capture.transcript && capture.transcript.segments.length > 0 ? (
                        <Card
                            title="Transcript"
                            action={
                                <Badge size="sm" type="pill-color" color="gray">
                                    Speakers not identified
                                </Badge>
                            }
                        >
                            <ol className="max-h-[32rem] divide-y divide-secondary overflow-y-auto">
                                {capture.transcript.segments.map((s, i) => (
                                    <li key={i} className="flex gap-3 px-4 py-2 text-sm sm:px-5">
                                        <span className="w-12 shrink-0 text-xs text-tertiary tabular-nums">{clock(s.start)}</span>
                                        <span className="text-secondary">{s.text}</span>
                                    </li>
                                ))}
                            </ol>
                            <p className="border-t border-secondary px-4 py-2 text-xs text-tertiary sm:px-5">
                                {capture.transcript.model}
                                {capture.language ? ` · ${capture.language}` : ""}
                                {capture.transcript.durationSeconds ? ` · ${clock(capture.transcript.durationSeconds)}` : ""}
                            </p>
                        </Card>
                    ) : (
                        capture.text && (
                            <Card
                                title="Source"
                                action={
                                    <Badge size="sm" type="pill-color" color="gray">
                                        As captured
                                    </Badge>
                                }
                            >
                                <pre className="max-h-[32rem] overflow-auto px-4 py-4 font-body text-sm break-words whitespace-pre-wrap text-secondary sm:px-5">
                                    {capture.text}
                                </pre>
                                {capture.textTruncated && (
                                    <p className="border-t border-secondary px-4 py-2 text-xs text-tertiary sm:px-5">Shortened for display.</p>
                                )}
                            </Card>
                        )
                    )}
                    {capture.sourceObject && (
                        <Button color="link-color" href={`/portal/knowledge/o/${capture.sourceObject.id}`}>
                            Open “{capture.sourceObject.title}” in Knowledge
                        </Button>
                    )}
                </div>
            </div>
        </>
    );
};
