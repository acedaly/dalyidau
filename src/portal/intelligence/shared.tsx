// Shared pieces of the Intelligence pages: the availability notice, status badges, and the
// suggestion card used by the Inbox, the overview and each capture. A suggestion always shows what
// it would do, why, the quote it came from and where it goes, and nothing happens until the person
// presses Approve.
import { useEffect, useState } from "react";
import { Check, Edit05, FileSearch02, Link03, XClose } from "@untitledui/icons";
import { Badge, BadgeWithDot } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { TextArea } from "@/components/base/textarea/textarea";
import { PortalDialog } from "@/portal/components/dialog";
import { Notice } from "@/portal/components/notice";
import { useToast } from "@/portal/components/toast";
import { ApiError, api, errorMessage } from "@/portal/lib/api";
import { formatDate } from "@/portal/lib/format";
import type { CaptureStatus, IntelligenceShell, JobView, SuggestionView } from "@/shared/intelligence/types";
import { SUGGESTION_KIND_LABELS } from "@/shared/intelligence/types";
import { intelligenceApi } from "./api";

export const captureHref = (id: string) => `/portal/intelligence/captures/${id}`;

const STATUS: Record<CaptureStatus, { label: string; color: "gray" | "brand" | "success" | "error" | "warning" }> = {
    received: { label: "Queued", color: "gray" },
    extracting: { label: "Extracting text", color: "brand" },
    transcribing: { label: "Transcribing", color: "brand" },
    analysing: { label: "Analysing", color: "brand" },
    ready: { label: "Ready", color: "success" },
    failed: { label: "Failed", color: "error" },
    cancelled: { label: "Cancelled", color: "gray" },
};

export const CaptureStatusBadge = ({ status, job }: { status: CaptureStatus; job?: JobView | null }) => {
    const waiting = job?.status === "waiting_approval";
    const s = waiting ? { label: "Needs your OK", color: "warning" as const } : STATUS[status];
    return (
        <BadgeWithDot size="sm" type="pill-color" color={s.color}>
            {s.label}
            {job?.progress?.total && status !== "ready" ? ` ${job.progress.done ?? 0}/${job.progress.total}` : ""}
        </BadgeWithDot>
    );
};

export const ERROR_TEXT: Record<string, string> = {
    budget_exceeded: "Waiting for tomorrow's AI budget.",
    malformed_output: "The model's answer couldn't be used. Retry, or try with less text.",
    ai_unavailable: "Workers AI wasn't responding. It will retry.",
    timeout: "The model took too long. It will retry.",
    too_many_pages: "The document has more pages than the limit.",
    encrypted: "The PDF is password-protected.",
    unsafe_archive: "The Office file looked unsafe to unpack (possible decompression bomb).",
    convert_to_mp3: "This format can only be sent in one piece up to 8 MB. Convert the recording to MP3 and upload it again.",
    too_long: "The recording is longer than the limit.",
    no_text: "No text could be found.",
    no_speech: "No speech was recognised.",
    unsupported_wav: "Only uncompressed (PCM) WAV files can be read.",
    forbidden: "You no longer have access to this.",
    needs_project: "Approve the new project first, or choose an existing project.",
    duplicate: "A project with that name already exists.",
};

/** What's switched on, said plainly, so a page never looks broken when a feature is simply off. */
export const AvailabilityNotice = ({ shell, need }: { shell: IntelligenceShell; need: (keyof IntelligenceShell["status"]["available"])[] }) => {
    const { status } = shell;
    if (need.every((k) => status.available[k])) {
        if (status.circuitOpen)
            return (
                <Notice title="Workers AI isn't responding" color="warning">
                    New AI work is paused for a few minutes. Nothing you've saved is affected.
                </Notice>
            );
        return null;
    }
    const reason = !status.features.enabled
        ? "Intelligence is switched off for this portal."
        : !status.bindings.ai
          ? "Workers AI isn't connected to this portal yet."
          : need.includes("semantic") && !status.bindings.vectors
            ? "The Vectorize index isn't connected yet, so search uses keywords only."
            : "This feature is switched off.";
    return (
        <Notice
            title="Not available right now"
            color="gray"
            actions={
                shell.canManage ? (
                    <Button size="sm" color="link-color" href="/portal/intelligence/settings">
                        Intelligence settings
                    </Button>
                ) : undefined
            }
        >
            {reason} {shell.canManage ? "Owners and admins can change this in Intelligence settings." : "An owner or admin can switch it on."} Tasks and Knowledge work as usual.
        </Notice>
    );
};

