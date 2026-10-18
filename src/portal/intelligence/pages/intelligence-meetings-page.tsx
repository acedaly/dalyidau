// Meeting intelligence: upload a recording, follow its transcription, and open each meeting's
// transcript and proposed summary, decisions and actions.
import { Microphone01 } from "@untitledui/icons";
import { Empty } from "@/portal/components/empty";
import { Notice } from "@/portal/components/notice";
import { PageHeader } from "@/portal/components/page-header";
import { Timestamp } from "@/portal/components/timestamp";
import { Card } from "@/portal/knowledge/pages/knowledge-home-page";
import type { PageData } from "@/portal/lib/page-types";
import { AvailabilityNotice, CaptureStatusBadge, captureHref } from "../shared";
import { UploadCapture } from "../upload-capture";

export const IntelligenceMeetingsPage = ({ data }: { data: PageData<"intelligence-meetings"> }) => (
    <>
        <PageHeader
            title="Meetings"
            description="Upload a recording to get a transcript and proposed summary, decisions and action items. Recordings are deleted automatically after processing."
            breadcrumbs={[{ label: "Intelligence", href: "/portal/intelligence" }, { label: "Meetings" }]}
        />
        <AvailabilityNotice shell={data} need={["meetings"]} />
        <Card title="New recording" icon={Microphone01}>
            <div className="p-4 sm:p-5">
                <UploadCapture kind="audio" maxBytes={data.limits.maxAudioBytes} spaces={data.spaces} isDisabled={!data.status.available.meetings} />
            </div>
        </Card>
        <Notice title="About transcripts" color="gray">
            Transcripts come from Workers AI Whisper. They have timestamps but don't identify who spoke, and can contain recognition errors: check names,
            numbers and dates before approving anything. Recordings up to {data.limits.maxAudioMinutes} minutes.
        </Notice>
        <Card title="Recordings">
            {data.captures.length ? (
                <ul className="divide-y divide-secondary">
                    {data.captures.map((c) => (
                        <li key={c.id}>
                            <a
                                href={captureHref(c.id)}
                                className="flex flex-col gap-1 px-4 py-3 transition duration-100 ease-linear hover:bg-primary_hover sm:flex-row sm:items-center sm:justify-between sm:px-5"
                            >
                                <span className="truncate text-sm font-medium text-primary">{c.title}</span>
                                <span className="flex items-center gap-2 text-xs text-tertiary">
                                    <CaptureStatusBadge status={c.status} job={c.job} />
                                    {c.pending > 0 && `${c.pending} to review`}
                                    <Timestamp iso={c.createdAt} relative />
                                </span>
                            </a>
                        </li>
                    ))}
                </ul>
            ) : (
                <div className="px-6 py-10">
                    <Empty
                        icon={Microphone01}
                        size="sm"
                        title="No recordings yet"
                        description="MP3 and WAV recordings of any length up to the limit; other formats up to 8 MB."
                    />
                </div>
            )}
        </Card>
    </>
);
