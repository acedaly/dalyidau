// Upload a document or a recording and send it to Intelligent Capture. Built on Untitled UI's file
// upload drop zone and progress rows; on a phone the drop zone opens the file picker (and, for
// recordings, Voice Memos files from Files).
import { useState } from "react";
import { FileListItemProgressBar, FileUploadDropZone } from "@/components/application/file-upload/file-upload-base";
import { Select } from "@/components/base/select/select";
import { useToast } from "@/portal/components/toast";
import { ApiError, errorMessage } from "@/portal/lib/api";
import { intelligenceApi, uploadFile } from "./api";
import { captureHref } from "./shared";

const ACCEPT = {
    document: ".pdf,.docx,.xlsx,.pptx,.txt,.md,.markdown,.csv",
    audio: ".mp3,.m4a,.wav,.ogg,.opus,.flac,.webm,.aac,.mp4",
};

export const UploadCapture = ({
    kind,
    maxBytes,
    spaces,
    isDisabled,
}: {
    kind: "document" | "audio";
    maxBytes: number;
    spaces: { id: string; name: string }[];
    isDisabled?: boolean;
}) => {
    const toast = useToast();
    const [file, setFile] = useState<{ name: string; size: number; progress: number; failed: boolean } | null>(null);
    const [spaceId, setSpaceId] = useState(spaces[0]?.id ?? "");
    const [language, setLanguage] = useState("");

    const start = async (picked: File) => {
        setFile({ name: picked.name, size: picked.size, progress: 0, failed: false });
        try {
            const attachmentId = await uploadFile(picked, kind, (progress) => setFile((f) => (f ? { ...f, progress } : f)));
            const result = await intelligenceApi.capture({
                source: kind,
                attachmentId,
                ...(spaceId ? { spaceId } : {}),
                ...(kind === "audio" && language ? { language } : {}),
                requestKey: `upload-${attachmentId}`,
            });
            window.location.href = captureHref(result.captureId);
        } catch (e) {
            setFile((f) => (f ? { ...f, failed: true } : f));
            toast.error("Upload failed", e instanceof ApiError ? e.message : errorMessage(e));
        }
    };

    return (
        <div className="flex flex-col gap-4">
            <FileUploadDropZone
                isDisabled={isDisabled || (!!file && !file.failed)}
                accept={ACCEPT[kind]}
                maxSize={maxBytes}
                hint={
                    kind === "document"
                        ? `PDF, Word, Excel, PowerPoint, text or Markdown, up to ${Math.floor(maxBytes / 1_000_000)} MB`
                        : `MP3 or WAV (long recordings are split), or M4A, OGG, FLAC, WebM up to 8 MB; at most ${Math.floor(maxBytes / 1_000_000)} MB`
                }
                onDropFiles={(files) => files[0] && void start(files[0])}
                onSizeLimitExceed={() => toast.error("That file is too large", `Files can be up to ${Math.floor(maxBytes / 1_000_000)} MB.`)}
                onDropUnacceptedFiles={() => toast.error("That kind of file isn't supported")}
            />
            <div className="grid gap-4 sm:grid-cols-2">
                {spaces.length > 1 && (
                    <Select
                        label="Knowledge space for suggestions"
                        size="sm"
                        value={spaceId}
                        onChange={(k) => k && setSpaceId(String(k))}
                        items={spaces.map((s) => ({ id: s.id, label: s.name }))}
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                )}
                {kind === "audio" && (
                    <Select
                        label="Language"
                        size="sm"
                        value={language || "auto"}
                        onChange={(k) => setLanguage(k === "auto" ? "" : String(k))}
                        items={[
                            { id: "auto", label: "Detect automatically" },
                            { id: "en", label: "English" },
                            { id: "es", label: "Spanish" },
                            { id: "fr", label: "French" },
                            { id: "de", label: "German" },
                            { id: "it", label: "Italian" },
                            { id: "zh", label: "Chinese" },
                        ]}
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                )}
            </div>
            {file && (
                <ul aria-live="polite">
                    <FileListItemProgressBar name={file.name} size={file.size} progress={file.progress} failed={file.failed} onRetry={() => setFile(null)} />
                </ul>
            )}
        </div>
    );
};
