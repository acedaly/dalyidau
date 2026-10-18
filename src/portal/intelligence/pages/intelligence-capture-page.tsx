// Intelligent Capture: paste text, upload a document or a recording, or analyse a Knowledge note.
// Captured things are analysed in the background and become suggestions to review.
import { useState } from "react";
import { BookOpen01, File06, Lightning01, Microphone01 } from "@untitledui/icons";
import { Tabs } from "@/components/application/tabs/tabs";
import { Button } from "@/components/base/buttons/button";
import { Select } from "@/components/base/select/select";
import { TextArea } from "@/components/base/textarea/textarea";
import { PageHeader } from "@/portal/components/page-header";
import { Timestamp } from "@/portal/components/timestamp";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import { Card } from "@/portal/knowledge/pages/knowledge-home-page";
import { intelligenceApi } from "../api";
import { AvailabilityNotice, CaptureStatusBadge, captureHref } from "../shared";
import { UploadCapture } from "../upload-capture";

export const IntelligenceCapturePage = ({ data }: { data: PageData<"intelligence-capture"> }) => {
    const toast = useToast();
    const [text, setText] = useState("");
    const [busy, setBusy] = useState(false);
    const [spaceId, setSpaceId] = useState(data.spaces[0]?.id ?? "");
    const [tab, setTab] = useState(data.prefillObject ? "knowledge" : "text");
    const disabled = !data.status.available.capture;

    const submit = async (body: Record<string, unknown>) => {
        setBusy(true);
        try {
            const result = await intelligenceApi.capture({ ...body, ...(spaceId ? { spaceId } : {}), requestKey: crypto.randomUUID() });
            if (result.needsApproval) toast.success("Captured", "It's large, so it waits for you to confirm the cost.");
            window.location.href = captureHref(result.captureId);
        } catch (e) {
            toast.error("Couldn't capture that", errorMessage(e));
            setBusy(false);
        }
    };

    return (
        <>
            <PageHeader
                title="Capture"
                description="Hand over notes, documents or recordings. You'll get suggested tasks, decisions and notes to review: nothing is saved without you."
                breadcrumbs={[{ label: "Intelligence", href: "/portal/intelligence" }, { label: "Capture" }]}
            />
            <AvailabilityNotice shell={data} need={["capture"]} />
            <Tabs selectedKey={tab} onSelectionChange={(k) => setTab(String(k))}>
                <Tabs.List type="button-minimal" size="sm" className="overflow-x-auto">
                    <Tabs.Item id="text" icon={Lightning01}>
                        Text
                    </Tabs.Item>
                    <Tabs.Item id="document" icon={File06}>
                        Document
                    </Tabs.Item>
                    <Tabs.Item id="audio" icon={Microphone01}>
                        Recording
                    </Tabs.Item>
                    {data.prefillObject && (
                        <Tabs.Item id="knowledge" icon={BookOpen01}>
                            Knowledge note
                        </Tabs.Item>
                    )}
                </Tabs.List>
                <Tabs.Panel id="text" className="pt-6">
                    <form
                        className="flex flex-col gap-4 rounded-xl bg-primary p-4 shadow-xs ring-1 ring-secondary ring-inset sm:p-5"
                        onSubmit={(e) => {
                            e.preventDefault();
                            if (text.trim()) void submit({ source: "text", text });
                        }}
                    >
                        <TextArea
                            label="What to capture"
                            placeholder={"Paste meeting notes, an email or a brain dump.\nTODO lines, decisions and dates are picked up."}
                            rows={8}
                            value={text}
                            onChange={setText}
                            hint={`${text.length.toLocaleString("en-AU")} of ${data.limits.maxCaptureCharacters.toLocaleString("en-AU")} characters`}
                            isDisabled={disabled}
                        />
                        <div className="flex flex-wrap items-end gap-3">
                            {data.spaces.length > 1 && (
                                <Select label="Knowledge space" size="sm" className="w-full sm:w-56" value={spaceId} onChange={(k) => k && setSpaceId(String(k))} items={data.spaces.map((s) => ({ id: s.id, label: s.name }))}>
                                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                                </Select>
                            )}
                            <Button type="submit" iconLeading={Lightning01} isLoading={busy} isDisabled={disabled || !text.trim() || text.length > data.limits.maxCaptureCharacters} className="sm:ml-auto">
                                Capture and analyse
                            </Button>
                        </div>
                    </form>
                </Tabs.Panel>
                <Tabs.Panel id="document" className="pt-6">
                    <AvailabilityNotice shell={data} need={["documents"]} />
                    <UploadCapture kind="document" maxBytes={data.limits.maxDocumentBytes} spaces={data.spaces} isDisabled={!data.status.available.documents} />
                </Tabs.Panel>
                <Tabs.Panel id="audio" className="pt-6">
                    <AvailabilityNotice shell={data} need={["meetings"]} />
                    <UploadCapture kind="audio" maxBytes={data.limits.maxAudioBytes} spaces={data.spaces} isDisabled={!data.status.available.meetings} />
                </Tabs.Panel>
                {data.prefillObject && (
                    <Tabs.Panel id="knowledge" className="pt-6">
                        <div className="flex flex-col gap-3 rounded-xl bg-primary p-4 shadow-xs ring-1 ring-secondary ring-inset sm:flex-row sm:items-center sm:justify-between sm:p-5">
                            <p className="text-sm text-secondary">
                                Analyse <strong>{data.prefillObject.title}</strong> for tasks, decisions, tags and links.
                            </p>
                            <Button iconLeading={Lightning01} isLoading={busy} isDisabled={disabled} onClick={() => submit({ source: "knowledge", objectId: data.prefillObject!.id })}>
                                Analyse note
                            </Button>
                        </div>
                    </Tabs.Panel>
                )}
            </Tabs>

            <Card title="Recent captures">
                {data.captures.length ? (
                    <ul className="divide-y divide-secondary">
                        {data.captures.map((c) => (
                            <li key={c.id}>
                                <a href={captureHref(c.id)} className="flex flex-col gap-1 px-4 py-3 transition duration-100 ease-linear hover:bg-primary_hover sm:flex-row sm:items-center sm:justify-between sm:px-5">
                                    <span className="truncate text-sm font-medium text-primary">{c.title}</span>
                                    <span className="flex items-center gap-2 text-xs text-tertiary">
                                        <CaptureStatusBadge status={c.status} job={c.job} />
                                        <Timestamp iso={c.createdAt} relative />
                                    </span>
                                </a>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="px-4 py-4 text-sm text-tertiary sm:px-5">Nothing captured yet.</p>
                )}
            </Card>
        </>
    );
};