// --- Suggestions -----------------------------------------------------------------------------------

const p = (s: SuggestionView) => s.payload as Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** One line saying what approving would do. */
export function describeSuggestion(s: SuggestionView): { title: string; detail: string[] } {
    const payload = p(s);
    const name = (id: unknown) => (typeof id === "string" ? (s.labels[id] ?? "a record you can't see") : null);
    switch (s.kind) {
        case "task":
        case "follow_up": {
            const where = payload.projectId ? `in ${name(payload.projectId)}` : payload.projectSuggestionId ? "in the proposed new project" : "in your Tasks Inbox";
            const detail = [where];
            if (payload.dueDate) detail.push(`due ${formatDate(str(payload.dueDate))}${payload.dateCertainty === "inferred" ? " (worked out: check it)" : ""}`);
            else if (payload.dueText) detail.push(`timing: “${str(payload.dueText)}”`);
            if (payload.waitingOn) detail.push(`waiting on ${str(payload.waitingOn)}`);
            if (payload.owner) detail.push(`owner named: ${str(payload.owner)}`);
            return { title: str(payload.title), detail };
        }
        case "project":
            return { title: str(payload.name), detail: [((payload.similarProjectIds as string[]) ?? []).length ? "similar projects exist: check before creating" : "a new personal project"] };
        case "knowledge_object":
        case "decision":
        case "meeting_note":
            return { title: str(payload.title), detail: [`in ${name(payload.spaceId) ?? "your space"}`] };
        case "tags":
            return { title: ((payload.tags as string[]) ?? []).map((t) => `#${t}`).join(" "), detail: [`on ${name(payload.objectId)}`] };
        case "link":
            return { title: `${name(payload.sourceObjectId)} → ${name(payload.targetObjectId)}`, detail: ["link the two notes"] };
        case "fact":
            return { title: str(payload.statement), detail: [payload.objectId ? `add to ${name(payload.objectId)}` : "keep as a note"] };
    }
}

const RESULT_LABEL: Record<string, string> = { task: "Open task", task_project: "Open project", knowledge_object: "Open note", knowledge_relation: "Open note", knowledge_tags: "Open note" };

