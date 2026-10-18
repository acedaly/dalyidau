// Meeting and audio intelligence: a recording becomes a transcript, then suggested summary,
// decisions and action items for review.
//
// Formats. Workers AI Whisper takes the audio in one request, so long recordings are cut into
// pieces this code can cut correctly:
//   WAV  exactly, at sample boundaries, each piece given its own header (duration is exact);
//   MP3  at MPEG frame boundaries (frames are independent), duration estimated from the bitrate;
//   M4A, OGG, FLAC, WebM  sent whole, up to SINGLE_REQUEST_BYTES. Cutting them needs a demuxer
//        this Worker doesn't have, so larger files are refused with a clear reason (convert to MP3).
// Decoding is Workers AI's: which of these it accepts is its documented behaviour, not something
// the tests here can prove. Our tests cover the cutting, budgeting, resuming and analysis.
//
// What isn't claimed: speakers. Whisper doesn't separate speakers, so transcripts have timestamps
// and no names, and the analysis prompt forbids attributing words to anyone the transcript doesn't
// name. Each piece's text is saved as it completes, so an interrupted transcription resumes.
import type { R2Bucket } from "@cloudflare/workers-types";
import { estimateAudioNeurons } from "../../src/shared/intelligence/config";
import type { TranscriptSegment } from "../../src/shared/intelligence/types";
import { nowIso, parseJson } from "../portal/db";
import { type AttachmentRow, claimedKind, getAttachment, readAttachmentBytes, settleProcessing } from "./attachments";
import { analysisEstimate, analyseStep, markFailed, ownCapture } from "./capture";
import { type JobContext, PermanentFailure, type StepResult, willFail } from "./jobs";
import { transcribe } from "./provider";

/** The most audio sent in one transcription request. */
export const SINGLE_REQUEST_BYTES = 8 * 1024 * 1024;
const MP3_PIECE_BYTES = 4 * 1024 * 1024;
const WAV_PIECE_SECONDS = 240;

// --- WAV -----------------------------------------------------------------------------------------

export interface WavInfo {
    channels: number;
    sampleRate: number;
    byteRate: number;
    blockAlign: number;
    bitsPerSample: number;
    audioFormat: number;
    dataOffset: number;
    dataBytes: number;
}

export function parseWav(header: Uint8Array, fileBytes: number): WavInfo | null {
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const tag = (at: number) => String.fromCharCode(...header.subarray(at, at + 4));
    if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
    let p = 12;
    let fmt: Omit<WavInfo, "dataOffset" | "dataBytes"> | null = null;
    while (p + 8 <= header.length) {
        const id = tag(p);
        const size = view.getUint32(p + 4, true);
        if (id === "fmt " && p + 24 <= header.length) {
            fmt = {
                audioFormat: view.getUint16(p + 8, true),
                channels: view.getUint16(p + 10, true),
                sampleRate: view.getUint32(p + 12, true),
                byteRate: view.getUint32(p + 16, true),
                blockAlign: view.getUint16(p + 20, true),
                bitsPerSample: view.getUint16(p + 22, true),
            };
        } else if (id === "data") {
            if (!fmt || !fmt.byteRate || !fmt.blockAlign) return null;
            const dataOffset = p + 8;
            // Recorders that stream sometimes write 0 or 0xFFFFFFFF: then the data runs to the end of the file.
            const dataBytes = size && size !== 0xffffffff ? Math.min(size, fileBytes - dataOffset) : fileBytes - dataOffset;
            return { ...fmt, dataOffset, dataBytes };
        }
        p += 8 + size + (size % 2);
    }
    return null;
}

export function wavHeader(info: WavInfo, dataBytes: number): Uint8Array {
    const out = new Uint8Array(44);
    const view = new DataView(out.buffer);
    const write = (at: number, text: string) => [...text].forEach((c, i) => (out[at + i] = c.charCodeAt(0)));
    write(0, "RIFF");
    view.setUint32(4, 36 + dataBytes, true);
    write(8, "WAVE");
    write(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, info.audioFormat, true);
    view.setUint16(22, info.channels, true);
    view.setUint32(24, info.sampleRate, true);
    view.setUint32(28, info.byteRate, true);
    view.setUint16(32, info.blockAlign, true);
    view.setUint16(34, info.bitsPerSample, true);
    write(36, "data");
    view.setUint32(40, dataBytes, true);
    return out;
}

// --- MP3 -----------------------------------------------------------------------------------------

const MPEG1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

/** Kilobits per second of a valid MPEG layer III frame header at `at`, or null. */
export function mp3FrameBitrate(bytes: Uint8Array, at: number): number | null {
    if (at + 4 > bytes.length || bytes[at] !== 0xff || (bytes[at + 1] & 0xe0) !== 0xe0) return null;
    const version = (bytes[at + 1] >> 3) & 3;
    const layer = (bytes[at + 1] >> 1) & 3;
    const index = bytes[at + 2] >> 4;
    const rate = (bytes[at + 2] >> 2) & 3;
    if (version === 1 || layer !== 1 || index === 0 || index === 15 || rate === 3) return null;
    return (version === 3 ? MPEG1_L3 : MPEG2_L3)[index];
}

