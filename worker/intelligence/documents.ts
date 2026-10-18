// Document intelligence: text out of an uploaded PDF, Office or text file, then the same analysis
// as any capture.
//
// Safeguards, in order, before anything reads the content: the declared size and the file's own
// bytes were checked at upload (attachments.ts); PDFs that are encrypted or have more pages than the
// limit are refused; Office files have their ZIP directory read first and decompression bombs are
// refused; text files are decoded as UTF-8 and nothing else. Conversion is Workers AI Markdown
// Conversion with a timeout. Extracted text is the capture's *source*, stored apart from anything
// generated, and like every source it reaches a model only inside the untrusted-content fence.
// Nothing in a document is ever executed, rendered as HTML or followed (links, macros, scripts).
import { nowIso } from "../portal/db";
import { claimedKind, getAttachment, pdfFacts, readAttachmentBytes, settleProcessing, zipBombReason } from "./attachments";
import { type CaptureRow, analyseStep, markFailed, ownCapture } from "./capture";
import { type JobContext, PermanentFailure, type StepResult, willFail } from "./jobs";
import { documentToText } from "./provider";

export async function extractText(ctx: JobContext, capture: CaptureRow): Promise<string> {
    const { env, config } = ctx;
    const attachment = capture.attachment_id ? await getAttachment(env.DB, capture.attachment_id) : null;
    if (!attachment || attachment.owner_email !== ctx.user.email || attachment.status === "deleted") throw new PermanentFailure("file_missing");
    if (attachment.bytes > config.limits.maxDocumentBytes) throw new PermanentFailure("too_large");
    const kind = claimedKind(attachment.filename, "document");
    if (!kind || kind.kind !== "document") throw new PermanentFailure("unsupported_type");
    const bytes = await readAttachmentBytes(env.MEDIA, attachment);
    if (bytes.length !== attachment.bytes) throw new PermanentFailure("file_changed");

    if (kind.format === "text" || kind.format === "markdown" || kind.format === "csv") return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    if (kind.format === "pdf") {
        const facts = pdfFacts(bytes);
        if (facts.encrypted) throw new PermanentFailure("encrypted");
        if (facts.pages > config.limits.maxDocumentPages) throw new PermanentFailure("too_many_pages");
    } else {
        const bomb = zipBombReason(bytes);
        if (bomb) throw new PermanentFailure("unsafe_archive");
    }
    return documentToText(
        { env, config, email: ctx.user.email, spaceId: capture.space_id, feature: "documents", jobId: ctx.job.id },
        { name: attachment.filename, bytes, type: attachment.content_type },
    );
}

/** The document.extract job: extract (one step), then analyse (one or more steps). */
export async function documentJob(ctx: JobContext): Promise<StepResult> {
    const { env, config } = ctx;
    const capture = await ownCapture(env, ctx.user.email, ctx.job.subject_id).catch(() => null);
    if (!capture || capture.status === "cancelled") return { status: "done" };
    try {
        if (capture.text === null) {
            await env.DB.prepare("UPDATE ai_captures SET status = 'extracting', updated_at = ? WHERE id = ?").bind(nowIso(), capture.id).run();
            const raw = await extractText(ctx, capture);
            const text = raw
                .replace(/\u0000/g, "")
                .replace(/\r\n?/g, "\n")
                .replace(/\n{3,}/g, "\n\n")
                .trim();
            if (!text) throw new PermanentFailure("no_text");
            const cut =
                text.length > config.limits.maxCaptureCharacters
                    ? `${text.slice(0, config.limits.maxCaptureCharacters)}\n\n[Text cut at the capture limit]`
                    : text;
            await env.DB.prepare("UPDATE ai_captures SET text = ?, status = 'analysing', updated_at = ? WHERE id = ?").bind(cut, nowIso(), capture.id).run();
            if (capture.attachment_id) await settleProcessing(env.DB, config, capture.attachment_id, true);
            return { status: "more", progress: { step: "extracted" } };
        }
        return await analyseStep(ctx, capture);
    } catch (error) {
        if (willFail(ctx.job, error)) {
            await markFailed(env, capture.id, error);
            if (capture.attachment_id && capture.text === null) await settleProcessing(env.DB, config, capture.attachment_id, false);
        }
        throw error;
    }
}