export const SuggestionCard = ({
    suggestion,
    onChange,
    selected,
    onSelect,
    showCapture = true,
}: {
    suggestion: SuggestionView;
    onChange: (next: SuggestionView | null) => void;
    selected?: boolean;
    onSelect?: (selected: boolean) => void;
    showCapture?: boolean;
}) => {
    const toast = useToast();
    const [busy, setBusy] = useState<"approve" | "dismiss" | null>(null);
    const [editing, setEditing] = useState(false);
    const { title, detail } = describeSuggestion(suggestion);
    const pending = suggestion.status === "pending" || suggestion.status === "failed";

    const approve = async () => {
        setBusy("approve");
        try {
            const { suggestion: next } = await intelligenceApi.approve(suggestion.id, suggestion.version);
            toast.success("Approved", title);
            onChange(next);
        } catch (e) {
            toast.error("Couldn't approve", e instanceof ApiError ? (ERROR_TEXT[e.code] ?? e.message) : errorMessage(e));
            if (e instanceof ApiError && e.status === 409) onChange({ ...suggestion });
        } finally {
            setBusy(null);
        }
    };
    const dismiss = async () => {
        setBusy("dismiss");
        try {
            await intelligenceApi.dismiss(suggestion.id);
            onChange({ ...suggestion, status: "dismissed" });
        } catch (e) {
            toast.error("Couldn't dismiss", errorMessage(e));
        } finally {
            setBusy(null);
        }
    };

    return (
        <li className="flex gap-3 px-4 py-4 sm:px-5">
            {onSelect && pending && (
                <Checkbox aria-label={`Select ${title}`} isSelected={!!selected} onChange={onSelect} className="mt-1" />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                    <Badge size="sm" type="modern" color="gray">
                        {SUGGESTION_KIND_LABELS[suggestion.kind]}
                    </Badge>
                    {suggestion.status === "applied" && (
                        <BadgeWithDot size="sm" type="pill-color" color="success">
                            Applied
                        </BadgeWithDot>
                    )}
                    {suggestion.status === "dismissed" && (
                        <BadgeWithDot size="sm" type="pill-color" color="gray">
                            Dismissed
                        </BadgeWithDot>
                    )}
                    {suggestion.confidence !== null && suggestion.confidence < 0.5 && pending && (
                        <Badge size="sm" type="pill-color" color="warning">
                            Low confidence
                        </Badge>
                    )}
                </div>
                <p className="text-sm font-semibold break-words text-primary">{title || "Untitled"}</p>
                <p className="text-sm text-tertiary">{[...detail, suggestion.reason].filter(Boolean).join(" · ")}</p>
                {suggestion.evidence && (
                    <blockquote className="border-l-2 border-secondary pl-3 text-sm break-words text-tertiary italic">“{suggestion.evidence}”</blockquote>
                )}
                {suggestion.errorCode && pending && <p className="text-sm text-error-primary">{ERROR_TEXT[suggestion.errorCode] ?? "That didn't work last time."}</p>}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                    {pending && (
                        <>
                            <Button size="sm" iconLeading={Check} isLoading={busy === "approve"} isDisabled={!!busy} onClick={approve}>
                                Approve
                            </Button>
                            <Button size="sm" color="secondary" iconLeading={Edit05} isDisabled={!!busy} onClick={() => setEditing(true)}>
                                Edit
                            </Button>
                            <Button size="sm" color="tertiary" iconLeading={XClose} isLoading={busy === "dismiss"} isDisabled={!!busy} onClick={dismiss}>
                                Dismiss
                            </Button>
                        </>
                    )}
                    {suggestion.result && (
                        <Button size="sm" color="link-color" iconLeading={Link03} href={suggestion.result.url}>
                            {RESULT_LABEL[suggestion.result.type] ?? "Open"}
                        </Button>
                    )}
                    {showCapture && suggestion.capture && (
                        <Button size="sm" color="link-gray" iconLeading={FileSearch02} href={captureHref(suggestion.capture.id)}>
                            Source: {suggestion.capture.title}
                        </Button>
                    )}
                </div>
            </div>
            {editing && <EditSuggestion suggestion={suggestion} onClose={() => setEditing(false)} onSaved={(next) => (setEditing(false), onChange(next))} />}
        </li>
    );
};

type Field = { key: string; label: string; kind: "text" | "long" | "date" | "tags" | "priority" | "project" };

const FIELDS: Record<SuggestionView["kind"], Field[]> = {
    task: [
        { key: "title", label: "Task", kind: "text" },
        { key: "description", label: "Description", kind: "long" },
        { key: "dueDate", label: "Due date", kind: "date" },
        { key: "priority", label: "Priority", kind: "priority" },
        { key: "projectId", label: "Project", kind: "project" },
        { key: "labels", label: "Labels", kind: "tags" },
    ],
    follow_up: [
        { key: "title", label: "Follow-up", kind: "text" },
        { key: "waitingOn", label: "Waiting on", kind: "text" },
        { key: "dueDate", label: "Due date", kind: "date" },
        { key: "projectId", label: "Project", kind: "project" },
    ],
    project: [
        { key: "name", label: "Project name", kind: "text" },
        { key: "description", label: "Description", kind: "long" },
    ],
    knowledge_object: [
        { key: "title", label: "Title", kind: "text" },
        { key: "text", label: "Text", kind: "long" },
        { key: "tags", label: "Tags", kind: "tags" },
    ],
    decision: [
        { key: "title", label: "Decision", kind: "text" },
        { key: "text", label: "Details", kind: "long" },
        { key: "decidedOn", label: "Decided on", kind: "date" },
        { key: "tags", label: "Tags", kind: "tags" },
    ],
    meeting_note: [
        { key: "title", label: "Title", kind: "text" },
        { key: "summary", label: "Summary", kind: "long" },
        { key: "date", label: "Meeting date", kind: "date" },
        { key: "tags", label: "Tags", kind: "tags" },
    ],
    tags: [{ key: "tags", label: "Tags to add", kind: "tags" }],
    link: [],
    fact: [{ key: "statement", label: "Fact", kind: "long" }],
};

const EditSuggestion = ({ suggestion, onClose, onSaved }: { suggestion: SuggestionView; onClose: () => void; onSaved: (s: SuggestionView) => void }) => {
    const toast = useToast();
    const [values, setValues] = useState<Record<string, unknown>>({ ...p(suggestion) });
    const [projects, setProjects] = useState<{ id: string; label: string }[] | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ApiError | null>(null);
    const fields = FIELDS[suggestion.kind];
    const set = (key: string, value: unknown) => setValues((v) => ({ ...v, [key]: value }));

    const needsProjects = fields.some((f) => f.kind === "project");
    useEffect(() => {
        if (!needsProjects) return;
        void api<{ projects: { id: string; name: string; isInbox: boolean; status: string; role: string }[] }>("GET", "/api/portal/tasks/projects")
            .then((r) => setProjects(r.projects.filter((x) => !x.isInbox && x.status !== "archived" && x.role !== "viewer").map((x) => ({ id: x.id, label: x.name }))))
            .catch(() => setProjects([]));
    }, [needsProjects]);

    const save = async () => {
        setBusy(true);
        setError(null);
        try {
            const payload = { ...values };
            if (payload.projectId === "") payload.projectId = null;
            const { suggestion: next } = await intelligenceApi.edit(suggestion.id, suggestion.version, payload);
            toast.success("Suggestion updated");
            onSaved(next);
        } catch (e) {
            setError(e instanceof ApiError ? e : null);
            toast.error("Couldn't save", errorMessage(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <PortalDialog
            isOpen
            onOpenChange={(open) => !open && onClose()}
            title={`Edit ${SUGGESTION_KIND_LABELS[suggestion.kind].toLowerCase()}`}
            description="Change anything before approving. Nothing is saved to Tasks or Knowledge until you approve."
            icon={Edit05}
            onSubmit={save}
            footer={
                <>
                    <Button color="secondary" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button type="submit" isLoading={busy}>
                        Save changes
                    </Button>
                </>
            }
        >
            {fields.length === 0 && <p className="text-sm text-tertiary">There's nothing to change: approve or dismiss it.</p>}
            {fields.map((f) => {
                const issue = error?.issueFor(f.key);
                if (f.kind === "long")
                    return <TextArea key={f.key} label={f.label} rows={4} value={str(values[f.key])} onChange={(v) => set(f.key, v)} isInvalid={!!issue} hint={issue} />;
                if (f.kind === "date")
                    return (
                        <Input key={f.key} label={f.label} type="date" value={str(values[f.key])} onChange={(v) => set(f.key, v || null)} isInvalid={!!issue} hint={issue ?? "Leave empty for no date"} />
                    );
                if (f.kind === "tags")
                    return (
                        <Input
                            key={f.key}
                            label={f.label}
                            value={((values[f.key] as string[]) ?? []).join(", ")}
                            onChange={(v) => set(f.key, v.split(",").map((t) => t.trim()).filter(Boolean))}
                            hint={issue ?? "Separate with commas"}
                            isInvalid={!!issue}
                        />
                    );
                if (f.kind === "priority")
                    return (
                        <Select
                            key={f.key}
                            label={f.label}
                            value={String(values[f.key] ?? 4)}
                            onChange={(k) => set(f.key, Number(k))}
                            items={[1, 2, 3, 4].map((n) => ({ id: String(n), label: `P${n}${n === 4 ? " (normal)" : n === 1 ? " (urgent)" : ""}` }))}
                        >
                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                        </Select>
                    );
                if (f.kind === "project")
                    return (
                        <Select
                            key={f.key}
                            label={f.label}
                            value={str(values[f.key]) || "inbox"}
                            onChange={(k) => set(f.key, k === "inbox" ? null : String(k))}
                            items={[{ id: "inbox", label: values.projectSuggestionId ? "The proposed new project" : "Tasks Inbox" }, ...(projects ?? [])]}
                        >
                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                        </Select>
                    );
                return <Input key={f.key} label={f.label} value={str(values[f.key])} onChange={(v) => set(f.key, v)} isInvalid={!!issue} hint={issue} />;
            })}
        </PortalDialog>
    );
};