/** Where the audio starts after an ID3v2 tag. */
export const id3Length = (bytes: Uint8Array) =>
    bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33 ? 10 + (((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f)) : 0;

/** The first valid frame at or after `from`. */
export function nextFrame(bytes: Uint8Array, from: number): number {
    for (let i = Math.max(0, from); i <= bytes.length - 4; i++) if (mp3FrameBitrate(bytes, i)) return i;
    return -1;
}

// --- Planning ------------------------------------------------------------------------------------

interface Piece {
    /** Byte range to read (MP3 boundaries are refined to frames when read). */
    start: number;
    end: number;
    offsetSeconds: number;
    seconds: number;
}

interface Plan {
    format: string;
    wav?: WavInfo;
    audioStart?: number;
    bytesPerSecond?: number;
    pieces: Piece[];
    seconds: number;
    exactDuration: boolean;
}

export async function planTranscription(bucket: R2Bucket, attachment: AttachmentRow): Promise<Plan> {
    const kind = claimedKind(attachment.filename, "audio");
    if (!kind || kind.kind !== "audio") throw new PermanentFailure("unsupported_type");
    const head = await readAttachmentBytes(bucket, attachment, { offset: 0, length: Math.min(attachment.bytes, 256 * 1024) });
    if (kind.format === "wav") {
        const wav = parseWav(head, attachment.bytes);
        if (!wav || wav.audioFormat !== 1) throw new PermanentFailure("unsupported_wav");
        const pieceBytes = Math.max(wav.blockAlign, Math.floor(Math.min(SINGLE_REQUEST_BYTES - 44, wav.byteRate * WAV_PIECE_SECONDS) / wav.blockAlign) * wav.blockAlign);
        const pieces: Piece[] = [];
        for (let at = 0; at < wav.dataBytes; at += pieceBytes) {
            const length = Math.min(pieceBytes, wav.dataBytes - at);
            pieces.push({ start: wav.dataOffset + at, end: wav.dataOffset + at + length, offsetSeconds: at / wav.byteRate, seconds: length / wav.byteRate });
        }
        return { format: "wav", wav, pieces, seconds: wav.dataBytes / wav.byteRate, exactDuration: true };
    }
    if (kind.format === "mp3") {
        const audioStart = id3Length(head);
        const first = nextFrame(head, audioStart);
        const kbps = (first >= 0 ? mp3FrameBitrate(head, first) : null) ?? 128;
        const bytesPerSecond = (kbps * 1000) / 8;
        const pieces: Piece[] = [];
        for (let at = audioStart; at < attachment.bytes; at += MP3_PIECE_BYTES) {
            const end = Math.min(at + MP3_PIECE_BYTES, attachment.bytes);
            pieces.push({ start: at, end, offsetSeconds: (at - audioStart) / bytesPerSecond, seconds: (end - at) / bytesPerSecond });
        }
        return { format: "mp3", audioStart, bytesPerSecond, pieces, seconds: (attachment.bytes - audioStart) / bytesPerSecond, exactDuration: false };
    }
    if (attachment.bytes > SINGLE_REQUEST_BYTES) throw new PermanentFailure("convert_to_mp3");
    // Unknown duration: budget as if it were 128 kbps.
    const seconds = attachment.bytes / 16_000;
    return { format: kind.format, pieces: [{ start: 0, end: attachment.bytes, offsetSeconds: 0, seconds }], seconds, exactDuration: false };
}

/** The bytes to send for one piece. */
async function pieceAudio(bucket: R2Bucket, attachment: AttachmentRow, plan: Plan, index: number): Promise<Uint8Array> {
    const piece = plan.pieces[index];
    if (plan.format === "wav" && plan.wav) {
        const data = await readAttachmentBytes(bucket, attachment, { offset: piece.start, length: piece.end - piece.start });
        const out = new Uint8Array(44 + data.length);
        out.set(wavHeader(plan.wav, data.length));
        out.set(data, 44);
        return out;
    }
    if (plan.format === "mp3") {
        // Read a little past both ends and cut at the first frame at or after each nominal boundary,
        // so neighbouring pieces meet at the same frame.
        const slack = 8 * 1024;
        const readStart = piece.start;
        const length = Math.min(piece.end + slack, attachment.bytes) - readStart;
        const bytes = await readAttachmentBytes(bucket, attachment, { offset: readStart, length });
        const from = nextFrame(bytes, 0);
        const last = index === plan.pieces.length - 1;
        const to = last ? bytes.length : nextFrame(bytes, piece.end - readStart);
        if (from < 0) throw new PermanentFailure("unreadable_mp3");
        return bytes.subarray(from, to < 0 ? bytes.length : to);
    }
    return readAttachmentBytes(bucket, attachment, { offset: 0, length: attachment.bytes });
}

type Progress = { plan?: Plan; approved?: boolean; step?: string };

/** The meeting.transcribe job: plan, transcribe each piece, assemble, then analyse. */
export async function meetingJob(ctx: JobContext): Promise<StepResult> {
    const { env, config, user, job } = ctx;
    const capture = await ownCapture(env, user.email, job.subject_id).catch(() => null);
    if (!capture || capture.status === "cancelled") return { status: "done" };
    try {
        // Transcribed already: the remaining steps are the analysis.
        if (capture.text !== null) return await analyseStep(ctx, capture);
        const attachment = capture.attachment_id ? await getAttachment(env.DB, capture.attachment_id) : null;
        if (!attachment || attachment.owner_email !== user.email || attachment.status === "deleted") throw new PermanentFailure("file_missing");
        const progress = parseJson<Progress>(job.progress, {});

        let plan = progress.plan;
        if (!plan) {
            plan = await planTranscription(env.MEDIA, attachment);
            if (plan.seconds > config.limits.maxAudioMinutes * 60) throw new PermanentFailure("too_long");
            const estimate = Math.ceil(estimateAudioNeurons(config.models.transcribe, plan.seconds) + analysisEstimate(config, plan.seconds * 20));
            await env.DB.prepare(
                `INSERT INTO ai_transcripts (capture_id, model, duration_seconds, chunks_total, chunks_done, created_at) VALUES (?, ?, ?, ?, 0, ?)
                 ON CONFLICT(capture_id) DO UPDATE SET model = excluded.model, duration_seconds = excluded.duration_seconds, chunks_total = excluded.chunks_total`,
            )
                .bind(capture.id, config.models.transcribe, plan.exactDuration ? plan.seconds : null, plan.pieces.length, nowIso())
                .run();
            await env.DB.prepare("UPDATE ai_captures SET status = 'transcribing', updated_at = ? WHERE id = ?").bind(nowIso(), capture.id).run();
            if (estimate > config.budgets.confirmAboveNeurons && !progress.approved)
                return { status: "approval", estimateNeurons: estimate, progress: { plan, step: "awaiting_confirmation", done: 0, total: plan.pieces.length } };
            return { status: "more", progress: { plan, approved: progress.approved ?? false, step: "transcribing", done: 0, total: plan.pieces.length } };
        }

        const done = await env.DB.prepare("SELECT idx FROM ai_transcript_parts WHERE capture_id = ?").bind(capture.id).all<{ idx: number }>();
        const finished = new Set(done.results.map((r) => r.idx));
        const next = plan.pieces.findIndex((_, i) => !finished.has(i));
        if (next >= 0) {
            const audio = await pieceAudio(env.MEDIA, attachment, plan, next);
            const piece = plan.pieces[next];
            const result = await transcribe(
                { env, config, email: user.email, spaceId: capture.space_id, feature: "meetings", jobId: job.id },
                audio,
                { seconds: piece.seconds, language: capture.language },
            );
            const segments: TranscriptSegment[] = result.segments.map((s) => ({ start: s.start + piece.offsetSeconds, end: s.end + piece.offsetSeconds, text: s.text }));
            await env.DB.batch([
                env.DB.prepare("INSERT OR REPLACE INTO ai_transcript_parts (capture_id, idx, offset_seconds, text, segments) VALUES (?, ?, ?, ?, ?)").bind(
                    capture.id,
                    next,
                    piece.offsetSeconds,
                    result.text,
                    JSON.stringify(segments.slice(0, 2_000)),
                ),
                env.DB.prepare("UPDATE ai_transcripts SET chunks_done = (SELECT COUNT(*) FROM ai_transcript_parts WHERE capture_id = ?1), language = COALESCE(language, ?2) WHERE capture_id = ?1").bind(
                    capture.id,
                    result.language,
                ),
            ]);
            return { status: "more", progress: { ...progress, plan, step: "transcribing", done: finished.size + 1, total: plan.pieces.length } };
        }

        // Every piece is in: assemble the transcript as the capture's source text.
        const parts = await env.DB.prepare("SELECT text FROM ai_transcript_parts WHERE capture_id = ? ORDER BY idx").bind(capture.id).all<{ text: string }>();
        const text = parts.results.map((p) => p.text.trim()).filter(Boolean).join("\n\n");
        if (!text) throw new PermanentFailure("no_speech");
        const transcript = await env.DB.prepare("SELECT language FROM ai_transcripts WHERE capture_id = ?").bind(capture.id).first<{ language: string | null }>();
        await env.DB.batch([
            env.DB.prepare("UPDATE ai_transcripts SET completed_at = ? WHERE capture_id = ?").bind(nowIso(), capture.id),
            env.DB.prepare("UPDATE ai_captures SET text = ?, language = COALESCE(language, ?), status = 'analysing', updated_at = ? WHERE id = ?").bind(
                text.slice(0, 400_000),
                transcript?.language ?? null,
                nowIso(),
                capture.id,
            ),
        ]);
        await settleProcessing(env.DB, config, attachment.id, true);
        // Analysis starts with its own progress.
        return { status: "more", progress: { step: "analysing" } };
    } catch (error) {
        if (willFail(job, error)) {
            await markFailed(env, capture.id, error);
            if (capture.attachment_id && capture.text === null) await settleProcessing(env.DB, config, capture.attachment_id, false);
        }
        throw error;
    }
}
